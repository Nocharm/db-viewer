"""Table-browser endpoints — join keys, detail, preview. / 브라우저 화면 API 테스트."""

import sqlalchemy as sa

from app.models import Base


def _seed(client, load_fixture) -> None:
    sid = client.post("/api/ingest/catalog", json=load_fixture("catalog.json")).json()["snapshot_id"]
    client.post("/api/ingest/view-deps",
                json={**load_fixture("view_deps.json"), "snapshot_id": sid})


def _object_id(client, qname: str) -> int:
    schema, name = qname.split(".", 1)
    items = client.get("/api/objects", params={"q": name, "limit": 1000}).json()["items"]
    return next(i["id"] for i in items if i["schema"] == schema and i["name"] == name)


def test_join_keys_aggregate_fk_and_view_joins(client, load_fixture):
    _seed(client, load_fixture)
    body = client.get("/api/join-keys").json()
    assert body["items"]
    top = body["items"][0]
    assert top["table_count"] >= 2 and top["usage"] >= top["table_count"]
    assert len(top["table_ids"]) == top["table_count"]
    # FK 페어 컬럼이 키로 잡혀야 한다 / an FK pair column must appear
    fk = load_fixture("catalog.json")["foreign_keys"][0]["columns"][0]
    keys = {i["key"] for i in body["items"]}
    assert fk["tgt_column"] in keys or fk["src_column"] in keys


def test_detail_reports_views_similars_and_relations(client, load_fixture):
    _seed(client, load_fixture)
    rel = next(r for r in load_fixture("expected/relations.json")["rows"]
               if r["kind"] == "fk")
    object_id = _object_id(client, rel["tgt_object"])

    body = client.get(f"/api/objects/{object_id}/detail").json()
    assert body["name"] == rel["tgt_object"]
    assert body["column_count"] == len(body["columns"])
    assert any(c["is_pk"] for c in body["columns"])
    # FK 자식이 fk_in에 잡혀야 한다 / the FK child appears as inbound
    assert rel["src_object"] in body["fk_in"]
    # 조인키 마킹 — PK는 항상 조인키 / PK columns are always join keys
    pk = next(c for c in body["columns"] if c["is_pk"])
    assert pk["is_join_key"] is True


def test_detail_using_views_from_lineage(client, load_fixture):
    _seed(client, load_fixture)
    row = next(r for r in load_fixture("expected/lineage_phase1.json")["rows"]
               if r["flag"] is None and r["depth"] == 1)
    object_id = _object_id(client, row["base"])
    body = client.get(f"/api/objects/{object_id}/detail").json()
    names = {v["name"] for v in body["using_views"]}
    assert row["view"] in names


def test_detail_similar_tables_have_rates(client, load_fixture):
    _seed(client, load_fixture)
    # audit 공통 컬럼 덕에 유사 테이블은 대부분 존재 / audit columns make similars common
    rel = load_fixture("expected/relations.json")["rows"][0]
    object_id = _object_id(client, rel["src_object"])
    body = client.get(f"/api/objects/{object_id}/detail").json()
    for s in body["similar_tables"]:
        assert 0.3 <= s["match_rate"] <= 1.0
        assert s["common_columns"] >= 1


def test_preview_filter_by_column_value(client, load_fixture, allow_preview):
    _seed(client, load_fixture)
    rel = load_fixture("expected/relations.json")["rows"][0]
    allow_preview(rel["src_object"])
    object_id = _object_id(client, rel["src_object"])

    plain = client.get(f"/api/objects/{object_id}/preview").json()
    sample_value = str(plain["rows"][0][rel["src_column"]])

    body = client.get(f"/api/objects/{object_id}/preview", params={
        "filter_column": rel["src_column"], "filter_value": sample_value,
    }).json()
    assert body["filter"] == {
        "column": rel["src_column"], "value": sample_value, "mode": "contains",
    }
    assert body["rows"]
    assert all(sample_value in str(row[rel["src_column"]]) for row in body["rows"])

    res = client.get(f"/api/objects/{object_id}/preview",
                     params={"filter_column": "NOPE_COL", "filter_value": "x"})
    assert res.status_code == 400


