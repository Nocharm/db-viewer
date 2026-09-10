"""값 추적 서비스 — 계획 적재·러너 실행·취소·대상 오류 격리. / planner + runner tests."""

import json
from datetime import UTC, datetime

import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker

from app.adapters.n8n_query import N8nQueryError
from app.config import Settings
from app.models import Base, CatalogObject, PreviewAllowlist, ValueProbeJob, ValueProbeTarget
from app.models.sources import MANAGED_MSSQL_SOURCE_ID
from app.services import value_probe as service


def _seed(client, load_fixture) -> int:
    sid = client.post("/api/ingest/catalog", json=load_fixture("catalog.json")).json()["snapshot_id"]
    client.post("/api/ingest/view-deps",
                json={**load_fixture("view_deps.json"), "snapshot_id": sid})
    return sid


def _known_value(load_fixture) -> tuple[str, str, str]:
    """value_sets.json에서 함정이 아닌 (object, column, value) 하나 / a non-trap known value."""
    for entry in load_fixture("value_sets.json")["columns"]:
        if len(entry["values"]) >= 60 and entry["object"].startswith("dbo."):
            return entry["object"], entry["column"], str(entry["values"][0])
    raise AssertionError("fixture has no usable value set")


def _settings(fixture_dir, **overrides) -> Settings:
    base = dict(source_mode="fixture", n8n_webhook_base="", fixture_dir=str(fixture_dir))
    base.update(overrides)
    return Settings(_env_file=None, **base)


def _new_job(factory, snapshot_id: int, value: str, schemas=("dbo",), mode="normalized",
             settings: Settings | None = None, cancel=False, allowed: bool = True) -> int:
    now = datetime.now(UTC)
    with factory() as db:
        job = ValueProbeJob(data_source_id=MANAGED_MSSQL_SOURCE_ID, snapshot_id=snapshot_id,
                            value=value, mode=mode, hint=None, schemas=json.dumps(list(schemas)),
                            status="queued", progress_total=0, progress_done=0,
                            cancel_requested=cancel, triggered_by="test", created_at=now)
        db.add(job)
        db.flush()
        if allowed:
            # 러너가 기동 직전에 허용 목록을 재확인한다 — 기본은 허용해 기존 테스트를 보존한다
            for schema in schemas:
                if db.get(PreviewAllowlist, (MANAGED_MSSQL_SOURCE_ID, schema)) is None:
                    db.add(PreviewAllowlist(data_source_id=MANAGED_MSSQL_SOURCE_ID, schema=schema,
                                            note=None, added_by="test", created_at=now))
        targets = service.build_plan(db, snapshot_id, list(schemas), "mssql", value, mode, None,
                                     settings or Settings(_env_file=None))
        for target in targets:
            db.add(ValueProbeTarget(
                job_id=job.id, object_id=target.object_id, qname=target.qname,
                object_type=target.object_type,
                columns=json.dumps([c.to_dict() for c in target.columns]),
                tier=target.tier, heavy_reason=target.heavy_reason, rank=target.rank,
                est_rows=target.est_rows, status="pending"))
        job.progress_total = sum(1 for t in targets if t.tier == "auto")
        db.commit()
        return job.id


def test_load_probe_catalog_filters_schemas_and_marks_direct_lineage(client, migrated_engine, load_fixture):
    sid = _seed(client, load_fixture)
    factory = sessionmaker(bind=migrated_engine)
    with factory() as db:
        columns, objects = service.load_probe_catalog(db, sid, ["dbo"])
        assert columns and objects
        assert all(obj.qname.startswith("dbo.") for obj in objects.values())
        # 뷰는 base_row_counts를 lineage에서 받는다 / views carry base row counts
        views = [obj for obj in objects.values() if obj.object_type == "view"]
        assert views and any(obj.base_row_counts for obj in views)
        assert service.load_probe_catalog(db, sid, ["NOPE"]) == ([], {})


