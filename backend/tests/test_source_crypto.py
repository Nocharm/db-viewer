"""소스 비밀번호 암·복호화. / source secret encryption."""

import pytest

from app.config import get_settings
from app.sources.crypto import (
    CryptoNotConfigured,
    decrypt_secret,
    encrypt_secret,
    is_crypto_configured,
)


@pytest.fixture()
def configured_key(monkeypatch):
    # Arrange: Fernet 키를 설정에 주입 (lru_cache된 settings를 비운다)
    from cryptography.fernet import Fernet

    monkeypatch.setenv("SOURCE_SECRET_KEY", Fernet.generate_key().decode())
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_encrypt_decrypt_roundtrip(configured_key):
    # Act
    token = encrypt_secret("hunter2")

    # Assert: 저장되는 값에 평문이 남지 않는다
    assert "hunter2" not in token
    assert decrypt_secret(token) == "hunter2"


def test_refuses_without_key(monkeypatch):
    # Arrange: 키 미설정
    monkeypatch.setenv("SOURCE_SECRET_KEY", "")
    get_settings.cache_clear()

    # Act / Assert: 평문 저장으로 흘러가는 대신 명시적으로 거부한다
    assert is_crypto_configured() is False
    with pytest.raises(CryptoNotConfigured):
        encrypt_secret("hunter2")
    get_settings.cache_clear()
