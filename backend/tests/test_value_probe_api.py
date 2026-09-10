# backend/tests/test_value_probe_api.py
"""값 추적 API — 게이트·202/폴링·소유자·heavy 승격·취소·lineage 접기."""

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker

from app.api.value_probe import get_probe_session_factory
from app.config import get_settings
from app.models import Base, CatalogColumn, CatalogObject, ValueProbeHit, ViewLineageFlat


@pytest.fixture()
def pclient(client, migrated_engine, fixture_dir, monkeypatch):
    """러너 세션 팩토리 오버라이드 + 픽스처 값 집합 경로 / task-session override + fixtures."""
    factory = sessionmaker(bind=migrated_engine)
    client.app.dependency_overrides[get_probe_session_factory] = lambda: factory
    monkeypatch.setattr(get_settings(), "fixture_dir", str(fixture_dir))
    monkeypatch.setattr(get_settings(), "n8n_webhook_base", "")
    monkeypatch.setattr(get_settings(), "source_mode", "fixture")
    return client


def _seed(client, load_fixture) -> int:
    sid = client.post("/api/ingest/catalog", json=load_fixture("catalog.json")).json()["snapshot_id"]
    client.post("/api/ingest/view-deps",
                json={**load_fixture("view_deps.json"), "snapshot_id": sid})
    return sid


def _known_value(load_fixture) -> tuple[str, str, str]:
    for entry in load_fixture("value_sets.json")["columns"]:
        if len(entry["values"]) >= 60 and entry["object"].startswith("dbo."):
            return entry["object"], entry["column"], str(entry["values"][0])
    raise AssertionError("fixture has no usable value set")


def _start(client, value, schemas=("dbo",), **extra):
    return client.post("/api/value-probe", json={"source_id": 1, "schemas": list(schemas),
                                                 "value": value, **extra})


def test_start_then_poll_finds_the_column(pclient, load_fixture, allow_preview):
    _seed(pclient, load_fixture)
    allow_preview("dbo.X")
    obj, column, value = _known_value(load_fixture)

    res = _start(pclient, value, hint="주문")
    assert res.status_code == 202, res.json()
    body = res.json()
    assert body["plan"]["auto"] > 0 and body["plan"]["columns"] > 0

    # TestClient는 백그라운드 태스크를 응답 후 동기 실행한다 / tasks run before the poll
    job = pclient.get(f"/api/value-probe/{body['job_id']}").json()
    assert job["status"] == "done", job
    assert job["progress"]["done"] == job["progress"]["total"]
    assert job["value"] == value and job["schemas"] == ["dbo"] and job["source_id"] == 1
    hit = next((h for h in job["hits"] if h["qname"] == obj and h["column"] == column), None)
    assert hit is not None, job["hits"]
    assert hit["object_type"] == "table" and hit["match_count"] >= 1
    assert hit["matched_variant"] == value and hit["exposed_by_views"] == [] and hit["derived_from"] is None
    assert isinstance(hit["object_id"], int)


def test_unallowed_schema_is_403_with_the_schema_named(pclient, load_fixture):
    _seed(pclient, load_fixture)
    res = _start(pclient, "x")
    assert res.status_code == 403
    assert res.json()["error"]["context"]["schema"] == "dbo"


def test_hidden_schema_is_403_even_when_allowlisted(pclient, load_fixture, allow_preview, monkeypatch):
    _seed(pclient, load_fixture)
    allow_preview("dbo.X")
    monkeypatch.setattr(get_settings(), "hidden_schemas", "DBO")
    assert _start(pclient, "x").status_code == 403


def test_no_ready_snapshot_is_409(pclient, allow_preview):
    allow_preview("dbo.X")
    assert _start(pclient, "x").status_code == 409


def test_unknown_source_is_404(pclient):
    res = pclient.post("/api/value-probe", json={"source_id": 999, "schemas": ["dbo"], "value": "x"})
    assert res.status_code == 404