def test_build_plan_puts_tables_before_views_and_auto_tier_for_fixture_sizes(client, migrated_engine, load_fixture):
    sid = _seed(client, load_fixture)
    _, _, value = _known_value(load_fixture)
    with sessionmaker(bind=migrated_engine)() as db:
        targets = service.build_plan(db, sid, ["dbo"], "mssql", value, "normalized", None,
                                     Settings(_env_file=None))
    assert targets
    kinds = [t.object_type for t in targets]
    assert kinds == sorted(kinds, key=lambda k: 0 if k == "table" else 1)
    assert any(t.tier == "auto" for t in targets)


def test_runner_finds_the_known_column(client, migrated_engine, load_fixture, fixture_dir):
    sid = _seed(client, load_fixture)
    obj, column, value = _known_value(load_fixture)
    factory = sessionmaker(bind=migrated_engine)
    settings = _settings(fixture_dir)
    job_id = _new_job(factory, sid, value, settings=settings)

    service.run_startable_probe_jobs(factory, settings)

    with factory() as db:
        job = db.get(ValueProbeJob, job_id)
        assert job.status == "done" and job.progress_done == job.progress_total > 0
        assert job.current_qname is None
        hits = db.execute(sa.select(Base.metadata.tables["value_probe_hits"])).all()
    assert any(h.qname == obj and h.column_name == column for h in hits), [(h.qname, h.column_name) for h in hits]
    hit = next(h for h in hits if h.qname == obj and h.column_name == column)
    assert hit.match_count is not None and hit.match_count >= 1
    assert hit.matched_variant == value


def test_runner_respects_the_concurrency_guard(client, migrated_engine, load_fixture, fixture_dir):
    sid = _seed(client, load_fixture)
    _, _, value = _known_value(load_fixture)
    factory = sessionmaker(bind=migrated_engine)
    job_id = _new_job(factory, sid, value)
    service.run_startable_probe_jobs(factory, _settings(fixture_dir, value_probe_max_concurrent=0))
    with factory() as db:
        assert db.get(ValueProbeJob, job_id).status == "queued"


def test_cancel_requested_stops_before_the_first_target(client, migrated_engine, load_fixture, fixture_dir):
    sid = _seed(client, load_fixture)
    _, _, value = _known_value(load_fixture)
    factory = sessionmaker(bind=migrated_engine)
    job_id = _new_job(factory, sid, value, cancel=True)
    service.run_startable_probe_jobs(factory, _settings(fixture_dir))
    with factory() as db:
        job = db.get(ValueProbeJob, job_id)
        assert job.status == "cancelled" and job.progress_done == 0
        pending = db.execute(sa.select(sa.func.count()).select_from(ValueProbeTarget)
                             .where(ValueProbeTarget.job_id == job_id,
                                    ValueProbeTarget.tier == "auto",
                                    ValueProbeTarget.status == "pending")).scalar_one()
        assert pending == job.progress_total


def test_cancel_wins_even_when_no_auto_target_exists(client, migrated_engine, load_fixture, fixture_dir):
    sid = _seed(client, load_fixture)
    _, _, value = _known_value(load_fixture)
    factory = sessionmaker(bind=migrated_engine)
    # 대상이 하나도 없는 스키마 — 루프에 들어가지 않는 경로 / no targets, loop never runs
    job_id = _new_job(factory, sid, value, schemas=("NO_SUCH_SCHEMA",), cancel=True)
    service.run_startable_probe_jobs(factory, _settings(fixture_dir))
    with factory() as db:
        job = db.get(ValueProbeJob, job_id)
        assert job.status == "cancelled" and job.finished_at is not None


def test_one_failing_target_does_not_fail_the_job(client, migrated_engine, load_fixture, fixture_dir, monkeypatch):
    sid = _seed(client, load_fixture)
    obj, column, value = _known_value(load_fixture)
    factory = sessionmaker(bind=migrated_engine)
    settings = _settings(fixture_dir)
    job_id = _new_job(factory, sid, value, settings=settings)

    real_factory = service.create_value_prober

    class _Flaky:
        def __init__(self, inner):
            self._inner = inner

        def probe(self, schema, name, columns):
            if f"{schema}.{name}" == obj:
                raise N8nQueryError("n8n query failed: kind=value_probe status=504")
            return self._inner.probe(schema, name, columns)

        def count(self, schema, name, column, cap):
            return self._inner.count(schema, name, column, cap)

    monkeypatch.setattr(service, "create_value_prober",
                        lambda s, source=None: _Flaky(real_factory(s, source)))
    service.run_startable_probe_jobs(factory, settings)

    with factory() as db:
        job = db.get(ValueProbeJob, job_id)
        assert job.status == "done"
        failed = db.execute(sa.select(ValueProbeTarget).where(
            ValueProbeTarget.job_id == job_id, ValueProbeTarget.qname == obj)).scalars().first()
        assert failed.status == "error"
        assert failed.error == "n8n query failed: kind=value_probe status=504"


