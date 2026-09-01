"""Query API tests — search, view lineage, diff. / 조회 API 테스트."""

import copy


def _seed(client, load_fixture) -> int:
    sid = client.post("/api/ingest/catalog", json=load_fixture("catalog.json")).json()["snapshot_id"]
    res = client.post("/api/ingest/view-deps",
                      json={**load_fixture("view_deps.json"), "snapshot_id": sid})
    assert res.status_code == 200
    return sid


def _find_object(client, name: str, type_filter: str | None = None) -> dict:
    params = {"q": name}
    if type_filter:
        params["type"] = type_filter
    items = client.get("/api/objects", params=params).json()["items"]
    return next(i for i in items if i["name"] == name)


def test_search_filters_by_name_and_type(client, load_fixture):
    _seed(client, load_fixture)
    res = client.get("/api/objects", params={"q": "V_CHAIN"}).json()
    assert res["items"] and all("V_CHAIN" in i["name"] for i in res["items"])
    assert all(i["type"] == "view" for i in res["items"])

    tables_only = client.get("/api/objects", params={"q": "V_CHAIN", "type": "table"}).json()
    assert tables_only["items"] == []


def test_search_reports_total_so_truncation_is_visible(client, load_fixture):
    """items가 잘렸는지 클라이언트가 알 수 있어야 한다 — 조용한 절단은 목록을 거짓말하게 만든다."""
    _seed(client, load_fixture)
    capped = client.get("/api/objects", params={"limit": 10}).json()
    assert len(capped["items"]) == 10
    assert capped["total"] > 10  # 실규모(495 객체)에서 잘린 사실이 드러난다

    # total은 필터 적용 후 기준 — 타입 필터를 걸면 그 모집단의 크기다
    views = client.get("/api/objects", params={"limit": 5, "type": "view"}).json()
    assert views["total"] < capped["total"]


def test_search_pages_through_every_object_with_offset(client, load_fixture):
    """offset 페이징으로 전량 수집이 가능해야 한다 — 상한(1000)이 곧 조회 가능 총량이면 안 된다."""
    _seed(client, load_fixture)
    first = client.get("/api/objects", params={"limit": 200, "offset": 0}).json()
    total = first["total"]

    collected = list(first["items"])
    while len(collected) < total:
        page = client.get("/api/objects",
                          params={"limit": 200, "offset": len(collected)}).json()
        assert page["items"], "offset 페이지가 비면 무한 루프 — 페이징이 깨진 것"
        collected.extend(page["items"])

    assert len(collected) == total
    assert len({i["id"] for i in collected}) == total  # 페이지 경계 중복·누락 없음


def test_search_without_ready_snapshot_is_404(client):
    res = client.get("/api/objects", params={"q": "x"})
    assert res.status_code == 404
    assert res.json()["error"]["message"] == "no ready snapshot for this source"


def test_view_lineage_endpoint_cycle_and_chain(client, load_fixture):
    _seed(client, load_fixture)
    cycle = _find_object(client, "V_CYCLE_A", "view")
    body = client.get(f"/api/views/{cycle['id']}/lineage").json()
    assert [r["flag"] for r in body["lineage"]] == ["cycle"]

    chain3 = _find_object(client, "V_CHAIN_03", "view")
    body = client.get(f"/api/views/{chain3['id']}/lineage").json()
    assert body["lineage"] and all(r["depth"] == 3 and r["base"] for r in body["lineage"])


def test_view_lineage_keeps_unresolved_refs(client, load_fixture):
    _seed(client, load_fixture)
    xdb = _find_object(client, "V_XDB_0", "view")
    body = client.get(f"/api/views/{xdb['id']}/lineage").json()
    assert any(u["referenced_database"] == "ERP_LEGACY" for u in body["unresolved_deps"])


def test_view_lineage_on_table_is_404(client, load_fixture):
    _seed(client, load_fixture)
    rel = load_fixture("expected/relations.json")["rows"][0]
    table = _find_object(client, rel["src_object"].split(".", 1)[1], "table")
    assert client.get(f"/api/views/{table['id']}/lineage").status_code == 404


def test_snapshot_diff_detects_drift(client, load_fixture):
    _seed(client, load_fixture)

    catalog = copy.deepcopy(load_fixture("catalog.json"))
    fk_oids = {fk["src_object_id"] for fk in catalog["foreign_keys"]}
    fk_oids |= {fk["tgt_object_id"] for fk in catalog["foreign_keys"]}
    dep_oids = {d["referenced_object_id"] for d in load_fixture("view_deps.json")["deps"]
                if d["referenced_object_id"] is not None}
    view_def_oids = {vd["object_id"] for vd in catalog["view_definitions"]}

    # 아무도 참조하지 않는 테이블 → 제거해도 두 번째 ingest가 깨지지 않는다
    removable = next(
        o for o in catalog["objects"]
        if o["type"] == "table" and o["object_id"] not in fk_oids | dep_oids | view_def_oids
    )
    removed_qname = f"{removable['schema']}.{removable['name']}"
    catalog["objects"] = [o for o in catalog["objects"] if o["object_id"] != removable["object_id"]]
    catalog["columns"] = [c for c in catalog["columns"] if c["object_id"] != removable["object_id"]]
    catalog["key_constraints"] = [
        kc for kc in catalog["key_constraints"] if kc["object_id"] != removable["object_id"]
    ]

    # 다른 테이블에 컬럼 추가 + 타입 변경 / add a column and mutate a type elsewhere
    target = next(o for o in catalog["objects"] if o["type"] == "table")
    target_qname = f"{target['schema']}.{target['name']}"
    catalog["columns"].append({
        "object_id": target["object_id"], "name": "DIFF_NEW_COL", "ordinal": 999,
        "data_type": "int", "max_length": 4, "is_nullable": True, "is_computed": False,
    })
    mutated = next(c for c in catalog["columns"]
                   if c["object_id"] == target["object_id"] and c["name"] != "DIFF_NEW_COL")
    mutated["data_type"] = "nvarchar"

    sid2 = client.post("/api/ingest/catalog", json=catalog).json()["snapshot_id"]
    diff = client.get(f"/api/snapshots/1/diff/{sid2}").json()

    assert removed_qname in diff["objects"]["removed"]
    assert diff["objects"]["added"] == []
    assert f"{target_qname}.DIFF_NEW_COL" in diff["columns"]["added"]
    assert any(ch["column"] == f"{target_qname}.{mutated['name']}"
               and ch["after"]["data_type"] == "nvarchar"
               for ch in diff["columns"]["changed"])
    assert diff["foreign_keys"] == {"added": [], "removed": []}


def test_snapshots_list(client, load_fixture):
    _seed(client, load_fixture)
    items = client.get("/api/snapshots").json()["items"]
    assert len(items) == 1 and items[0]["status"] == "ready"
    assert items[0]["object_count"] > 409