def test_blank_value_and_too_long_value_are_rejected(pclient, load_fixture, allow_preview):
    _seed(pclient, load_fixture)
    allow_preview("dbo.X")
    assert _start(pclient, "   ").status_code == 400
    assert _start(pclient, "x" * 101).status_code == 422


def test_contains_mode_needs_a_narrow_scope(pclient, load_fixture, allow_preview, monkeypatch):
    _seed(pclient, load_fixture)
    allow_preview("dbo.X")
    monkeypatch.setattr(get_settings(), "value_probe_contains_max_tables", 0)
    res = _start(pclient, "abc", mode="contains")
    assert res.status_code == 400
    assert res.json()["error"]["context"]["limit"] == 0


def test_audit_log_records_the_probe(pclient, load_fixture, allow_preview, migrated_engine):
    _seed(pclient, load_fixture)
    allow_preview("dbo.X")
    _, _, value = _known_value(load_fixture)
    _start(pclient, value)
    with migrated_engine.connect() as conn:
        rows = conn.execute(sa.select(Base.metadata.tables["audit_logs"])).all()
    entry = next(r for r in rows if r.action == "value_probe")
    assert f"value='{value}'" in entry.detail and "schemas=dbo" in entry.detail
    assert entry.requested_by == "dev.user"


def test_another_users_job_is_404_but_sysadmin_can_read(pclient, load_fixture, allow_preview, monkeypatch):
    _seed(pclient, load_fixture)
    allow_preview("dbo.X")
    _, _, value = _known_value(load_fixture)
    job_id = _start(pclient, value).json()["job_id"]
    assert pclient.get(f"/api/value-probe/{job_id}", headers={"X-Dev-User": "someone.else"}).status_code == 404
    monkeypatch.setattr(get_settings(), "dbv_sysadmins", "root.admin")
    assert pclient.get(f"/api/value-probe/{job_id}", headers={"X-Dev-User": "root.admin"}).status_code == 200
    assert pclient.get("/api/value-probe/999999").status_code == 404


def test_heavy_target_is_listed_then_promoted(pclient, load_fixture, allow_preview, migrated_engine):
    sid = _seed(pclient, load_fixture)
    allow_preview("dbo.X")
    obj, column, value = _known_value(load_fixture)
    schema, name = obj.split(".", 1)
    with sessionmaker(bind=migrated_engine)() as db:
        target_obj = db.execute(sa.select(CatalogObject).where(
            CatalogObject.snapshot_id == sid, CatalogObject.schema == schema,
            CatalogObject.name == name)).scalar_one()
        target_obj.row_count = 9_000_000
        db.commit()

    job_id = _start(pclient, value).json()["job_id"]
    job = pclient.get(f"/api/value-probe/{job_id}").json()
    heavy = next(h for h in job["heavy"] if h["qname"] == obj)
    assert heavy["reason"] == "rows" and heavy["est_rows"] == 9_000_000
    assert not any(h["qname"] == obj for h in job["hits"])

    res = pclient.post(f"/api/value-probe/{job_id}/heavy", json={"target_ids": [heavy["target_id"]]})
    assert res.status_code == 200 and res.json()["promoted"] == 1
    job = pclient.get(f"/api/value-probe/{job_id}").json()
    assert job["status"] == "done"
    hit = next(h for h in job["hits"] if h["qname"] == obj and h["column"] == column)
    assert hit["match_count"] is None  # heavy는 건수 생략 / no count query on heavy objects
    assert not any(h["qname"] == obj for h in job["heavy"])


def test_promoting_a_non_heavy_target_is_400(pclient, load_fixture, allow_preview, migrated_engine):
    _seed(pclient, load_fixture)
    allow_preview("dbo.X")
    _, _, value = _known_value(load_fixture)
    job_id = _start(pclient, value).json()["job_id"]
    with migrated_engine.connect() as conn:
        auto_id = conn.execute(sa.text(
            "SELECT id FROM value_probe_targets WHERE job_id = :j AND tier = 'auto' LIMIT 1"
        ), {"j": job_id}).scalar_one()
    assert pclient.post(f"/api/value-probe/{job_id}/heavy", json={"target_ids": [auto_id]}).status_code == 400