def test_classify_error_redacts_urls_and_bodies_and_detects_timed_out():
    from app.adapters.n8n_query import N8nQueryError
    status, text = service._classify_error(N8nQueryError(
        "n8n rejected the query: kind=value_probe url=http://n8n.internal/webhook/dbv-query "
        "status=502 body=Login failed for user 'svc_dbviewer'"))
    assert (status, text) == ("error", "n8n query failed: kind=value_probe status=502")
    status, text = service._classify_error(N8nQueryError(
        "n8n query failed after retries: kind=value_count url=http://n8n.internal/x (<urlopen error timed out>)"))
    assert status == "timeout" and "internal" not in text and "urlopen" not in text


def test_unavailable_source_marks_the_job_failed(client, migrated_engine, load_fixture, fixture_dir):
    sid = _seed(client, load_fixture)
    _, _, value = _known_value(load_fixture)
    factory = sessionmaker(bind=migrated_engine)
    job_id = _new_job(factory, sid, value)
    # 원천이 붙어 있는데 live가 아니면 합성 대신 명시 실패 — 잡은 failed
    service.run_startable_probe_jobs(factory, _settings(fixture_dir, n8n_webhook_base="http://n8n/webhook"))
    with factory() as db:
        job = db.get(ValueProbeJob, job_id)
        assert job.status == "failed" and job.error == "SyntheticDataRefused"


def test_heavy_targets_are_skipped_until_promoted(client, migrated_engine, load_fixture, fixture_dir):
    sid = _seed(client, load_fixture)
    obj, column, value = _known_value(load_fixture)
    factory = sessionmaker(bind=migrated_engine)
    with factory() as db:
        schema, name = obj.split(".", 1)
        target_obj = db.execute(sa.select(CatalogObject).where(
            CatalogObject.snapshot_id == sid, CatalogObject.schema == schema,
            CatalogObject.name == name)).scalar_one()
        target_obj.row_count = 9_000_000
        db.commit()
    settings = _settings(fixture_dir)
    job_id = _new_job(factory, sid, value, settings=settings)
    service.run_startable_probe_jobs(factory, settings)
    with factory() as db:
        heavy = db.execute(sa.select(ValueProbeTarget).where(
            ValueProbeTarget.job_id == job_id, ValueProbeTarget.qname == obj)).scalars().first()
        assert heavy.tier == "heavy" and heavy.heavy_reason == "rows" and heavy.status == "pending"
        # 승격 후 실행하면 히트하되 건수는 생략된다 / promoted: hit without a count
        heavy.tier = "auto"
        job = db.get(ValueProbeJob, job_id)
        job.status = "queued"
        job.progress_total += 1
        db.commit()
    service.run_startable_probe_jobs(factory, settings)
    with factory() as db:
        hits = db.execute(sa.select(Base.metadata.tables["value_probe_hits"])).all()
        hit = next(h for h in hits if h.qname == obj and h.column_name == column)
        assert hit.match_count is None


def test_runner_fails_a_job_whose_schema_was_revoked(client, migrated_engine, load_fixture, fixture_dir):
    sid = _seed(client, load_fixture)
    _, _, value = _known_value(load_fixture)
    factory = sessionmaker(bind=migrated_engine)
    job_id = _new_job(factory, sid, value, allowed=False)   # 허용 목록에 dbo가 없다 — 러너가 실행 직전에 막아야 한다
    service.run_startable_probe_jobs(factory, _settings(fixture_dir))
    with factory() as db:
        job = db.get(ValueProbeJob, job_id)
        assert job.status == "failed" and job.error == "schema gate revoked"
