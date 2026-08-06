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
    assert all(i["detail"] == SCHEMA for i in body["items"])


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
