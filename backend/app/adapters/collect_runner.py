"""Collection runners — fixture replay offline, n8n webhook when connected. / 수집 러너 어댑터."""

import json
import urllib.request
from pathlib import Path
from typing import Protocol

from sqlalchemy.orm import sessionmaker

from app.schemas.ingest import CatalogPayload, ViewDepsPayload

# n8n webhook 응답 대기 상한(초) — 트리거만 하고 실제 진행은 ingest 콜백이 갱신
# webhook trigger timeout; actual progress arrives via the ingest callback
WEBHOOK_TIMEOUT = 30


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
        return json.loads((self._fixture_dir / name).read_text())

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
    Fires the n8n webhooks; n8n collects and POSTs back to ingest."""

    def __init__(self, webhook_base: str) -> None:
        self._base = webhook_base.rstrip("/")

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
        self._post("dbv-collect-catalog", {"collect_job_id": job_id})

    def run_view_deps(self, job_id: int, snapshot_id: int) -> None:
        self._post("dbv-collect-viewdeps",
                   {"collect_job_id": job_id, "snapshot_id": snapshot_id})
