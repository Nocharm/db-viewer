"""Embedding index builder — capped, batched, throttled. / 임베딩 인덱싱 (사이클2 §3).

부하 제약(사용자 지시): 잡 1회 상한 EMBED_JOB_CAP(2000 초과 금지),
호출당 EMBED_BATCH, 호출 간 EMBED_SLEEP_MS 대기. 남은 분량은
재실행이 이어간다 — 제안 페이징과 같은 문법.
"""

import hashlib
import json
import time
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.adapters.llm_ai import embed_texts
from app.config import Settings
from app.models import AiEmbedding, AiJob, AiSummary, CatalogColumn, CatalogObject, Snapshot


def build_embedding_text(qname: str, column_names: list[str],
                         summary: str | None) -> str:
    parts = [qname, " ".join(column_names)]
    if summary:
        parts.append(summary)
    return "\n".join(parts)


def compute_source_hash(text: str, model: str) -> str:
    return hashlib.sha256(f"{model}\n{text}".encode()).hexdigest()


def run_embed_index(db: Session, job: AiJob, settings: Settings) -> dict:
    snapshot = db.execute(
        select(Snapshot).where(Snapshot.status == "ready")
        .order_by(Snapshot.id.desc()).limit(1)
    ).scalar_one_or_none()
    if snapshot is None:
        raise RuntimeError("no ready snapshot to index")

    columns_by_obj: dict[int, list[str]] = {}
    for object_id, name in db.execute(
        select(CatalogColumn.object_id, CatalogColumn.name)
        .join(CatalogObject, CatalogColumn.object_id == CatalogObject.id)
        .where(CatalogObject.snapshot_id == snapshot.id)
        .order_by(CatalogColumn.object_id, CatalogColumn.ordinal)
    ):
        columns_by_obj.setdefault(object_id, []).append(name)
    summaries = {s.object_qname: s.summary
                 for s in db.execute(select(AiSummary)).scalars()}
    existing = {e.object_qname: e
                for e in db.execute(select(AiEmbedding)).scalars()}

    pending: list[tuple[str, str, str]] = []  # (qname, text, hash)
    skipped = 0
    for obj in db.execute(
        select(CatalogObject)
        .where(CatalogObject.snapshot_id == snapshot.id,
               CatalogObject.type == "table")
        .order_by(CatalogObject.schema, CatalogObject.name)
    ).scalars():
        qname = f"{obj.schema}.{obj.name}"
        text = build_embedding_text(qname, columns_by_obj.get(obj.id, []),
                                    summaries.get(qname))
        source_hash = compute_source_hash(text, settings.embed_model)
        row = existing.get(qname)
        if row is not None and row.source_hash == source_hash:
            skipped += 1
            continue
        pending.append((qname, text, source_hash))

    total_pending = len(pending)
    batch_input = pending[:settings.embed_job_cap]
    job.progress_total = len(batch_input)
    db.commit()

    indexed = 0
    batch = settings.embed_batch
    for start in range(0, len(batch_input), batch):
        chunk = batch_input[start:start + batch]
        # 사내 임베딩 서버는 무인증 — 채팅 토큰을 다른 호스트로 보내지 않는다
        vectors = embed_texts(settings.embed_url, settings.embed_model,
                              "", settings.embed_timeout_seconds,
                              [text for _, text, _ in chunk])
        now = datetime.now(UTC)
        for (qname, _, source_hash), vector in zip(chunk, vectors):
            row = existing.get(qname)
            if row is None:
                db.add(AiEmbedding(object_qname=qname,
                                   model=settings.embed_model,
                                   vector=json.dumps(vector),
                                   source_hash=source_hash, updated_at=now))
            else:
                row.model = settings.embed_model
                row.vector = json.dumps(vector)
                row.source_hash = source_hash
                row.updated_at = now
        indexed += len(chunk)
        job.progress_done = indexed
        db.commit()  # 부분 진행 보존 — 실패해도 인덱싱분 유지
        if start + batch < len(batch_input) and settings.embed_sleep_ms > 0:
            time.sleep(settings.embed_sleep_ms / 1000)

    return {"indexed": indexed, "skipped": skipped,
            "remaining": total_pending - indexed}
