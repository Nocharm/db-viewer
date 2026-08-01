"""T2 validation endpoint tests over fixture data. / T2 검증 엔드포인트 픽스처 테스트."""

import pytest
import sqlalchemy as sa

from app.adapters.fake_validator import FakeJoinValidator
from app.api.validate import get_join_validator
from app.models import Base


@pytest.fixture()
def vclient(client, fixture_dir):
    """검증기를 픽스처 값 집합으로 주입한 클라이언트 / client with the fake validator bound."""
    client.app.dependency_overrides[get_join_validator] = lambda: FakeJoinValidator(
        fixture_dir / "value_sets.json"
    )
    return client


def _seed(client, load_fixture) -> None:
    sid = client.post("/api/ingest/catalog", json=load_fixture("catalog.json")).json()["snapshot_id"]
    client.post("/api/ingest/view-deps",
                json={**load_fixture("view_deps.json"), "snapshot_id": sid})


def _column_id(engine, object_qname: str, column: str) -> int:
    schema, table = object_qname.split(".", 1)
    obj_t, col_t = Base.metadata.tables["objects"], Base.metadata.tables["columns"]
    with engine.connect() as conn:
        return conn.execute(
            sa.select(col_t.c.id)
            .join(obj_t, col_t.c.object_id == obj_t.c.id)
            .where(obj_t.c.schema == schema, obj_t.c.name == table, col_t.c.name == column)
        ).scalar_one()


def _pick_relation(load_fixture, **filters):
    for rel in load_fixture("expected/relations.json")["rows"]:
        if all(rel[k] == v for k, v in filters.items()):
            return rel
    raise AssertionError(f"no relation matching {filters}")


def test_containment_records_history_and_relation(vclient, migrated_engine, load_fixture):
    _seed(vclient, load_fixture)
    rel = _pick_relation(load_fixture, kind="real_no_fk", orphan_count=0)
    src_id = _column_id(migrated_engine, rel["src_object"], rel["src_column"])
    tgt_id = _column_id(migrated_engine, rel["tgt_object"], rel["tgt_column"])

    body = vclient.post("/api/validate/containment", json={
        "src_column_id": src_id, "tgt_column_id": tgt_id, "triggered_by": "test",
    }).json()

    assert body["containment"] == 1.0
    assert body["cardinality"] == "1:N"
    assert body["observations"] == 1
    assert body["observed_at"]

    with migrated_engine.connect() as conn:
        history = conn.execute(
            sa.select(Base.metadata.tables["join_validation_history"])
        ).all()
        assert len(history) == 1 and history[0].triggered_by == "test"
        relation = conn.execute(sa.select(Base.metadata.tables["relations"])).one()
        assert relation.status == "validated"
        assert relation.confidence == body["confidence"]
        # 관측치로 distinct_count 채움 / observed stats fill the catalog
        col_t = Base.metadata.tables["columns"]
        distinct = conn.execute(
            sa.select(col_t.c.distinct_count).where(col_t.c.id == src_id)
        ).scalar_one()
        assert distinct == body["src_distinct"]


def test_repeat_validation_accumulates_confidence(vclient, migrated_engine, load_fixture):
    _seed(vclient, load_fixture)
    rel = _pick_relation(load_fixture, kind="real_no_fk", orphan_count=0)
    payload = {
        "src_column_id": _column_id(migrated_engine, rel["src_object"], rel["src_column"]),
        "tgt_column_id": _column_id(migrated_engine, rel["tgt_object"], rel["tgt_column"]),
    }
    first = vclient.post("/api/validate/containment", json=payload).json()
    second = vclient.post("/api/validate/containment", json=payload).json()
    assert second["observations"] == 2
    assert second["confidence"] > first["confidence"]

    history = vclient.get("/api/validate/history", params={
        "src_column_id": payload["src_column_id"], "tgt_column_id": payload["tgt_column_id"],
    }).json()
    assert len(history["items"]) == 2


def test_orphan_relation_reports_orphans(vclient, migrated_engine, load_fixture):
    _seed(vclient, load_fixture)
    rel = next(r for r in load_fixture("expected/relations.json")["rows"]
               if r["orphan_count"] > 0)
    body = vclient.post("/api/validate/containment", json={
        "src_column_id": _column_id(migrated_engine, rel["src_object"], rel["src_column"]),
        "tgt_column_id": _column_id(migrated_engine, rel["tgt_object"], rel["tgt_column"]),
    }).json()
    assert body["orphan_count"] == rel["orphan_count"]
    assert body["containment"] < 1.0


def test_validated_relation_appears_as_inferred_edge(vclient, migrated_engine, load_fixture):
    _seed(vclient, load_fixture)
    rel = _pick_relation(load_fixture, kind="real_no_fk", orphan_count=0)
    src_id = _column_id(migrated_engine, rel["src_object"], rel["src_column"])
    tgt_id = _column_id(migrated_engine, rel["tgt_object"], rel["tgt_column"])
    vclient.post("/api/validate/containment", json={
        "src_column_id": src_id, "tgt_column_id": tgt_id,
    })

    _, table = rel["src_object"].split(".", 1)
    items = vclient.get("/api/objects", params={"q": table}).json()["items"]
    anchor = next(i for i in items if f"{i['schema']}.{i['name']}" == rel["src_object"])
    graph = vclient.get(f"/api/objects/{anchor['id']}/graph").json()

    inferred = [e for e in graph["edges"] if e["kind"] == "inferred"]
    assert inferred
    edge = inferred[0]
    assert edge["confidence"] is not None
    assert edge["last_verified_at"]
    assert edge["columns"] == [{"src_column": rel["src_column"], "tgt_column": rel["tgt_column"]}]


def test_containment_on_column_without_data_is_404(vclient, migrated_engine, load_fixture):
    _seed(vclient, load_fixture)
    # 값 집합이 없는 일반 컬럼 (관계 비관련) / a column with no value set
    with migrated_engine.connect() as conn:
        obj_t, col_t = Base.metadata.tables["objects"], Base.metadata.tables["columns"]
        row = conn.execute(
            sa.select(col_t.c.id)
            .join(obj_t, col_t.c.object_id == obj_t.c.id)
            .where(col_t.c.name == "REG_DT")
            .limit(1)
        ).first()
    res = vclient.post("/api/validate/containment", json={
        "src_column_id": row.id, "tgt_column_id": row.id,
    })
    assert res.status_code == 404
    assert "no value data" in res.json()["error"]["message"]
