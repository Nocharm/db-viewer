"""Table-level join-check endpoint tests. / 테이블 단위 조인 검증 테스트."""

import pytest
import sqlalchemy as sa

from app.adapters.fake_validator import FakeJoinValidator
from app.api.join_check import BATCH_TARGET_LIMIT
from app.api.validate import get_join_validator
from app.models import Base


@pytest.fixture()
def vclient(client, fixture_dir):
    client.app.dependency_overrides[get_join_validator] = lambda: FakeJoinValidator(
        fixture_dir / "value_sets.json"
    )
    return client


def _seed(client, load_fixture) -> int:
    sid = client.post("/api/ingest/catalog", json=load_fixture("catalog.json")).json()["snapshot_id"]
    client.post("/api/ingest/view-deps",
                json={**load_fixture("view_deps.json"), "snapshot_id": sid})
    return sid


def _object_id(engine, qname: str) -> int:
    schema, name = qname.split(".", 1)
    obj_t = Base.metadata.tables["objects"]
    with engine.connect() as conn:
        return conn.execute(
            sa.select(obj_t.c.id).where(obj_t.c.schema == schema, obj_t.c.name == name)
        ).scalar_one()


def _no_fk_relation(load_fixture) -> dict:
    for rel in load_fixture("expected/relations.json")["rows"]:
        if rel["kind"] == "real_no_fk" and rel["orphan_count"] == 0:
            return rel
    raise AssertionError("fixture must contain a clean real_no_fk relation")


def test_single_target_check_validates_best_pair(vclient, migrated_engine, load_fixture):
    _seed(vclient, load_fixture)
    rel = _no_fk_relation(load_fixture)
    src_id = _object_id(migrated_engine, rel["src_object"])
    tgt_id = _object_id(migrated_engine, rel["tgt_object"])

    body = vclient.post(f"/api/objects/{src_id}/join-check",
                        json={"target_object_id": tgt_id}).json()

    assert body["object"] == rel["src_object"]
    assert body["target"] == rel["tgt_object"]
    assert len(body["checked"]) == 1
    item = body["checked"][0]
    assert item["target_object"] == rel["tgt_object"]
    assert item["src_column"] == rel["src_column"]
    assert item["tgt_column"] == rel["tgt_column"]
    assert item["containment"] == 1.0
    assert item["pattern"]

    # 관측이 이력·관계로 기록된다 / observation lands in history and relations
    with migrated_engine.connect() as conn:
        history = conn.execute(
            sa.select(Base.metadata.tables["join_validation_history"])
        ).all()
        assert len(history) == 1 and history[0].triggered_by == "table_check"
        relation = conn.execute(sa.select(Base.metadata.tables["relations"])).one()
        assert relation.status == "validated"


def test_batch_check_caps_targets_and_sorts(vclient, migrated_engine, load_fixture):
    _seed(vclient, load_fixture)
    rel = _no_fk_relation(load_fixture)
    src_id = _object_id(migrated_engine, rel["src_object"])

    body = vclient.post(f"/api/objects/{src_id}/join-check", json={}).json()

    total = len(body["checked"]) + len(body["no_data"])
    assert 1 <= total <= BATCH_TARGET_LIMIT
    # 기대 관계 타깃이 일괄 결과에 포함 / expected target appears in the batch
    assert any(item["target_object"] == rel["tgt_object"] for item in body["checked"])
    containments = [item["containment"] for item in body["checked"]]
    assert containments == sorted(containments, reverse=True)


def test_join_check_items_carry_column_ids_for_deep_links(vclient, load_fixture, migrated_engine):
    """결과에서 조인 빌더로 넘어가려면 컬럼 id가 필요하다 / deep links need column ids."""
    _seed(vclient, load_fixture)
    object_id = _object_id(migrated_engine, "dbo.HR_EMP_FAMILY")

    res = vclient.post(f"/api/objects/{object_id}/join-check", json={})

    assert res.status_code == 200
    body = res.json()
    items = body["checked"] + body["no_data"]
    assert items, "픽스처에 조인 후보가 있어야 한다"
    for item in items:
        assert isinstance(item["src_column_id"], int)
        assert isinstance(item["tgt_column_id"], int)


def test_join_check_rejects_views(vclient, migrated_engine, load_fixture):
    _seed(vclient, load_fixture)
    obj_t = Base.metadata.tables["objects"]
    with migrated_engine.connect() as conn:
        view_id = conn.execute(
            sa.select(obj_t.c.id).where(obj_t.c.type == "view").limit(1)
        ).scalar_one()
    assert vclient.post(f"/api/objects/{view_id}/join-check", json={}).status_code == 400
