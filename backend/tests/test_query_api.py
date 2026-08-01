"""Query API tests — search, graph expansion, lineage, diff. / 조회 API 테스트."""

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
    res = client.get("/api/objects", params={"q": "CHAIN"}).json()
    assert res["items"] and all("CHAIN" in i["name"] for i in res["items"])
    assert all(i["type"] == "view" for i in res["items"])

    tables_only = client.get("/api/objects", params={"q": "CHAIN", "type": "table"}).json()
    assert tables_only["items"] == []


def test_search_without_ready_snapshot_is_404(client):
    res = client.get("/api/objects", params={"q": "x"})
    assert res.status_code == 404
    assert res.json()["error"]["message"] == "no ready snapshot"


def test_graph_depth1_returns_fk_neighborhood(client, load_fixture):
    _seed(client, load_fixture)
    rel = load_fixture("expected/relations.json")["rows"][0]
    src_name = rel["src_object"].split(".", 1)[1]
    anchor = _find_object(client, src_name, "table")

    graph = client.get(f"/api/objects/{anchor['id']}/graph", params={"depth": 1}).json()
    node_ids = {n["id"] for n in graph["nodes"]}
    assert anchor["id"] in node_ids
    assert len(node_ids) > 1  # FK 이웃 포함 / includes FK neighbors
    for e in graph["edges"]:
        assert e["src_object_id"] in node_ids and e["tgt_object_id"] in node_ids
    fk_edges = [e for e in graph["edges"] if e["kind"] == "fk"]
    assert fk_edges and all(e["columns"] for e in fk_edges)


def test_graph_depth2_is_superset_of_depth1(client, load_fixture):
    _seed(client, load_fixture)
    rel = load_fixture("expected/relations.json")["rows"][0]
    anchor = _find_object(client, rel["src_object"].split(".", 1)[1], "table")
    d1 = client.get(f"/api/objects/{anchor['id']}/graph", params={"depth": 1}).json()
    d2 = client.get(f"/api/objects/{anchor['id']}/graph", params={"depth": 2}).json()
    assert {n["id"] for n in d1["nodes"]} <= {n["id"] for n in d2["nodes"]}


def test_graph_depth_is_capped(client, load_fixture):
    _seed(client, load_fixture)
    anchor = _find_object(client, "V_CHAIN_01", "view")
    assert client.get(f"/api/objects/{anchor['id']}/graph", params={"depth": 5}).status_code == 422


def test_graph_on_view_has_lineage_edges(client, load_fixture):
    _seed(client, load_fixture)
    anchor = _find_object(client, "V_CHAIN_05", "view")
    graph = client.get(f"/api/objects/{anchor['id']}/graph", params={"depth": 1}).json()
    vl = [e for e in graph["edges"] if e["kind"] == "view_lineage"
          and e["src_object_id"] == anchor["id"]]
    assert vl and vl[0]["columns"]  # base table로 향하는 lineage 엣지


def test_graph_flagged_view_carries_lineage_flag(client, load_fixture):
    _seed(client, load_fixture)
    anchor = _find_object(client, "V_CHAIN_12", "view")
    graph = client.get(f"/api/objects/{anchor['id']}/graph").json()
    me = next(n for n in graph["nodes"] if n["id"] == anchor["id"])
    assert me["lineage_flag"] == "depth_exceeded"


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