def test_cancel_a_queued_job(pclient, load_fixture, allow_preview, monkeypatch):
    _seed(pclient, load_fixture)
    allow_preview("dbo.X")
    _, _, value = _known_value(load_fixture)
    monkeypatch.setattr(get_settings(), "value_probe_max_concurrent", 0)  # 러너가 집지 않는다
    job_id = _start(pclient, value).json()["job_id"]
    assert pclient.get(f"/api/value-probe/{job_id}").json()["status"] == "queued"
    res = pclient.post(f"/api/value-probe/{job_id}/cancel")
    assert res.status_code == 200 and res.json()["status"] == "cancelled"


def test_lineage_folds_views_under_table_hits_and_names_derived_sources(pclient, load_fixture, allow_preview, migrated_engine):
    sid = _seed(pclient, load_fixture)
    allow_preview("dbo.X")
    obj, column, value = _known_value(load_fixture)
    job_id = _start(pclient, value).json()["job_id"]
    job = pclient.get(f"/api/value-probe/{job_id}").json()
    hit = next(h for h in job["hits"] if h["qname"] == obj and h["column"] == column)

    with sessionmaker(bind=migrated_engine)() as db:
        view = db.execute(sa.select(CatalogObject).where(
            CatalogObject.snapshot_id == sid, CatalogObject.type == "view")).scalars().first()
        # 테이블 히트를 direct로 노출하는 뷰 / a view exposing the hit column directly
        db.add(ViewLineageFlat(snapshot_id=sid, view_object_id=view.id, view_column="EXPOSED",
                               base_object_id=hit["object_id"], base_column=column, depth=1,
                               mapping_kind="direct", flag=None))
        # 뷰 파생 컬럼 히트 — 원본을 알려줘야 한다 / a derived view-column hit
        db.add(ViewLineageFlat(snapshot_id=sid, view_object_id=view.id, view_column="DERIVED",
                               base_object_id=hit["object_id"], base_column=column, depth=1,
                               mapping_kind="derived", flag=None))
        target_id = db.execute(sa.text(
            "SELECT id FROM value_probe_targets WHERE job_id = :j LIMIT 1"), {"j": job_id}).scalar_one()
        db.add(ValueProbeHit(job_id=job_id, target_id=target_id, object_id=view.id,
                             object_type="view", qname=f"{view.schema}.{view.name}",
                             column_name="DERIVED", match_count=1, count_capped=False,
                             matched_variant=value))
        db.commit()
        view_qname = f"{view.schema}.{view.name}"

    job = pclient.get(f"/api/value-probe/{job_id}").json()
    table_hit = next(h for h in job["hits"] if h["qname"] == obj and h["column"] == column)
    assert table_hit["exposed_by_views"] == [view_qname]
    view_hit = next(h for h in job["hits"] if h["qname"] == view_qname)
    assert view_hit["derived_from"] == {"qname": obj, "column": column}


def test_heavy_promotion_rechecks_the_allowlist(pclient, load_fixture, allow_preview, migrated_engine):
    sid = _seed(pclient, load_fixture)
    allow_preview("dbo.X")
    obj, _, value = _known_value(load_fixture)
    schema, name = obj.split(".", 1)
    with sessionmaker(bind=migrated_engine)() as db:
        target_obj = db.execute(sa.select(CatalogObject).where(
            CatalogObject.snapshot_id == sid, CatalogObject.schema == schema,
            CatalogObject.name == name)).scalar_one()
        target_obj.row_count = 9_000_000
        db.commit()
    job_id = _start(pclient, value).json()["job_id"]
    heavy = next(h for h in pclient.get(f"/api/value-probe/{job_id}").json()["heavy"] if h["qname"] == obj)
    # 관리자가 허용 목록에서 스키마를 뺀 뒤 승격하면 막혀야 한다 / revoked after the job was created
    with migrated_engine.begin() as conn:
        conn.execute(sa.text("DELETE FROM preview_allowlist WHERE data_source_id = 1 AND schema = 'dbo'"))
    res = pclient.post(f"/api/value-probe/{job_id}/heavy", json={"target_ids": [heavy["target_id"]]})
    assert res.status_code == 403
    assert res.json()["error"]["context"]["schema"] == "dbo"


