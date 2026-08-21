"""Business-Postgres connection registry. / 업무 Postgres 연결 레지스트리.

연결 정보(표) + 비밀번호 암·복호화 + 미리보기 허용 키 규칙을 한곳에 모은다. 허용 키는
`pg:<slug>:<schema>` — 소스가 여럿이라 스키마 이름만으로는 어느 DB인지 가릴 수 없고,
카탈로그(MSSQL) 스키마와도 섞이면 안 된다.
"""

import base64
import hashlib
import re

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import PgSource, PreviewAllowlist

# 허용 목록 키 접두어 / namespace for allowlist keys
ALLOWLIST_PREFIX = "pg:"
# slug 규칙 — URL·허용 키에 그대로 들어가므로 좁게 잡는다 / conservative: URL and key safe
SLUG_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")


class PgSecretMissing(RuntimeError):
    """`PG_SOURCE_SECRET` 미설정 — 비밀번호를 다룰 수 없다 / no key, no credentials."""


class PgSecretMismatch(RuntimeError):
    """저장된 암호문을 현재 키로 못 연다 — 키가 바뀌었다 / the key changed since it was saved."""


def _fernet(settings: Settings) -> Fernet:
    """설정 문자열에서 Fernet 키 유도 — 운영자가 아무 문장이나 넣어도 되게 한다.

    Fernet은 32바이트 base64 키를 요구하는데, .env에 그 형식을 강제하면 오타로 기동이
    막힌다. SHA-256으로 길이를 맞춰 유도한다(키 자체는 .env에만 존재).
    """
    if not settings.pg_source_secret:
        raise PgSecretMissing(
            "PG_SOURCE_SECRET is not configured — set it in .env and restart the backend "
            "to register or use a Postgres source"
        )
    digest = hashlib.sha256(settings.pg_source_secret.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_password(settings: Settings, password: str) -> str:
    return _fernet(settings).encrypt(password.encode()).decode()


def decrypt_password(settings: Settings, ciphertext: str) -> str:
    try:
        return _fernet(settings).decrypt(ciphertext.encode()).decode()
    except InvalidToken as e:
        raise PgSecretMismatch(
            "stored credentials cannot be decrypted with the current PG_SOURCE_SECRET — "
            "restore the previous value or re-register the source with its password"
        ) from e


def build_dsn(settings: Settings, source: PgSource) -> str:
    """psycopg 접속 문자열 — 비밀번호는 여기서만 평문이 된다 / the only place it is plain."""
    from urllib.parse import quote

    password = quote(decrypt_password(settings, source.password_enc), safe="")
    user = quote(source.username, safe="")
    return (f"postgresql://{user}:{password}@{source.host}:{source.port}"
            f"/{quote(source.database, safe='')}")


def get_source(db: Session, slug: str) -> PgSource | None:
    return db.get(PgSource, slug)


def list_sources(db: Session) -> list[PgSource]:
    return list(db.execute(select(PgSource).order_by(PgSource.label)).scalars())


def allowlist_key(slug: str, schema: str) -> str:
    return f"{ALLOWLIST_PREFIX}{slug}:{schema}"


def is_schema_allowed(db: Session, slug: str, schema: str) -> bool:
    return db.get(PreviewAllowlist, allowlist_key(slug, schema)) is not None


def list_allowed_schemas(db: Session, slug: str) -> list[str]:
    """소스 하나에서 값이 열린 스키마 / schemas whose values are unlocked for one source."""
    prefix = f"{ALLOWLIST_PREFIX}{slug}:"
    keys = db.execute(
        select(PreviewAllowlist.schema).where(PreviewAllowlist.schema.startswith(prefix))
    ).scalars()
    return sorted(key[len(prefix):] for key in keys)
