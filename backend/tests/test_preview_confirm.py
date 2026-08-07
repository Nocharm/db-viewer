"""Preview, audit, and confirmation tests. / 미리보기·감사·확정 테스트."""

import pytest
import sqlalchemy as sa

from app.adapters.fake_validator import FakeJoinValidator
from app.api.validate import PREVIEW_LIMIT, get_join_validator
from app.models import Base


@pytest.fixture()
def vclient(client, fixture_dir):
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


def _relation_pair(migrated_engine, load_fixture) -> tuple[dict, dict]:
    rel = next(r for r in load_fixture("expected/relations.json")["rows"]
               if r["kind"] == "real_no_fk" and r["orphan_count"] == 0)
    ids = {
        "src_column_id": _column_id(migrated_engine, rel["src_object"], rel["src_column"]),
        "tgt_column_id": _column_id(migrated_engine, rel["tgt_object"], rel["tgt_column"]),
    }
    return rel, ids


def test_preview_caps_rows_and_writes_audit(vclient, migrated_engine, load_fixture,
                                            allow_preview):
    _seed(vclient, load_fixture)
    rel, ids = _relation_pair(migrated_engine, load_fixture)
    allow_preview(rel["src_object"], rel["tgt_object"])

    body = vclient.post("/api/validate/preview",
                        json={**ids, "requested_by": "tester"}).json()
    assert len(body["rows"]) <= PREVIEW_LIMIT
    key = f"src.{rel['src_column']}"
    assert all(key in row for row in body["rows"])

    with migrated_engine.connect() as conn:
        audit = conn.execute(sa.select(Base.metadata.tables["audit_logs"])).all()
    assert len(audit) == 1
    assert audit[0].action == "preview" and audit[0].requested_by == "tester"
    assert rel["src_object"] in audit[0].detail


def test_preview_applies_masking_policy(vclient, migrated_engine, load_fixture,
                                       allow_preview):
    _seed(vclient, load_fixture)
    rel, ids = _relation_pair(migrated_engine, load_fixture)
    allow_preview(rel["src_object"], rel["tgt_object"])

    with migrated_engine.begin() as conn:  # 마스킹 정책 지정 (계획 §3.5)
        col_t = Base.metadata.tables["columns"]
        conn.execute(sa.update(col_t).where(col_t.c.id == ids["src_column_id"])
                     .values(masking_policy="full"))

    body = vclient.post("/api/validate/preview", json=ids).json()
    key = f"src.{rel['src_column']}"
    assert body["masked_columns"] == [key]
    assert all(row[key] == "●●●" for row in body["rows"])
    # 반대편은 마스킹되지 않는다 / the other side stays readable
    tgt_key = f"tgt.{rel['tgt_column']}"
    assert any(row[tgt_key] != "●●●" for row in body["rows"])


def test_confirm_requires_prior_validation(vclient, migrated_engine, load_fixture):
    _seed(vclient, load_fixture)
    _, ids = _relation_pair(migrated_engine, load_fixture)
    res = vclient.post("/api/relations/confirm", json=ids)
    assert res.status_code == 404
    assert "validation first" in res.json()["error"]["message"]


def test_confirm_promotes_and_survives_revalidation(vclient, migrated_engine, load_fixture):
    _seed(vclient, load_fixture)
    _, ids = _relation_pair(migrated_engine, load_fixture)

    vclient.post("/api/validate/containment", json=ids)
    body = vclient.post("/api/relations/confirm",
                        json={**ids, "confirmed_by": "tester"}).json()
    assert body["status"] == "confirmed"

    # 재검증해도 confirmed 유지 / re-validation never demotes
    vclient.post("/api/validate/containment", json=ids)
    with migrated_engine.connect() as conn:
        relation = conn.execute(sa.select(Base.metadata.tables["relations"])).one()
        assert relation.status == "confirmed"
        audit_actions = [
            a.action for a in conn.execute(sa.select(Base.metadata.tables["audit_logs"])).all()
        ]
    assert "confirm" in audit_actions
    # 읽기 전용 ERD에 confirmed 엣지로 노출되는 것은 test_erd_api.py가 이미 커버한다


def test_pending_lists_candidates_and_maps_ids(vclient, migrated_engine, load_fixture):
    _seed(vclient, load_fixture)
    rel = _pick_relation(load_fixture, kind="real_no_fk", orphan_count=0)
    src_id = _column_id(migrated_engine, rel["src_object"], rel["src_column"])
    tgt_id = _column_id(migrated_engine, rel["tgt_object"], rel["tgt_column"])
    # T2 실행 → status=validated 관계가 생긴다 (기존 containment 플로우 재사용)
    vclient.post("/api/validate/containment",
                 json={"src_column_id": src_id, "tgt_column_id": tgt_id})

    body = vclient.get("/api/relations/pending").json()

    assert body["total"] >= 1
    entry = next(i for i in body["items"]
                 if (i["src_object"], i["src_column"]) == (rel["src_object"], rel["src_column"]))
    assert entry["status"] == "validated"
    assert entry["src_column_id"] == src_id and entry["tgt_column_id"] == tgt_id


def test_pending_excludes_confirmed(vclient, migrated_engine, load_fixture):
    _seed(vclient, load_fixture)
    rel = _pick_relation(load_fixture, kind="real_no_fk", orphan_count=0)
    src_id = _column_id(migrated_engine, rel["src_object"], rel["src_column"])
    tgt_id = _column_id(migrated_engine, rel["tgt_object"], rel["tgt_column"])
    vclient.post("/api/validate/containment",
                 json={"src_column_id": src_id, "tgt_column_id": tgt_id})
    vclient.post("/api/relations/confirm",
                 json={"src_column_id": src_id, "tgt_column_id": tgt_id})

    body = vclient.get("/api/relations/pending").json()
    pairs = [(i["src_object"], i["src_column"]) for i in body["items"]]
    assert (rel["src_object"], rel["src_column"]) not in pairs
