"""LDAP 클라이언트 단위 테스트 — 빈 비밀번호 가드. / Unit test for app/ad/client.py's empty-password guard."""

from app.ad import client as ad_client


def test_verify_credentials_rejects_empty_password_before_any_connection(monkeypatch):
    """RFC 4513 무인증 바인드 가드 — Server/Connection을 만들기도 전에 거부해야 한다.

    엔드포인트(auth_login.py)도 같은 가드를 이중으로 갖고 있어 이 함수는 그쪽을 거치지 않고도
    직접 호출될 수 있다 — 이 가드 자체가 무너지면 조용히 뚫리므로 단위 테스트로 고정한다.
    """
    # Arrange: 연결을 시도하면 즉시 실패하게 만든다 — 가드가 사라지면 이 테스트가 터진다
    def _boom(*args, **kwargs):
        raise AssertionError("must not open an LDAP connection for an empty password")

    monkeypatch.setattr(ad_client, "Server", _boom)
    monkeypatch.setattr(ad_client, "Connection", _boom)

    # Act
    result = ad_client.verify_credentials("CN=x,DC=y", "")

    # Assert
    assert result is False
