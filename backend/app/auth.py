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
from app.session_token import LOCAL_ISSUER, decode_session_token, is_session_secret_configured


@lru_cache(maxsize=1)
def _jwk_client() -> jwt.PyJWKClient:
    return jwt.PyJWKClient(
        f"{get_settings().keycloak_issuer}/protocol/openid-connect/certs"
    )


def _decode_local_session(token: str) -> dict | None:
    """우리가 발급한 토큰이면 완전 검증해 클레임을, 아니면 None을 돌려준다.

    `iss`를 읽으려고 서명 검증 없이 한 번 디코드하는데, 그 결과는 **경로 선택에만** 쓴다.
    신원·권한은 아래 `decode_session_token`이 서명·만료·발급자·알고리즘을 전부 검증한 뒤
    나온 클레임에서만 온다.
    """
    # 서명 키가 없으면 로컬 경로 자체가 존재하지 않는다 — fail-closed를 라이브러리 동작에
    # 맡기지 않고 여기서 명시한다. (SESSION_SECRET_KEY의 기본값이 빈 문자열이라 이 상태가
    # 기본 배포다.)
    if not is_session_secret_configured():
        return None
    try:
        unverified = jwt.decode(token, options={"verify_signature": False})
    except jwt.PyJWTError:
        return None  # 파싱조차 안 되면 Keycloak 경로가 기존과 같은 401을 낸다
    if unverified.get("iss") != LOCAL_ISSUER:
        return None
    return decode_session_token(token)


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
        local_claims = _decode_local_session(token)
    except jwt.PyJWTError as exc:
        raise HTTPException(
            status_code=401, detail={"message": f"invalid token: {exc}"}
        ) from exc
    if local_claims is not None:
        username = local_claims.get("sub")
        if not username:
            raise HTTPException(status_code=401,
                                detail={"message": "token has no subject"})
        return username
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


def require_preview_admin(
    x_preview_password: str | None = Header(default=None, alias="X-Preview-Password"),
) -> None:
    """미리보기 허용 목록 수정 게이트 — 환경변수 비밀번호 / password gate for allowlist edits.

    관리자 로그인(require_sysadmin) 위에 얹는 두 번째 잠금이다: 이 목록을 바꾸는 건
    실 데이터가 화면에 나가는 범위를 바꾸는 조작이라, 열린 관리 세션만으로는
    수정되지 않게 한다. 미설정 배포는 열어두는 대신 수정 자체를 막는다.
    """
    settings = get_settings()
    if not settings.preview_admin_password:
        raise HTTPException(status_code=503, detail={
            "message": "PREVIEW_ADMIN_PASSWORD is not configured — set it in .env and "
                       "restart the backend to edit the preview allowlist",
        })
    # 상수 시간 비교 — 타이밍 부채널 방지 / constant-time compare, no timing oracle
    supplied = (x_preview_password or "").encode()
    if not secrets.compare_digest(supplied, settings.preview_admin_password.encode()):
        raise HTTPException(status_code=401, detail={
            "message": "invalid preview admin password",
        })


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
