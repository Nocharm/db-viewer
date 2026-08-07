"""T2 validation endpoint tests over fixture data. / T2 검증 엔드포인트 픽스처 테스트."""

import json as _json

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
    assert body["cardinality"] == "N:1"
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


def test_containment_promotion_clears_stale_rejected_reason(vclient, migrated_engine, load_fixture):
    """rejected 행의 LLM 판정 사유가 validated 승격 후 detail relations에 남지 않아야
    한다 — 승격 근거는 T2 관측 자체이지 이전 LLM 사유가 아니다 (사이클2 리뷰 Finding 2)."""
    from datetime import UTC, datetime

    _seed(vclient, load_fixture)
    rel = _pick_relation(load_fixture, kind="real_no_fk", orphan_count=0)
    src_id = _column_id(migrated_engine, rel["src_object"], rel["src_column"])
    tgt_id = _column_id(migrated_engine, rel["tgt_object"], rel["tgt_column"])

    rel_t = Base.metadata.tables["relations"]
    with migrated_engine.begin() as conn:
        conn.execute(rel_t.insert().values(
            src_object=rel["src_object"], src_column=rel["src_column"],
            tgt_object=rel["tgt_object"], tgt_column=rel["tgt_column"],
            status="rejected", origin="ai", reason="무관", created_at=datetime.now(UTC),
        ))

    vclient.post("/api/validate/containment", json={
        "src_column_id": src_id, "tgt_column_id": tgt_id,
    })

    with migrated_engine.connect() as conn:
        relation = conn.execute(sa.select(rel_t)).one()
    assert relation.status == "validated"
    assert relation.reason is None


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


def _gate_client(client, tmp_path, entries):
    """게이트 전용 클라이언트 — 표본 프로필을 직접 쓴 value_sets로 Fake 주입."""
    path = tmp_path / "gate_value_sets.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_json.dumps({"columns": entries}))
    client.app.dependency_overrides[get_join_validator] = (
        lambda: FakeJoinValidator(path)
    )
    return client


def _typed_column_id(engine, families: tuple[str, ...]) -> tuple[int, str, str]:
    """지정 타입의 아무 테이블 컬럼 하나 — (column_id, qname, column)."""
    obj_t, col_t = Base.metadata.tables["objects"], Base.metadata.tables["columns"]
    with engine.connect() as conn:
        row = conn.execute(
            sa.select(col_t.c.id, obj_t.c.schema, obj_t.c.name, col_t.c.name)
            .join(obj_t, col_t.c.object_id == obj_t.c.id)
            .where(col_t.c.data_type.in_(families), obj_t.c.type == "table")
            .limit(1)
        ).one()
    return row[0], f"{row[1]}.{row[2]}", row[3]


def test_gate_blocks_type_mismatch_without_sampling(vclient, migrated_engine, load_fixture, tmp_path):
    _seed(vclient, load_fixture)
    int_id, _, _ = _typed_column_id(migrated_engine, ("int", "bigint"))
    chr_id, _, _ = _typed_column_id(migrated_engine, ("varchar", "nvarchar", "char", "nchar"))
    client = _gate_client(vclient, tmp_path, [])  # 값 집합 없음 — 샘플 조회가 없어야 통과

    body = client.post("/api/validate/gate",
                       json={"src_column_id": int_id, "tgt_column_id": chr_id}).json()

    assert body["verdict"] == "blocked"
    assert body["reason"] == "type_mismatch"
    assert body["src"]["sample_rows"] is None  # n8n 도달 전 차단 — 샘플 미조회


def test_gate_blocks_when_both_sides_are_dup_heavy(vclient, migrated_engine, load_fixture, tmp_path):
    _seed(vclient, load_fixture)
    rel = _pick_relation(load_fixture, kind="real_no_fk", orphan_count=0)
    src_id = _column_id(migrated_engine, rel["src_object"], rel["src_column"])
    tgt_id = _column_id(migrated_engine, rel["tgt_object"], rel["tgt_column"])
    client = _gate_client(vclient, tmp_path, [
        {"object": rel["src_object"], "column": rel["src_column"],
         "values": [], "row_count": 500, "distinct_count": 4},
        {"object": rel["tgt_object"], "column": rel["tgt_column"],
         "values": [], "row_count": 500, "distinct_count": 9},
    ])

    body = client.post("/api/validate/gate",
                       json={"src_column_id": src_id, "tgt_column_id": tgt_id}).json()

    assert body["verdict"] == "blocked"
    assert body["reason"] == "both_low_distinct"
    assert body["src"]["ratio"] < 0.9 and body["tgt"]["ratio"] < 0.9


def test_gate_passes_when_one_side_is_unique_and_caches(vclient, migrated_engine, load_fixture, tmp_path):
    _seed(vclient, load_fixture)
    rel = _pick_relation(load_fixture, kind="real_no_fk", orphan_count=0)
    src_id = _column_id(migrated_engine, rel["src_object"], rel["src_column"])
    tgt_id = _column_id(migrated_engine, rel["tgt_object"], rel["tgt_column"])
    client = _gate_client(vclient, tmp_path, [
        {"object": rel["src_object"], "column": rel["src_column"],
         "values": [], "row_count": 500, "distinct_count": 4},     # 중복투성이
        {"object": rel["tgt_object"], "column": rel["tgt_column"],
         "values": [], "row_count": 150, "distinct_count": 150},   # 유니크(1:N의 1)
    ])

    first = client.post("/api/validate/gate",
                        json={"src_column_id": src_id, "tgt_column_id": tgt_id}).json()
    assert first["verdict"] == "pass"
    assert first["reason"] is None
    assert first["tgt"]["cached"] is False

    # 두 번째 호출은 캐시 적중 — Fake를 빈 값 집합으로 갈아끼워도 성공해야 한다
    recached = _gate_client(client, tmp_path / "empty", [])
    second = recached.post("/api/validate/gate",
                           json={"src_column_id": src_id, "tgt_column_id": tgt_id}).json()
    assert second["verdict"] == "pass"
    assert second["src"]["cached"] is True and second["tgt"]["cached"] is True


def test_pair_candidates_ranks_matching_columns(vclient, migrated_engine, load_fixture):
    _seed(vclient, load_fixture)
    rel = _pick_relation(load_fixture, kind="real_no_fk", orphan_count=0)
    src_schema, src_name = rel["src_object"].split(".", 1)
    tgt_schema, tgt_name = rel["tgt_object"].split(".", 1)
    obj_t = Base.metadata.tables["objects"]
    with migrated_engine.connect() as conn:
        src_oid = conn.execute(sa.select(obj_t.c.id).where(
            obj_t.c.schema == src_schema, obj_t.c.name == src_name)).scalar_one()
        tgt_oid = conn.execute(sa.select(obj_t.c.id).where(
            obj_t.c.schema == tgt_schema, obj_t.c.name == tgt_name)).scalar_one()

    body = vclient.get("/api/validate/pair-candidates",
                       params={"src_object_id": src_oid, "tgt_object_id": tgt_oid}).json()

    pairs = [(i["src_column"], i["tgt_column"]) for i in body["items"]]
    assert (rel["src_column"], rel["tgt_column"]) in pairs  # 알려진 관계가 후보로 떠야 한다
    scores = [i["score"] for i in body["items"]]
    assert scores == sorted(scores, reverse=True)


def test_pair_candidates_missing_object_is_404(vclient, load_fixture):
    _seed(vclient, load_fixture)
    resp = vclient.get("/api/validate/pair-candidates",
                       params={"src_object_id": 999999, "tgt_object_id": 999998})
    assert resp.status_code == 404
