"""Read-only ERD graph endpoint tests. / 읽기 전용 ERD 그래프 테스트."""

import pytest
import sqlalchemy as sa

from app.adapters.fake_validator import FakeJoinValidator
from app.api.validate import get_join_validator
from app.models import Base
from app.models.sources import MANAGED_MSSQL_SOURCE_ID


@pytest.fixture()
def vclient(client, fixture_dir):
    client.app.dependency_overrides[get_join_validator] = lambda: FakeJoinValidator(
        fixture_dir / "value_sets.json"
    )
    return client


def _seed(client, load_fixture) -> None:
    sid = client.post("/api/ingest/catalog",
                      json=load_fixture("catalog.json")).json()["snapshot_id"]
    client.post("/api/ingest/view-deps",
                json={**load_fixture("view_deps.json"), "snapshot_id": sid})


def _column_id(engine, object_qname: str, column: str) -> int:
    schema, table = object_qname.split(".", 1)
    obj_t, col_t = Base.metadata.tables["objects"], Base.metadata.tables["columns"]
    with engine.connect() as conn:
        return conn.execute(
            sa.select(col_t.c.id).join(obj_t, col_t.c.object_id == obj_t.c.id)
            .where(obj_t.c.schema == schema, obj_t.c.name == table, col_t.c.name == column)
        ).scalar_one()


def _pick_relation(load_fixture, **filters):
    for rel in load_fixture("expected/relations.json")["rows"]:
        if all(rel[k] == v for k, v in filters.items()):
            return rel
    raise AssertionError(f"no relation matching {filters}")


def test_erd_serves_fk_and_confirmed_edges_only(vclient, migrated_engine, load_fixture):
    _seed(vclient, load_fixture)
    rel = _pick_relation(load_fixture, kind="real_no_fk", orphan_count=0)
    src_id = _column_id(migrated_engine, rel["src_object"], rel["src_column"])
    tgt_id = _column_id(migrated_engine, rel["tgt_object"], rel["tgt_column"])
    vclient.post("/api/validate/containment",
                 json={"src_column_id": src_id, "tgt_column_id": tgt_id})

    before = vclient.get("/api/erd").json()
    assert all(e["kind"] == "fk" for e in before["edges"])  # validated는 아직 미등장

    vclient.post("/api/relations/confirm",
                 json={"src_column_id": src_id, "tgt_column_id": tgt_id})
    after = vclient.get("/api/erd").json()

    kinds = {e["kind"] for e in after["edges"]}
    assert kinds <= {"fk", "confirmed"}
    assert "confirmed" in kinds
    # ErdViewer 근거 카드가 이 두 필드를 직접 렌더한다 — containment를 이미 돌렸으니 비어 있으면 회귀
    confirmed_edge = next(e for e in after["edges"] if e["kind"] == "confirmed")
    assert confirmed_edge["last_verified_at"] is not None
    assert confirmed_edge["confidence"] is not None
    # 노드는 엣지 참여 테이블만 — 뷰·고립 테이블 없음
    edge_ids = {e["src_object_id"] for e in after["edges"]} | {
        e["tgt_object_id"] for e in after["edges"]}
    assert {n["id"] for n in after["nodes"]} == edge_ids
    assert all(n["type"] == "table" for n in after["nodes"])


def test_erd_excludes_hidden_schemas(vclient, load_fixture, monkeypatch):
    from app.config import get_settings

    _seed(vclient, load_fixture)
    monkeypatch.setenv("HIDDEN_SCHEMAS", "dbo")
    get_settings.cache_clear()
    try:
        body = vclient.get("/api/erd").json()
        assert body["nodes"] == [] and body["edges"] == []  # dbo가 유일 스키마
    finally:
        monkeypatch.delenv("HIDDEN_SCHEMAS", raising=False)
        get_settings.cache_clear()


def test_erd_empty_catalog_is_empty_graph(client):
    body = client.get("/api/erd").json()
    assert body == {"snapshot_id": None, "source_id": MANAGED_MSSQL_SOURCE_ID,
                     "nodes": [], "edges": []}