def test_heavy_promotion_on_a_running_job_is_409(pclient, load_fixture, allow_preview, migrated_engine):
    _seed(pclient, load_fixture)
    allow_preview("dbo.X")
    _, _, value = _known_value(load_fixture)
    job_id = _start(pclient, value).json()["job_id"]
    with migrated_engine.begin() as conn:
        conn.execute(sa.text("UPDATE value_probe_jobs SET status = 'running' WHERE id = :j"), {"j": job_id})
        auto_id = conn.execute(sa.text(
            "SELECT id FROM value_probe_targets WHERE job_id = :j LIMIT 1"), {"j": job_id}).scalar_one()
        conn.execute(sa.text("UPDATE value_probe_targets SET tier = 'heavy' WHERE id = :t"), {"t": auto_id})
    res = pclient.post(f"/api/value-probe/{job_id}/heavy", json={"target_ids": [auto_id]})
    assert res.status_code == 409


def test_heavy_and_cancel_are_owner_only(pclient, load_fixture, allow_preview):
    _seed(pclient, load_fixture)
    allow_preview("dbo.X")
    _, _, value = _known_value(load_fixture)
    job_id = _start(pclient, value).json()["job_id"]
    other = {"X-Dev-User": "someone.else"}
    assert pclient.post(f"/api/value-probe/{job_id}/heavy", json={"target_ids": [1]}, headers=other).status_code == 404
    assert pclient.post(f"/api/value-probe/{job_id}/cancel", headers=other).status_code == 404


def _add_related_view(migrated_engine, sid: int, schema: str = "OTHER") -> int:
    """다른 스키마에서 dbo.APV_APRV.APRVCD를 읽는 뷰 1개 + lineage / a view in another schema."""
    with sessionmaker(bind=migrated_engine)() as db:
        base = db.execute(sa.select(CatalogObject).where(
            CatalogObject.snapshot_id == sid, CatalogObject.schema == "dbo",
            CatalogObject.name == "APV_APRV")).scalar_one()
        view = CatalogObject(snapshot_id=sid, schema=schema, name="V_RELATED", type="view",
                             object_id=990001, row_count=None,
                             definition="SELECT APRVCD AS RELATED_CD FROM dbo.APV_APRV",
                             dmv_unresolved=False)
        db.add(view)
        db.flush()
        db.add(CatalogColumn(object_id=view.id, name="RELATED_CD", ordinal=1, data_type="int",
                             max_length=4, is_nullable=True, is_pk=False, is_computed=False))
        db.add(ViewLineageFlat(snapshot_id=sid, view_object_id=view.id, view_column="RELATED_CD",
                               base_object_id=base.id, base_column="APRVCD", depth=1,
                               mapping_kind="derived", flag=None))
        db.commit()
        return view.id


def test_related_views_are_off_by_default(pclient, load_fixture, allow_preview, migrated_engine):
    sid = _seed(pclient, load_fixture)
    allow_preview("dbo.X")
    _add_related_view(migrated_engine, sid)
    _, _, value = _known_value(load_fixture)
    res = _start(pclient, value)
    assert res.json()["plan"]["related_views"] == {"included": 0, "skipped": []}
    job = pclient.get(f"/api/value-probe/{res.json()['job_id']}").json()
    assert job["include_related_views"] is False and job["related_schemas"] == []


