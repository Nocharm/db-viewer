"""LDAP login endpoint. / LDAP 자격증명 로그인 (Keycloak과 병행).

백엔드가 직접 LDAP에 바인드하고 자체 토큰을 발급한다 — Keycloak에 얹으면 그것이 죽었을 때
폴백도 함께 죽는다. 화이트리스트·sysadmin 게이트는 `get_current_user` 하류라 여기서 따로
챙기지 않는다: 토큰만 받고 실제 권한은 매 요청에서 판정된다.
"""

import logging
import time
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from ldap3.core.exceptions import LDAPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.ad import client as ad_client
from app.config import get_settings
from app.db import get_db
from app.models import AuditLog
from app.session_token import is_session_secret_configured, issue_session_token

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])

# 실패 잠금 — 축은 login_id 하나다. 백엔드가 프론트 프록시 뒤라 클라이언트 IP를 볼 수 없어
# IP축은 전원 잠금이 되거나 X-Forwarded-For 위조로 우회된다 (설계 §A.4).
# 한계: 프로세스 재기동 시 초기화되고 다중 인스턴스에서 공유되지 않는다.
_FAILURE_WINDOW_SECONDS = 900
_MAX_FAILURES = 5
_failures: dict[str, list[float]] = {}

# 열거 방지 — "없는 사용자"와 "틀린 비밀번호"가 이 하나의 응답을 공유한다
_LOGIN_FAILED = {"message": "login failed — check your ID and password", "context": {}}


class LdapLoginRequest(BaseModel):
    login_id: str = Field(min_length=1, max_length=100)
    password: str = Field(max_length=200)


def _recent_failures(login_id: str) -> list[float]:
    cutoff = time.monotonic() - _FAILURE_WINDOW_SECONDS
    kept = [at for at in _failures.get(login_id, []) if at > cutoff]
    if kept:
        _failures[login_id] = kept
    else:
        _failures.pop(login_id, None)
    return kept


def _record_failure(login_id: str) -> None:
    _failures.setdefault(login_id, []).append(time.monotonic())


@router.post("/ldap-login")
def login_with_ldap(req: LdapLoginRequest, db: Session = Depends(get_db)) -> dict:
    """LDAP 자격증명으로 로그인하고 세션 토큰을 받는다."""
    settings = get_settings()
    if not settings.ldap_enabled:
        raise HTTPException(503, {
            "message": "LDAP is not configured — set LDAP_URL, LDAP_BIND_DN, "
                       "LDAP_BIND_CREDENTIALS and LDAP_USER_SEARCH_BASE",
            "context": {},
        })
    if not is_session_secret_configured():
        raise HTTPException(503, {
            "message": "SESSION_SECRET_KEY is not configured — set it in .env and "
                       "restart the backend to enable LDAP login",
            "context": {},
        })

    login_id = req.login_id.strip()
    if len(_recent_failures(login_id)) >= _MAX_FAILURES:
        raise HTTPException(
            429, {"message": "too many failed attempts — try again later", "context": {}},
            headers={"Retry-After": str(_FAILURE_WINDOW_SECONDS)},
        )

    try:
        user = ad_client.fetch_user(login_id)
        # 빈 비밀번호는 여기서도 막는다 — verify_credentials 내부 가드에만 기대면, 그 함수가
        # 언젠가 바뀌거나(혹은 테스트처럼 대체되어) 가드가 빠졌을 때 조용히 뚫린다 (RFC 4513 무인증 바인드)
        verified = (
            bool(req.password) and user is not None
            and ad_client.verify_credentials(user.dn, req.password)
        )
    except LDAPException as e:
        # 자격증명 실패와 구분한다 — 사용자를 헛되이 재시도시키지 않는다.
        # 드라이버 원문은 로그로만 (objects.py·sources.py와 같은 관용).
        logger.warning("ldap login transport failure",
                       extra={"login_id": login_id, "error_type": type(e).__name__},
                       exc_info=True)
        raise HTTPException(503, {
            "message": "could not reach the authentication server",
            "context": {"error_type": type(e).__name__},
        }) from e

    now = datetime.now(UTC)
    if not verified:
        _record_failure(login_id)
        db.add(AuditLog(action="ldap_login", detail=f"{login_id} fail",
                        requested_by=login_id, requested_at=now))
        # get_db가 예외에서 롤백하므로 감사 행을 먼저 커밋한다 (sources.py와 같은 이유)
        db.commit()
        raise HTTPException(401, _LOGIN_FAILED)

    _failures.pop(login_id, None)
    token, expires_at = issue_session_token(login_id, user.name)
    db.add(AuditLog(action="ldap_login", detail=f"{login_id} ok",
                    requested_by=login_id, requested_at=now))
    return {
        "access_token": token, "token_type": "bearer",
        "expires_at": expires_at.isoformat(),
        "login_id": login_id, "name": user.name,
    }
