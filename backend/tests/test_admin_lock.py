"""관리 잠금 검증 엔드포인트 — 비밀번호만 확인하고 아무것도 바꾸지 않는다.
Admin lock verify: password check with no side effects."""

import pytest

from app.config import get_settings


@pytest.fixture()
def preview_password(monkeypatch):
    """test_preview_allowlist와 같은 비밀번호 게이트 / same gate as the allowlist tests."""
    password = "s3cret-preview"
    monkeypatch.setenv("PREVIEW_ADMIN_PASSWORD", password)
    get_settings.cache_clear()
    yield password
    monkeypatch.delenv("PREVIEW_ADMIN_PASSWORD", raising=False)
    get_settings.cache_clear()


def test_verify_accepts_the_configured_password(client, preview_password):
    res = client.post("/api/admin/lock/verify",
                      headers={"X-Preview-Password": preview_password})
    assert res.status_code == 200 and res.json() == {"ok": True}


def test_verify_answers_ok_false_for_a_wrong_or_missing_password(client, preview_password):
    """401이 아니다 — 프론트 공통 처리가 401을 세션 만료로 보고 로그인으로 보낸다."""
    missing = client.post("/api/admin/lock/verify")
    assert missing.status_code == 200 and missing.json() == {"ok": False}
    wrong = client.post("/api/admin/lock/verify", headers={"X-Preview-Password": "wrong"})
    assert wrong.status_code == 200 and wrong.json() == {"ok": False}
    # 검증은 게이트를 열지 않는다 — 수정 엔드포인트는 여전히 비밀번호를 요구한다
    assert client.post("/api/admin/preview-allowlist",
                       json={"schema": "dbo"}).status_code == 401


def test_verify_reports_an_unconfigured_password(client):
    """미설정 배포는 잠금 바가 "설정 필요"를 띄우도록 503으로 구분한다."""
    assert client.post("/api/admin/lock/verify",
                       headers={"X-Preview-Password": "any"}).status_code == 503
