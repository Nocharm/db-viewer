"""로컬 세션 토큰 발급·검증. / locally issued session tokens."""

from datetime import UTC, datetime, timedelta

import jwt
import pytest

from app.config import get_settings
from app.session_token import (
    LOCAL_ISSUER,
    decode_session_token,
    is_session_secret_configured,
    issue_session_token,
)


@pytest.fixture()
def session_key(monkeypatch):
    # Arrange: 서명 키를 설정에 주입 (lru_cache된 settings를 비운다)
    monkeypatch.setenv("SESSION_SECRET_KEY", "test-signing-key-not-a-real-secret")
    monkeypatch.setenv("SESSION_TTL_HOURS", "12")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_issue_and_decode_roundtrip(session_key):
    # Act
    token, expires_at = issue_session_token("hong.gildong", "홍길동")
    claims = decode_session_token(token)

    # Assert
    assert claims["sub"] == "hong.gildong"
    assert claims["name"] == "홍길동"
    assert claims["iss"] == LOCAL_ISSUER
    # 만료는 발급 시각 + TTL — 12시간 뒤 언저리
    assert timedelta(hours=11) < expires_at - datetime.now(UTC) < timedelta(hours=13)


def test_expired_token_is_rejected(session_key):
    # Arrange: 이미 만료된 토큰을 직접 만든다
    past = datetime.now(UTC) - timedelta(hours=1)
    token = jwt.encode(
        {"iss": LOCAL_ISSUER, "sub": "hong.gildong", "name": None,
         "iat": past - timedelta(hours=12), "exp": past},
        get_settings().session_secret_key, algorithm="HS256",
    )

    # Act / Assert
    with pytest.raises(jwt.ExpiredSignatureError):
        decode_session_token(token)


def test_token_signed_with_another_key_is_rejected(session_key):
    # Arrange
    token = jwt.encode(
        {"iss": LOCAL_ISSUER, "sub": "hong.gildong",
         "iat": datetime.now(UTC), "exp": datetime.now(UTC) + timedelta(hours=1)},
        "a-different-key", algorithm="HS256",
    )

    # Act / Assert
    with pytest.raises(jwt.InvalidSignatureError):
        decode_session_token(token)


def test_rs256_token_claiming_our_issuer_is_rejected(session_key):
    """알고리즘 혼동 회귀 가드 (스펙 테스트 전략) — 고전적 RS256→HS256 혼동을 막는지."""
    # Arrange: 공격자가 자기 RSA 키로 서명하고 iss만 우리 것으로 주장한다
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    attacker_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = attacker_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    token = jwt.encode(
        {"iss": LOCAL_ISSUER, "sub": "attacker",
         "iat": datetime.now(UTC), "exp": datetime.now(UTC) + timedelta(hours=1)},
        pem, algorithm="RS256",
    )

    # Act / Assert: algorithms=["HS256"] 고정이 없으면 이 토큰이 통과한다
    with pytest.raises(jwt.InvalidAlgorithmError):
        decode_session_token(token)


def test_another_hmac_algorithm_is_rejected(session_key):
    """같은 키·다른 HMAC 알고리즘도 막힌다 — 고정이 리스트지 접두어가 아님을 확인."""
    # Arrange
    token = jwt.encode(
        {"iss": LOCAL_ISSUER, "sub": "attacker",
         "iat": datetime.now(UTC), "exp": datetime.now(UTC) + timedelta(hours=1)},
        get_settings().session_secret_key, algorithm="HS512",
    )

    # Act / Assert
    with pytest.raises(jwt.InvalidAlgorithmError):
        decode_session_token(token)


def test_wrong_issuer_is_rejected(session_key):
    # Arrange
    token = jwt.encode(
        {"iss": "somebody-else", "sub": "hong.gildong",
         "iat": datetime.now(UTC), "exp": datetime.now(UTC) + timedelta(hours=1)},
        get_settings().session_secret_key, algorithm="HS256",
    )

    # Act / Assert
    with pytest.raises(jwt.InvalidIssuerError):
        decode_session_token(token)


def test_refuses_to_issue_without_a_key(monkeypatch):
    # Arrange: 키 미설정 — 약한 기본키로 조용히 서명하는 경로가 없어야 한다
    monkeypatch.setenv("SESSION_SECRET_KEY", "")
    get_settings.cache_clear()

    # Act / Assert
    assert is_session_secret_configured() is False
    with pytest.raises(RuntimeError):
        issue_session_token("hong.gildong", None)
    get_settings.cache_clear()
