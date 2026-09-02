"""감사 로그 조회 API — 노출·권한을 바꾼 조작이 기록에 남는지까지 함께 본다."""

import pytest

from app.config import get_settings

SCHEMA = "dbo"


def _seed(client, load_fixture) -> None:
    sid = client.post("/api/ingest/catalog",
                      json=load_fixture("catalog.json")).json()["snapshot_id"]
    client.post("/api/ingest/view-deps",
                json={**load_fixture("view_deps.json"), "snapshot_id": sid})


@pytest.fixture()
def preview_password(monkeypatch):
    password = "s3cret-preview"
    monkeypatch.setenv("PREVIEW_ADMIN_PASSWORD", password)
    get_settings.cache_clear()
    yield password
    monkeypatch.delenv("PREVIEW_ADMIN_PASSWORD", raising=False)
    get_settings.cache_clear()


def _actions(client, **params) -> list[str]:
    return [item["action"] for item in client.get("/api/admin/audit", params=params)
            .json()["items"]]


def test_empty_before_anything_happens(client):
    body = client.get("/api/admin/audit").json()
    assert body == {"total": 0, "actions": [], "items": []}


def test_preview_allowlist_edits_are_recorded(client, load_fixture, preview_password):
    _seed(client, load_fixture)
    headers = {"X-Preview-Password": preview_password}
    client.post("/api/admin/preview-allowlist", headers=headers, json={"schema": SCHEMA})
    client.delete(f"/api/admin/preview-allowlist/{SCHEMA}", headers=headers)

    body = client.get("/api/admin/audit").json()
    assert body["total"] == 2
    # 최신순 — 해제가 먼저 온다 / newest first
    assert [i["action"] for i in body["items"]] == [
        "preview_allow_remove", "preview_allow_add",
    ]
    # 허용 키가 (소스, 스키마)라 어느 DB를 열었는지까지 남아야 한다 / the source is part of the key
    assert all(i["detail"] == f"source=1 {SCHEMA}" for i in body["items"])


def test_whitelist_edits_are_recorded(client):
    client.post("/api/admin/whitelist", json={"login_id": "hong.gil"})
    client.delete("/api/admin/whitelist/hong.gil")
    assert _actions(client) == ["whitelist_remove", "whitelist_add"]


def test_the_hidden_schema_toggle_is_recorded(client, preview_password, monkeypatch):
    monkeypatch.setenv("HIDDEN_SCHEMAS", SCHEMA)
    get_settings.cache_clear()
    client.put("/api/admin/hidden-schema-render",
               headers={"X-Preview-Password": preview_password}, json={"render": True})

    items = client.get("/api/admin/audit").json()["items"]
    assert items[0]["action"] == "hidden_schema_render_set"
    assert items[0]["detail"] == "true"  # 어느 방향으로 바꿨는지가 남아야 한다

    monkeypatch.delenv("HIDDEN_SCHEMAS", raising=False)
    get_settings.cache_clear()


def test_filtering_by_action(client):
    client.post("/api/admin/whitelist", json={"login_id": "hong.gil"})
    client.delete("/api/admin/whitelist/hong.gil")

    body = client.get("/api/admin/audit", params={"action": "whitelist_add"}).json()
    assert body["total"] == 1
    assert _actions(client, action="whitelist_add") == ["whitelist_add"]
    # actions는 필터와 무관하게 전체를 준다 — 드롭다운이 자기 자신만 남기고 비면 못 돌아온다
    assert body["actions"] == ["whitelist_add", "whitelist_remove"]


def test_paging_reports_the_full_total(client):
    """잘린 목록만 주면 화면이 "이게 전부"라고 거짓말한다 (objects 검색과 같은 이유)."""
    for i in range(5):
        client.post("/api/admin/whitelist", json={"login_id": f"user.{i}"})

    body = client.get("/api/admin/audit", params={"limit": 2, "offset": 2}).json()
    assert body["total"] == 5
    assert len(body["items"]) == 2


def _admin_headers(user: str) -> dict:
    return {"X-Dev-User": user}


@pytest.fixture()
def sysadmins(monkeypatch):
    # auth OFF 개발 모드 — X-Dev-User가 신원, DBV_SYSADMINS로 관리자 지정
    monkeypatch.setenv("DBV_SYSADMINS", "kim.admin,lee.admin")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_filters_by_requested_by_and_detail(client, sysadmins):
    # Arrange: 서로 다른 관리자가 서로 다른 대상을 등록
    client.post("/api/admin/whitelist", headers=_admin_headers("kim.admin"),
                json={"login_id": "hong.gil", "note": ""})
    client.post("/api/admin/whitelist", headers=_admin_headers("lee.admin"),
                json={"login_id": "park.chul", "note": ""})

    # Act / Assert: 요청자 부분일치
    body = client.get("/api/admin/audit", params={"requested_by": "kim"},
                      headers=_admin_headers("kim.admin")).json()
    assert body["total"] == 1
    assert body["items"][0]["requested_by"] == "kim.admin"

    # 대상(detail) 부분일치
    body = client.get("/api/admin/audit", params={"q": "park"},
                      headers=_admin_headers("kim.admin")).json()
    assert body["total"] == 1
    assert body["items"][0]["detail"] == "park.chul"

    # 둘을 함께 걸면 AND — 교집합이 없으면 0
    body = client.get("/api/admin/audit",
                      params={"requested_by": "kim", "q": "park"},
                      headers=_admin_headers("kim.admin")).json()
    assert body["total"] == 0


def test_like_wildcards_are_treated_literally(client, sysadmins):
    # Arrange: 행이 존재하는 상태에서
    client.post("/api/admin/whitelist", headers=_admin_headers("kim.admin"),
                json={"login_id": "hong.gil", "note": ""})

    # Act / Assert: %가 와일드카드로 해석되면 전부 매치되고, 리터럴이면 0건이어야 한다
    body = client.get("/api/admin/audit", params={"q": "%"},
                      headers=_admin_headers("kim.admin")).json()
    assert body["total"] == 0
    # _도 마찬가지 — "hong.gil"에 _가 없으므로 0건
    body = client.get("/api/admin/audit", params={"q": "hong_gil"},
                      headers=_admin_headers("kim.admin")).json()
    assert body["total"] == 0


def test_filters_by_date_range(client, sysadmins):
    # Arrange: 지금 시각으로 한 건 쌓는다
    from datetime import UTC, datetime, timedelta

    client.post("/api/admin/whitelist", headers=_admin_headers("kim.admin"),
                json={"login_id": "hong.gil", "note": ""})
    now = datetime.now(UTC)
    yesterday = (now - timedelta(days=1)).isoformat()
    tomorrow = (now + timedelta(days=1)).isoformat()

    # Act / Assert: [어제, 내일) 안에 있고, [내일, ...)에는 없다 — to는 미포함 상한
    inside = client.get("/api/admin/audit",
                        params={"date_from": yesterday, "date_to": tomorrow},
                        headers=_admin_headers("kim.admin")).json()
    assert inside["total"] == 1
    after = client.get("/api/admin/audit", params={"date_from": tomorrow},
                       headers=_admin_headers("kim.admin")).json()
    assert after["total"] == 0
    before = client.get("/api/admin/audit", params={"date_to": yesterday},
                        headers=_admin_headers("kim.admin")).json()
    assert before["total"] == 0
