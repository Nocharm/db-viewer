"""Collection runners — fixture replay offline, n8n webhook when connected. / 수집 러너 어댑터."""

import json
import math
import time
import urllib.request
from pathlib import Path
from typing import Protocol

from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from app.schemas.ingest import CatalogPayload, ViewDepsPayload

# n8n webhook 응답 대기 상한(초) — 트리거만 하고 실제 진행은 ingest 콜백이 갱신
# webhook trigger timeout; actual progress arrives via the ingest callback
WEBHOOK_TIMEOUT = 30
# 청크 콜백 폴링 간격(초) / chunk callback poll interval
CHUNK_POLL_INTERVAL = 2.0


class CollectRunner(Protocol):
    """단계 실행 계약 — 완료 표시는 ingest 콜백(update_collect_job)이 담당."""

    def run_catalog(self, job_id: int) -> None: ...

    def run_view_deps(self, job_id: int, snapshot_id: int) -> None: ...


class FixtureCollectRunner:
    """픽스처 페이로드를 ingest와 같은 코드 경로로 적재 — 오프라인 버튼 검증용.
    Replays fixture payloads through the real ingest path for offline testing."""

    def __init__(self, session_factory: sessionmaker, fixture_dir: str) -> None:
        self._session_factory = session_factory
        self._fixture_dir = Path(fixture_dir)

    def _load(self, name: str) -> dict:
        path = self._fixture_dir / name
        # 픽스처는 gitignore 대상이라 배포 이미지에 없다 — 원인·조치를 잡 오류로 남긴다
        # fixtures are gitignored, so a container has none; say what to do instead of ENOENT
        if not path.exists():
            raise RuntimeError(
                f"fixture {path} not found (cwd {Path.cwd()}) — real collection needs "
                "N8N_WEBHOOK_BASE; for offline replay generate fixtures first "
                f"(python tools/fixture_gen.py --out {self._fixture_dir})"
            )
        return json.loads(path.read_text())

    def run_catalog(self, job_id: int) -> None:
        # 순환 import 회피 — ingest는 이 어댑터의 팩토리를 모른다 / avoid circular import
        from app.api.ingest import ingest_catalog

        payload = CatalogPayload.model_validate(
            {**self._load("catalog.json"), "collect_job_id": job_id}
        )
        with self._session_factory() as db:
            ingest_catalog(payload, db)
            db.commit()

    def run_view_deps(self, job_id: int, snapshot_id: int) -> None:
        from app.api.ingest import ingest_view_deps

        payload = ViewDepsPayload.model_validate({
            **self._load("view_deps.json"),
            "snapshot_id": snapshot_id, "collect_job_id": job_id,
        })
        with self._session_factory() as db:
            ingest_view_deps(payload, db)
            db.commit()


class N8nWebhookRunner:
    """n8n webhook 트리거 — n8n이 수집 후 ingest로 되쏘면 잡 단계가 갱신된다.
    Fires the n8n webhooks; n8n collects and POSTs back to ingest.

    뷰 의존은 소스 DB 점유를 줄이기 위해 뷰 N개 단위로 나눠 호출하고,
    각 청크의 ingest 콜백을 확인한 뒤 다음 청크를 쏜다 (규모 2,342 테이블 대응).
    View-deps collection is paged so each call touches only a slice of views.
    """

    def __init__(
        self, webhook_base: str, session_factory: sessionmaker,
        catalog_chunk_size: int = 300, deps_chunk_size: int = 100,
        chunk_timeout: int = 600,
    ) -> None:
        self._base = webhook_base.rstrip("/")
        self._session_factory = session_factory
        self._catalog_chunk_size = catalog_chunk_size
        self._deps_chunk_size = deps_chunk_size
        self._chunk_timeout = chunk_timeout

    def _post(self, path: str, body: dict) -> None:
        req = urllib.request.Request(
            f"{self._base}/{path}",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        # 응답 본문은 쓰지 않는다 — 트리거 성공 여부만 / response body unused, trigger-only
        with urllib.request.urlopen(req, timeout=WEBHOOK_TIMEOUT):
            pass

    def run_catalog(self, job_id: int) -> None:
        # 카탈로그 조회는 단일 스캔이 소스 DB에 가장 가볍다 — 분할은 전송(n8n 청크 POST)이 담당
        # a single catalog scan is the lightest on the source DB; n8n chunks the transport
        self._post("dbv-collect-catalog", {
            "collect_job_id": job_id,
            "catalog_chunk_size": self._catalog_chunk_size,
        })

    def _count_views(self, snapshot_id: int) -> int:
        from app.models import CatalogObject

        with self._session_factory() as db:
            return db.execute(
                select(func.count()).select_from(CatalogObject)
                .where(CatalogObject.snapshot_id == snapshot_id,
                       CatalogObject.type == "view")
            ).scalar_one()

    def _wait_for_chunk(self, job_id: int, expected_done: int) -> None:
        """청크 하나의 ingest 콜백 대기 — 실패·시간 초과는 오류로 올린다."""
        from app.models import CollectJob

        deadline = time.monotonic() + self._chunk_timeout
        while time.monotonic() < deadline:
            with self._session_factory() as db:
                job = db.get(CollectJob, job_id)
                if job is None or job.stage == "failed":
                    raise RuntimeError(f"collect job {job_id} failed during view-deps chunks")
                if job.stage == "ready":
                    return
                counts = json.loads(job.counts) if job.counts else {}
                if counts.get("deps_chunks_done", 0) >= expected_done:
                    return
            time.sleep(CHUNK_POLL_INTERVAL)
        raise RuntimeError(
            f"view-deps chunk {expected_done} did not complete within {self._chunk_timeout}s"
        )

    def run_view_deps(self, job_id: int, snapshot_id: int) -> None:
        view_total = self._count_views(snapshot_id)
        chunk_total = max(1, math.ceil(view_total / self._deps_chunk_size))
        for index in range(chunk_total):
            self._post("dbv-collect-viewdeps", {
                "collect_job_id": job_id, "snapshot_id": snapshot_id,
                "offset": index * self._deps_chunk_size,
                "limit": self._deps_chunk_size,
                "chunk_index": index + 1, "chunk_total": chunk_total,
            })
            self._wait_for_chunk(job_id, index + 1)