def test_preview_filter_exact_mode(client, load_fixture, allow_preview):
    """exact는 부분일치가 아니라 정확 일치만 — 값의 접두 부분 문자열로 대비한다."""
    _seed(client, load_fixture)
    rel = load_fixture("expected/relations.json")["rows"][0]
    allow_preview(rel["src_object"])
    object_id = _object_id(client, rel["src_object"])

    plain = client.get(f"/api/objects/{object_id}/preview").json()
    sample_value = str(plain["rows"][0][rel["src_column"]])

    exact = client.get(f"/api/objects/{object_id}/preview", params={
        "filter_column": rel["src_column"], "filter_value": sample_value,
        "filter_mode": "exact",
    }).json()
    assert exact["filter"]["mode"] == "exact"
    assert exact["rows"]
    assert all(str(row[rel["src_column"]]) == sample_value for row in exact["rows"])

    # 부분 문자열(접두)은 contains에선 잡히지만 exact에선 0행이어야 한다
    prefix = sample_value[:-1]
    if prefix and not any(str(r[rel["src_column"]]) == prefix for r in plain["rows"]):
        contains = client.get(f"/api/objects/{object_id}/preview", params={
            "filter_column": rel["src_column"], "filter_value": prefix,
        }).json()
        assert contains["rows"]
        exact_prefix = client.get(f"/api/objects/{object_id}/preview", params={
            "filter_column": rel["src_column"], "filter_value": prefix,
            "filter_mode": "exact",
        }).json()
        assert all(str(row[rel["src_column"]]) == prefix for row in exact_prefix["rows"])


def test_columns_index_covers_tables(client, load_fixture):
    _seed(client, load_fixture)
    body = client.get("/api/objects/columns-index").json()
    total = sum(len(item["columns"]) for item in body["items"])
    assert len(body["items"]) == 409
    assert total >= 9000


def test_preview_caps_masks_and_audits(client, migrated_engine, load_fixture,
                                       allow_preview):
    _seed(client, load_fixture)
    rel = load_fixture("expected/relations.json")["rows"][0]
    allow_preview(rel["src_object"])
    object_id = _object_id(client, rel["src_object"])

    with migrated_engine.begin() as conn:
        col_t = Base.metadata.tables["columns"]
        obj_t = Base.metadata.tables["objects"]
        first_col = conn.execute(
            sa.select(col_t.c.id, col_t.c.name)
            .join(obj_t, col_t.c.object_id == obj_t.c.id)
            .where(obj_t.c.id == object_id).order_by(col_t.c.ordinal).limit(1)
        ).one()
        conn.execute(sa.update(col_t).where(col_t.c.id == first_col.id)
                     .values(masking_policy="full"))

    body = client.get(f"/api/objects/{object_id}/preview").json()
    assert len(body["rows"]) == 20
    assert body["columns"][0] == first_col.name
    assert body["masked_columns"] == [first_col.name]
    assert all(row[first_col.name] == "●●●" for row in body["rows"])
    # 관계 컬럼은 실제 값 집합에서 나온다 / relation columns draw from real value sets
    assert any(row[rel["src_column"]] not in (None, "") for row in body["rows"])

    with migrated_engine.connect() as conn:
        audits = conn.execute(
            sa.select(Base.metadata.tables["audit_logs"])
            .where(Base.metadata.tables["audit_logs"].c.action == "table_preview")
        ).all()
    assert len(audits) == 1 and rel["src_object"] in audits[0].detail


def test_preview_returns_actionable_error_instead_of_synthetic_rows(
    client, load_fixture, monkeypatch, allow_preview,
):
    """실배포(N8N_WEBHOOK_BASE 있음)에서 live가 아니면 합성 행 대신 조치 가능한 503.

    합성 행이 실값처럼 보이면 화면 검증이 오염된다 — 원인·조치를 응답으로 말한다.
    """
    from app.config import get_settings

    _seed(client, load_fixture)
    obj = client.get("/api/objects?q=HR_EMP&type=table&limit=1").json()["items"][0]
    allow_preview(f"{obj['schema']}.{obj['name']}")

    monkeypatch.setenv("N8N_WEBHOOK_BASE", "http://n8n/webhook")
    monkeypatch.setenv("SOURCE_MODE", "fixture")
    get_settings.cache_clear()
    try:
        res = client.get(f"/api/objects/{obj['id']}/preview")
        assert res.status_code == 503
        assert "SOURCE_MODE=live" in res.json()["error"]["message"]
    finally:
        monkeypatch.delenv("N8N_WEBHOOK_BASE", raising=False)
        monkeypatch.delenv("SOURCE_MODE", raising=False)
        get_settings.cache_clear()


def test_preview_limit_is_adjustable_with_hard_cap(client, load_fixture, allow_preview):
    _seed(client, load_fixture)
    obj = client.get("/api/objects?q=HR_EMP&type=table&limit=1").json()["items"][0]
    allow_preview(f"{obj['schema']}.{obj['name']}")

    default = client.get(f"/api/objects/{obj['id']}/preview").json()
    assert default["limit"] == 20 and len(default["rows"]) <= 20

    wide = client.get(f"/api/objects/{obj['id']}/preview?limit=50").json()
    assert wide["limit"] == 50 and len(wide["rows"]) == 50

    # 서버 상한(500) 초과는 422 — 상한 원칙 유지 / hard cap enforced
    assert client.get(f"/api/objects/{obj['id']}/preview?limit=1000").status_code == 422
