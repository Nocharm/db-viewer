"""AI background jobs — suggest judging, embedding indexing. / AI 잡 실행기 (사이클2 §5)."""

import json
import logging
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.adapters.ai import AiClient, CandidatePair
from app.api.objects import resolve_snapshot
from app.config import Settings
from app.models import AiJob, CatalogObject, Relation
from app.services.ai_embeddings import run_embed_index
from app.services.catalog_queries import load_pair_sets, load_scoring_columns

logger = logging.getLogger(__name__)


def run_suggest(db: Session, ai: AiClient, settings: Settings,
                snapshot_id: int | None) -> dict:
    """기존 동기 suggest 로직 — api/ai.py에서 이동, 반환은 기존 응답 dict 그대로."""
    # select_ai_candidates/key_as_dict는 api/ai.py에 남아 단위 테스트 대상이라 여기서는
    # 지연 임포트로 참조한다 — api.ai가 has_active_job/run_ai_job을 모듈 최상단에서
    # 임포트하므로, 이 모듈이 최상단에서 api.ai를 되임포트하면 순환 임포트가 된다.
    from app.api.ai import key_as_dict, select_ai_candidates

    snapshot = resolve_snapshot(db, snapshot_id)
    columns = load_scoring_columns(db, snapshot.id)
    view_pairs, fk_pairs = load_pair_sets(db, snapshot.id)

    # 기존 관계와 중복 제거(양방향) — 상한 적용 전에 걸러야 재실행마다 다음 순위
    # 후보가 올라온다(순서가 반대면 매번 같은 상위 40건만 뽑혀 걸러진다)
    existing: set[tuple] = set()
    for r in db.execute(select(Relation)).scalars():
        existing.add((r.src_object, r.src_column, r.tgt_object, r.tgt_column))
        existing.add((r.tgt_object, r.tgt_column, r.src_object, r.src_column))

    ranked = select_ai_candidates(
        columns, view_pairs, fk_pairs,
        settings.low_cardinality_min_distinct,
        {b.upper() for b in settings.low_cardinality_blacklist},
        settings.ai_suggest_max_pairs,
        existing,
    )

    row_counts = {
        f"{o.schema}.{o.name}": o.row_count
        for o in db.execute(
            select(CatalogObject).where(CatalogObject.snapshot_id == snapshot.id)
        ).scalars()
    }
    pairs_meta = []
    for src, cand in ranked:
        tgt = cand.target
        pairs_meta.append(CandidatePair(
            src_object=src.object_qname, src_column=src.name,
            src_type=src.data_type, src_is_pk=src.is_pk,
            src_row_count=row_counts.get(src.object_qname),
            tgt_object=tgt.object_qname, tgt_column=tgt.name,
            tgt_type=tgt.data_type, tgt_is_pk=tgt.is_pk,
            tgt_row_count=row_counts.get(tgt.object_qname),
            score=cand.score, signals=sorted(cand.signals),
        ))

    judgements = ai.judge_relations(pairs_meta)

    now = datetime.now(UTC)
    created = []
    rejected_count = 0
    for j in judgements:
        db.add(Relation(
            src_object=j.src_object, src_column=j.src_column,
            tgt_object=j.tgt_object, tgt_column=j.tgt_column,
            status="candidate" if j.accepted else "rejected",
            origin="ai", reason=j.reason, created_at=now,
        ))
        if j.accepted:
            created.append({**key_as_dict((j.src_object, j.src_column,
                                           j.tgt_object, j.tgt_column)),
                            "reason": j.reason})
        else:
            rejected_count += 1
    # 판정 응답이 후보 전량보다 적으면 LLM이 일부 페어를 누락한 것 — 페이징 정체 관측용
    unjudged = len(pairs_meta) - (len(created) + rejected_count)
    return {"snapshot_id": snapshot.id, "suggested": len(pairs_meta),
            "created": len(created), "rejected": rejected_count,
            "unjudged": unjudged, "items": created[:100]}


def run_ai_job(session_factory: sessionmaker, job_id: int,
               ai: AiClient, settings: Settings) -> None:
    """백그라운드 진입점 — 잡 상태 전이·에러 기록. / job lifecycle wrapper."""
    with session_factory() as db:
        job = db.get(AiJob, job_id)
        if job is None or job.status != "queued":
            return
        job.status = "running"
        job.started_at = datetime.now(UTC)
        db.commit()
        try:
            if job.kind == "suggest":
                result = run_suggest(db, ai, settings, snapshot_id=None)
                # LLM 1콜 구조라 총 페어 수 기준 세밀 진행은 어렵다 — 완료 여부만 반영
                job.progress_done = 1
            elif job.kind == "embed_index":
                # ai 클라이언트 불필요 — embed_texts를 모듈 함수로 직접 호출한다
                result = run_embed_index(db, job, settings)
            else:
                raise ValueError(f"unknown kind: {job.kind}")
            job.result = json.dumps(result, ensure_ascii=False)
            job.status = "done"
        except Exception as e:  # 잡 실패는 502 규약 대상 아님 — error 컬럼 기록
            logger.exception("ai job failed", extra={"job_id": job_id, "kind": job.kind})
            db.rollback()
            job = db.get(AiJob, job_id)
            job.status = "failed"
            detail = str(e)
            context = getattr(e, "context", None)
            if context:
                detail = f"{detail} — {context}"
            job.error = detail
        job.finished_at = datetime.now(UTC)
        db.commit()


def has_active_job(db: Session, kind: str) -> bool:
    """kind별 동시 실행 1개 가드 / one active job per kind."""
    return db.execute(
        select(AiJob.id).where(AiJob.kind == kind,
                               AiJob.status.in_(["queued", "running"]))
    ).first() is not None
