"""Schema→category mapping tests. / 스키마(DB)별 카테고리 매핑 테스트.

실 스키마는 ATM·BCMS·SAP… 처럼 DB 단위라, 분류 단위도 테이블명이 아니라 스키마다.
매핑이 없는 스키마는 스키마명 자체가 카테고리 — 설정 전에도 목록이 비지 않는다.
"""


def _seed(client, load_fixture) -> None:
    sid = client.post("/api/ingest/catalog", json=load_fixture("catalog.json")).json()["snapshot_id"]
    client.post("/api/ingest/view-deps",
                json={**load_fixture("view_deps.json"), "snapshot_id": sid})


def test_unmapped_schema_defaults_to_its_own_name(client, load_fixture):
    """설정 전에도 스키마별로 분류돼 보인다 — 기본값이 곧 스키마명."""
    _seed(client, load_fixture)
    body = client.get("/api/schema-categories").json()

    by_schema = {item["schema"]: item for item in body["items"]}
    assert "dbo" in by_schema
    assert by_schema["dbo"]["category"] == "dbo"
    assert by_schema["dbo"]["mapped"] is False  # 사용자가 지정한 값이 아님
    assert by_schema["dbo"]["object_count"] > 0


def test_assigning_a_category_moves_the_whole_schema(client, load_fixture):
    """스키마 단위 이동 — 그 DB의 테이블이 통째로 함께 옮겨간다 (일괄 이동)."""
    _seed(client, load_fixture)
    before = client.get("/api/schema-categories").json()
    dbo_count = next(i["object_count"] for i in before["items"] if i["schema"] == "dbo")

    res = client.put("/api/schema-categories/dbo", json={"category": "기간계"})
    assert res.status_code == 200

    after = {i["schema"]: i for i in client.get("/api/schema-categories").json()["items"]}
    assert after["dbo"]["category"] == "기간계"
    assert after["dbo"]["mapped"] is True
    assert after["dbo"]["object_count"] == dbo_count  # 이동해도 소속 테이블 수는 그대로


def test_reassigning_updates_in_place_without_duplicates(client, load_fixture):
    """같은 스키마를 다시 지정하면 갱신 — 행이 늘지 않는다."""
    _seed(client, load_fixture)
    client.put("/api/schema-categories/dbo", json={"category": "A"})
    client.put("/api/schema-categories/dbo", json={"category": "B"})

    items = client.get("/api/schema-categories").json()["items"]
    dbo_rows = [i for i in items if i["schema"] == "dbo"]
    assert len(dbo_rows) == 1
    assert dbo_rows[0]["category"] == "B"


def test_clearing_a_category_falls_back_to_the_schema_name(client, load_fixture):
    """빈 값으로 지정하면 매핑 해제 — 기본값(스키마명)으로 되돌아간다."""
    _seed(client, load_fixture)
    client.put("/api/schema-categories/dbo", json={"category": "기간계"})

    client.put("/api/schema-categories/dbo", json={"category": ""})
    items = {i["schema"]: i for i in client.get("/api/schema-categories").json()["items"]}
    assert items["dbo"]["category"] == "dbo"
    assert items["dbo"]["mapped"] is False


def test_unknown_schema_is_rejected(client, load_fixture):
    """스냅샷에 없는 스키마는 400 — 오타로 유령 매핑이 쌓이지 않게."""
    _seed(client, load_fixture)
    res = client.put("/api/schema-categories/NOPE_SCHEMA", json={"category": "X"})
    assert res.status_code == 400
    assert "schema" in res.json()["error"]["message"]
