"""Keycloak JWT verification and access gates. / 키클럭 검증·화이트리스트·시스템관리자 게이트.

bpm 패턴 이식: 현재 사용자는 문자열 login_id(preferred_username), 미들웨어 대신
라우터 단위 Depends, AUTH_ENABLED=false면 X-Dev-User 헤더 신뢰(개발·테스트 전용).
"""

import secrets
from functools import lru_cache

import jwt
from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.models import LoginWhitelist


@lru_cache(maxsize=1)
def _jwk_client() -> jwt.PyJWKClient:
    return jwt.PyJWKClient(
        f"{get_settings().keycloak_issuer}/protocol/openid-connect/certs"
    )


def get_current_user(
    authorization: str | None = Header(default=None),
    x_dev_user: str | None = Header(default=None),
) -> str:
    settings = get_settings()
    if not settings.auth_enabled:
        return x_dev_user or settings.dev_user  # 헤더는 auth OFF에서만 신뢰

    if authorization is None or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail={"message": "missing bearer token"})
    token = authorization.removeprefix("Bearer ")
    try:
        signing_key = _jwk_client().get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token, signing_key.key, algorithms=["RS256"],
            issuer=settings.keycloak_issuer,
            # 빈 문자열(compose 기본값)도 None과 동일 취급 — 아니면 토큰이 항상 깨진다
            audience=settings.keycloak_audience or None,
            options={"verify_aud": bool(settings.keycloak_audience)},
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(
            status_code=401, detail={"message": f"invalid token: {exc}"}
        ) from exc

    username = claims.get("preferred_username") or claims.get("sub")
    if not username:
        raise HTTPException(status_code=401, detail={"message": "token has no subject"})
    return username


def is_sysadmin(login_id: str) -> bool:
    return login_id in get_settings().sysadmin_login_ids()


def require_whitelisted(
    login_id: str = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> str:
    """화이트리스트 로그인 게이트 — 시스템관리자는 통과 / whitelist gate, sysadmin bypass."""
    settings = get_settings()
    if not settings.auth_enabled or is_sysadmin(login_id):
        return login_id
    if db.get(LoginWhitelist, login_id) is None:
        raise HTTPException(status_code=403, detail={
            "message": "login not whitelisted — ask an admin to add you",
            "context": {"login_id": login_id},
        })
    return login_id


def require_sysadmin(login_id: str = Depends(get_current_user)) -> str:
    # auth OFF는 개발·테스트 전용 모드라 게이트 전체가 의도적으로 열린다 (bpm 동일).
    # 운영 배포는 AUTH_ENABLED=true가 전제 — README 인증 절 참조.
    # the dev-only flag opens every gate by design; production requires AUTH_ENABLED=true
    if get_settings().auth_enabled and not is_sysadmin(login_id):
        raise HTTPException(status_code=403, detail={"message": "system admin only"})
    return login_id


def require_ingest_access(
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
) -> str:
    """n8n 머신 호출용 — API 키 방식 (bpm에는 없어 신규 설계). / machine-caller gate."""
    settings = get_settings()
    if settings.ingest_api_key:
        # 상수 시간 비교 — 타이밍 부채널 방지 / constant-time compare, no timing oracle
        supplied = (x_api_key or "").encode()
        if secrets.compare_digest(supplied, settings.ingest_api_key.encode()):
            return "ingest-key"
        raise HTTPException(status_code=401, detail={"message": "invalid or missing X-API-Key"})
    if not settings.auth_enabled:
        return "dev"  # 키 미설정 + auth OFF = 개발 개방 / open only in dev
    raise HTTPException(status_code=401, detail={
        "message": "ingest requires INGEST_API_KEY to be configured when auth is enabled",
    })
