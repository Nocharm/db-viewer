"""Direct-connect collection runner. / 직결 소스 수집 러너.

FixtureCollectRunner와 같은 관용을 따른다 — 수집 결과를 ingest와 **같은 코드 경로**로
적재해 매핑·검증 로직이 갈라지지 않게 한다.
"""

from sqlalchemy.orm import sessionmaker

from app.models import CollectJob, DataSource, Snapshot
from app.sources.connection import get_sa_engine
from app.sources.registry import UnsupportedSource


class DirectCollectRunner:
    """소스에 직접 붙어 카탈로그를 읽고 ingest 경로로 적재한다."""

    def __init__(self, source: DataSource, session_factory: sessionmaker) -> None:
        self._source = source
        self._session_factory = session_factory

    def run_catalog(self, job_id: int) -> None:
        """소스를 읽어 ingest_catalog로 적재한 뒤, 그 자리에서 스냅샷을 조회 가능으로 마감한다.

        direct 소스에는 뷰 의존성 단계가 없다 — ingest_catalog가 남기는 기본 상태
        (snapshot='collecting', job.stage='catalog_done')로 두면 run_view_deps를
        기다리는 동안 스냅샷이 영원히 collecting에 머문다. resolve_snapshot은
        status=='ready'만 찾으므로 그 소스가 화면에 영영 안 보이게 된다 — 그래서 여기서
        바로 마감한다.
        """
        from app.api.ingest import ingest_catalog, update_collect_job
        from app.sources.pg_collector import collect_postgres
        from app.sources.sqlite_collector import collect_sqlite

        engine = get_sa_engine(self._source)
        if self._source.engine == "postgres":
            payload = collect_postgres(engine, self._source.name)
        elif self._source.engine == "sqlite":
            payload = collect_sqlite(engine, self._source.name)
        else:
            raise UnsupportedSource(
                f"no direct collector for engine {self._source.engine!r}")

        payload.collect_job_id = job_id
        payload.data_source_id = self._source.id
        with self._session_factory() as db:
            result = ingest_catalog(payload, db)
            snapshot = db.get(Snapshot, result["snapshot_id"])
            if snapshot is not None:
                snapshot.status = "ready"
            update_collect_job(db, job_id, "ready", snapshot_id=result["snapshot_id"])
            db.commit()

    def run_view_deps(self, job_id: int, snapshot_id: int) -> None:
        """비-MSSQL 소스에는 lineage 단계가 없다 — run_catalog가 이미 마감했으므로 no-op.

        뷰 의존성 역추적은 T-SQL 파서 기반이라 PG/SQLite DDL에 적용할 수 없다
        (Phase 2는 engine=='mssql'에서만 돈다, app/api/ingest.py 참조). 전체 모드 체인이
        catalog 단계 다음에 이 단계를 호출할 수 있으므로, 이미 끝난 상태를 재확인만 하고
        실패하지 않는다. 잡이 이미 failed면 손대지 않는다 — 실패를 성공으로 뒤집지 않는다.
        """
        from app.api.ingest import update_collect_job

        with self._session_factory() as db:
            job = db.get(CollectJob, job_id)
            if job is not None and job.stage == "failed":
                return
            snapshot = db.get(Snapshot, snapshot_id)
            if snapshot is not None:
                snapshot.status = "ready"
            update_collect_job(db, job_id, "ready", snapshot_id=snapshot_id)
            db.commit()
