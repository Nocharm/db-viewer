"""Ingest endpoint tests against the generated fixture set. / 픽스처 기반 ingest 테스트."""

import sqlalchemy as sa

from app.models import Base


def _count(engine, table: str) -> int:
    with engine.connect() as conn:
        return conn.execute(
            sa.select(sa.func.count()).select_from(Base.metadata.tables[table])
        ).scalar()


def _ingest_catalog(client, load_fixture) -> tuple[int, dict]:
    payload = load_fixture("catalog.json")
    res = client.post("/api/ingest/catalog", json=payload)
    assert res.status_code == 200, res.text
    return res.json()["snapshot_id"], payload


def test_ingest_catalog_persists_counts(client, migrated_engine, load_fixture):
    snapshot_id, payload = _ingest_catalog(client, load_fixture)

    assert snapshot_id == 1
    assert _count(migrated_engine, "objects") == len(payload["objects"])
    assert _count(migrated_engine, "columns") == len(payload["columns"])
    assert _count(migrated_engine, "constraints") == (
        len(payload["key_constraints"]) + len(payload["foreign_keys"])
    )
    assert _count(migrated_engine, "fk_columns") == sum(
        len(fk["columns"]) for fk in payload["foreign_keys"]
    )


def test_ingest_catalog_derives_is_pk(client, migrated_engine, load_fixture):
    _, payload = _ingest_catalog(client, load_fixture)
    expected_pk_pairs = sum(
        len(kc["columns"]) for kc in payload["key_constraints"] if kc["type"] == "pk"
    )
    with migrated_engine.connect() as conn:
        t = Base.metadata.tables["columns"]
        actual = conn.execute(
            sa.select(sa.func.count()).select_from(t).where(t.c.is_pk.is_(True))
        ).scalar()
    assert actual == expected_pk_pairs


def test_ingest_catalog_keeps_null_definitions(client, migrated_engine, load_fixture):
    # 권한 차단 뷰의 definition NULL은 NULL로 보존 / blocked definitions stay NULL
    _, payload = _ingest_catalog(client, load_fixture)
    null_defs = sum(1 for vd in payload["view_definitions"] if vd["definition"] is None)
    with migrated_engine.connect() as conn:
        t = Base.metadata.tables["objects"]
        stored_null = conn.execute(
            sa.select(sa.func.count()).select_from(t)
            .where(t.c.type == "view", t.c.definition.is_(None))
        ).scalar()
        stored_filled = conn.execute(
            sa.select(sa.func.count()).select_from(t)
            .where(t.c.type == "view", t.c.definition.is_not(None))
        ).scalar()
    assert stored_null == null_defs
    assert stored_filled == len(payload["view_definitions"]) - null_defs


def test_ingest_view_deps_full_flow(client, migrated_engine, load_fixture):
    snapshot_id, _ = _ingest_catalog(client, load_fixture)
    vd = load_fixture("view_deps.json")

    res = client.post("/api/ingest/view-deps", json={**vd, "snapshot_id": snapshot_id})
    assert res.status_code == 200, res.text
    assert res.json()["counts"]["deps"] == len(vd["deps"])

    with migrated_engine.connect() as conn:
        deps_t = Base.metadata.tables["view_deps"]
        unresolved = conn.execute(
            sa.select(deps_t).where(deps_t.c.is_resolved.is_(False))
        ).all()
        # 미해석 참조는 텍스트 식별자 보존 / unresolved refs keep textual identity
        assert unresolved and all(r.referenced_object_id is None for r in unresolved)
        assert all(r.referenced_name for r in unresolved)

        obj_t = Base.metadata.tables["objects"]
        dmv_flagged = conn.execute(
            sa.select(sa.func.count()).select_from(obj_t).where(obj_t.c.dmv_unresolved.is_(True))
        ).scalar()
        assert dmv_flagged == len(vd["unresolved_objects"])

        status = conn.execute(sa.select(Base.metadata.tables["snapshots"].c.status)).scalar()
        assert status == "ready"


def test_view_deps_unknown_snapshot_is_404(client, load_fixture):
    vd = load_fixture("view_deps.json")
    res = client.post("/api/ingest/view-deps", json={**vd, "snapshot_id": 999})
    assert res.status_code == 404
    body = res.json()
    # 승인된 에러 규약 준수 / approved error envelope
    assert body["error"]["code"] == 404
    assert body["error"]["context"] == {"snapshot_id": 999}


def test_invalid_payload_is_422_envelope(client):
    res = client.post("/api/ingest/catalog", json={"source_db": 1})
    assert res.status_code == 422
    assert res.json()["error"]["code"] == 422


def test_second_catalog_ingest_creates_new_snapshot(client, migrated_engine, load_fixture):
    sid1, _ = _ingest_catalog(client, load_fixture)
    sid2, payload = _ingest_catalog(client, load_fixture)
    assert (sid1, sid2) == (1, 2)
    assert _count(migrated_engine, "objects") == 2 * len(payload["objects"])
