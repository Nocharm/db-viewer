"""Source secret encryption. / 소스 접속 비밀번호 암·복호화.

키가 없으면 암호화를 건너뛰고 평문을 저장하는 대신 **거부한다** — 조용한 평문 저장이
가장 나쁜 실패 모드다. 키는 배포마다 다르고 .env에만 있다.
"""

from cryptography.fernet import Fernet, InvalidToken

from app.config import get_settings


class CryptoNotConfigured(RuntimeError):
    """SOURCE_SECRET_KEY 미설정 — 소스 접속정보를 저장·복호화할 수 없다."""


def is_crypto_configured() -> bool:
    return bool(get_settings().source_secret_key)


def _get_cipher() -> Fernet:
    key = get_settings().source_secret_key
    if not key:
        raise CryptoNotConfigured(
            "SOURCE_SECRET_KEY is not configured — set it in .env and restart the "
            "backend to register data sources "
            "(generate: python -c \"from cryptography.fernet import Fernet; "
            "print(Fernet.generate_key().decode())\")"
        )
    return Fernet(key.encode())


def encrypt_secret(plain: str) -> str:
    return _get_cipher().encrypt(plain.encode()).decode()


def decrypt_secret(token: str) -> str:
    """복호화 실패는 키 교체를 뜻한다 — 조용히 빈 값을 돌려주지 않는다."""
    try:
        return _get_cipher().decrypt(token.encode()).decode()
    except InvalidToken as e:
        raise CryptoNotConfigured(
            "stored source secret could not be decrypted — SOURCE_SECRET_KEY was "
            "probably rotated; re-enter the password for this source"
        ) from e