def test_related_view_outside_the_allowlist_is_reported_not_probed(pclient, load_fixture, allow_preview, migrated_engine):
    sid = _seed(pclient, load_fixture)
    allow_preview("dbo.X")
    _add_related_view(migrated_engine, sid)
    _, _, value = _known_value(load_fixture)
    res = _start(pclient, value, include_related_views=True)
    assert res.status_code == 202, res.json()
    plan = res.json()["plan"]["related_views"]
    assert plan == {"included": 0, "skipped": [
        {"qname": "OTHER.V_RELATED", "schema": "OTHER", "reason": "not_allowed"}]}
    with migrated_engine.connect() as conn:
        probed = conn.execute(sa.text(
            "SELECT COUNT(*) FROM value_probe_targets WHERE job_id = :j AND qname = 'OTHER.V_RELATED'"
        ), {"j": res.json()["job_id"]}).scalar_one()
    assert probed == 0
    job = pclient.get(f"/api/value-probe/{res.json()['job_id']}").json()
    assert job["related_view_skipped"][0]["reason"] == "not_allowed"


def test_hidden_related_view_schema_is_reported_as_hidden(pclient, load_fixture, allow_preview, migrated_engine, monkeypatch):
    sid = _seed(pclient, load_fixture)
    allow_preview("dbo.X", "OTHER.X")
    _add_related_view(migrated_engine, sid)
    monkeypatch.setattr(get_settings(), "hidden_schemas", "other")
    _, _, value = _known_value(load_fixture)
    res = _start(pclient, value, include_related_views=True)
    assert res.json()["plan"]["related_views"]["skipped"][0]["reason"] == "hidden"


def test_allowed_related_view_joins_the_plan_and_the_gates(pclient, load_fixture, allow_preview, migrated_engine):
    sid = _seed(pclient, load_fixture)
    allow_preview("dbo.X", "OTHER.X")
    _add_related_view(migrated_engine, sid)
    _, _, value = _known_value(load_fixture)
    res = _start(pclient, value, include_related_views=True)
    assert res.json()["plan"]["related_views"] == {"included": 1, "skipped": []}
    job_id = res.json()["job_id"]
    with migrated_engine.connect() as conn:
        target = conn.execute(sa.text(
            "SELECT tier, object_type FROM value_probe_targets WHERE job_id = :j AND qname = 'OTHER.V_RELATED'"
        ), {"j": job_id}).one()
    assert target.object_type == "view"
    job = pclient.get(f"/api/value-probe/{job_id}").json()
    assert job["related_schemas"] == ["OTHER"] and job["include_related_views"] is True
    # 감사 로그에 연관 뷰 포함/제외 수가 남는다 / audit carries the related-view counts
    with migrated_engine.connect() as conn:
        detail = conn.execute(sa.text(
            "SELECT detail FROM audit_logs WHERE action = 'value_probe' ORDER BY id DESC LIMIT 1"
        )).scalar_one()
    assert "related_views=+1/-0" in detail


def test_runner_gate_covers_related_schemas(pclient, load_fixture, allow_preview, migrated_engine, monkeypatch):
    sid = _seed(pclient, load_fixture)
    allow_preview("dbo.X", "OTHER.X")
    _add_related_view(migrated_engine, sid)
    _, _, value = _known_value(load_fixture)
    monkeypatch.setattr(get_settings(), "value_probe_max_concurrent", 0)  # 큐에 머문다
    job_id = _start(pclient, value, include_related_views=True).json()["job_id"]
    with migrated_engine.begin() as conn:
        conn.execute(sa.text("DELETE FROM preview_allowlist WHERE data_source_id = 1 AND schema = 'OTHER'"))
    monkeypatch.setattr(get_settings(), "value_probe_max_concurrent", 1)
    pclient.get(f"/api/value-probe/{job_id}")           # 이 폴링이 러너를 깨운다 / this poll kicks the runner
    job = pclient.get(f"/api/value-probe/{job_id}").json()  # 다음 폴링이 결과를 본다 / the next one observes
    assert job["status"] == "failed" and job["error"] == "schema gate revoked"
