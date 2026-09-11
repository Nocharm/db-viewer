"""뷰 정의 SQL 조회 — 구조 정보이므로 숨김 스키마만 막는다. / view definition endpoint."""

import sqlalchemy as sa

from app.config import get_settings
from app.models import Base


def _seed(client, load_fixture) -> None:
    sid = client.post("/api/ingest/catalog", json=load_fixture("catalog.json")).json()["snapshot_id"]
    client.post("/api/ingest/view-deps",
                json={**load_fixture("view_deps.json"), "snapshot_id": sid})


def _object_ids(engine) -> tuple[int, int, int]:
    """(정의 있는 뷰, 정의 없는 뷰, 테이블) id / ids of a view with, a view without, and a table."""
    objects = Base.metadata.tables["objects"]
    with engine.connect() as conn:
        with_def = conn.execute(sa.select(objects.c.id).where(
            objects.c.type == "view", objects.c.definition.is_not(None)).limit(1)).scalar_one()
        without_def = conn.execute(sa.select(objects.c.id).where(
            objects.c.type == "view", objects.c.definition.is_(None)).limit(1)).scalar_one_or_none()
        table = conn.execute(sa.select(objects.c.id).where(objects.c.type == "table").limit(1)).scalar_one()
    return with_def, without_def, table


def test_returns_the_definition_for_a_view(client, load_fixture, migrated_engine):
    _seed(client, load_fixture)
    with_def, _, _ = _object_ids(migrated_engine)
    res = client.get(f"/api/views/{with_def}/definition")
    assert res.status_code == 200, res.json()
    body = res.json()
    assert body["object_id"] == with_def and "." in body["object"]
    assert body["definition"] and "SELECT" in body["definition"].upper()


def test_missing_definition_is_null_not_an_error(client, load_fixture, migrated_engine):
    _seed(client, load_fixture)
    _, without_def, _ = _object_ids(migrated_engine)
    if without_def is None:
        # 픽스처에 권한 차단 뷰가 없으면 하나 만든다 / synthesize a permission-blocked view
        with migrated_engine.begin() as conn:
            conn.execute(sa.text(
                "UPDATE objects SET definition = NULL WHERE id = (SELECT MIN(id) FROM objects WHERE type = 'view')"))
            without_def = conn.execute(sa.text(
                "SELECT MIN(id) FROM objects WHERE type = 'view'")).scalar_one()
    res = client.get(f"/api/views/{without_def}/definition")
    assert res.status_code == 200 and res.json()["definition"] is None


def test_table_is_404(client, load_fixture, migrated_engine):
    _seed(client, load_fixture)
    _, _, table = _object_ids(migrated_engine)
    assert client.get(f"/api/views/{table}/definition").status_code == 404
    assert client.get("/api/views/999999/definition").status_code == 404


def test_hidden_schema_is_403(client, load_fixture, migrated_engine, monkeypatch):
    _seed(client, load_fixture)
    with_def, _, _ = _object_ids(migrated_engine)
    monkeypatch.setattr(get_settings(), "hidden_schemas", "dbo")
    res = client.get(f"/api/views/{with_def}/definition")
    assert res.status_code == 403
    assert res.json()["error"]["context"]["schema"] == "dbo"
