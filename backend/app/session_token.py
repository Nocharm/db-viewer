"""Locally issued session tokens. / 백엔드 자체 발급 세션 토큰 (LDAP 로그인용).

Keycloak 토큰과 같은 `Authorization: Bearer` 자리에 실려서 `get_current_user`가 `iss`로
검증 경로를 고른다. 알고리즘을 고정하는 것이 이 모듈의 급소다 — 고정하지 않으면 공격자가
`iss`만 맞춘 토큰을 다른 알고리즘으로 서명해 넣을 수 있다.
"""

from datetime import UTC, datetime, timedelta

import jwt

from app.config import get_settings

# 우리가 발급한 토큰의 표식 — Keycloak 토큰과 갈라내는 유일한 기준
LOCAL_ISSUER = "db-viewer"
_ALGORITHM = "HS256"


def is_session_secret_configured() -> bool:
    return bool(get_settings().session_secret_key)


def issue_session_token(login_id: str, name: str | None) -> tuple[str, datetime]:
    """토큰과 만료 시각을 함께 돌려준다 / the token and when it dies."""
    settings = get_settings()
    if not settings.session_secret_key:
        raise RuntimeError(
            "SESSION_SECRET_KEY is not configured — set it in .env and restart the "
            "backend to enable LDAP login"
        )
    issued_at = datetime.now(UTC)
    expires_at = issued_at + timedelta(hours=settings.session_ttl_hours)
    token = jwt.encode(
        {"iss": LOCAL_ISSUER, "sub": login_id, "name": name,
         "iat": issued_at, "exp": expires_at},
        settings.session_secret_key, algorithm=_ALGORITHM,
    )
    return token, expires_at


def decode_session_token(token: str) -> dict:
    """완전 검증 — 서명·만료·발급자·알고리즘 / full verification, algorithm pinned."""
    return jwt.decode(
        token, get_settings().session_secret_key,
        # 이 리스트를 지우면 알고리즘 혼동이 열린다 — 테스트가 지키고 있다
        algorithms=[_ALGORITHM], issuer=LOCAL_ISSUER,
    )
