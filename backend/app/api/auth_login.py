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

# 추적 대상 상한 — 키가 공격자 입력이라 상한이 없으면 무작위 ID 요청만으로 메모리가 무한히 는다
_SWEEP_THRESHOLD = 1024
_MAX_TRACKED_IDS = 10_000

# 열거 방지 — "없는 사용자"와 "틀린 비밀번호"가 이 하나의 응답을 공유한다
_LOGIN_FAILED = {"message": "login failed — check your ID and password", "context": {}}


class LdapLoginRequest(BaseModel):
    login_id: str = Field(min_length=1, max_length=64)  # 감사 컬럼(String(64))에 맞춘다
    password: str = Field(max_length=200)


def _lockout_key(login_id: str) -> str:
    """잠금 카운터의 키 / the axis the lockout counts on.

    AD의 sAMAccountName은 대소문자를 구분하지 않는다 — 원문을 그대로 키로 쓰면
    `hong.gildong`과 `HONG.GILDONG`이 같은 계정인데 카운터가 따로 생겨,
    대소문자만 바꿔가며 잠금을 무한정 우회할 수 있다.
    """
    return login_id.casefold()


def _sweep_failures(cutoff: float) -> None:
    """만료 항목을 걷어내고, 그래도 상한을 넘으면 가장 오래된 것부터 버린다.

    조회된 키만 정리하면 무작위 ID로 만들어진 항목이 영영 남는다. 홍수 상황에서
    강제 축출은 진행 중인 공격의 카운터를 지울 수 있다 — 프로세스 재기동 시 초기화되는
    것과 같은 급의 알려진 한계이며, 무한 증가보다 이쪽을 택한다.
    """
    for key in [k for k, ats in _failures.items() if all(at <= cutoff for at in ats)]:
        del _failures[key]
    if len(_failures) > _MAX_TRACKED_IDS:
        oldest = sorted(_failures, key=lambda k: max(_failures[k]))
        for key in oldest[: len(_failures) - _MAX_TRACKED_IDS]:
            del _failures[key]


def _recent_failures(key: str) -> list[float]:
    cutoff = time.monotonic() - _FAILURE_WINDOW_SECONDS
    if len(_failures) > _SWEEP_THRESHOLD:
        _sweep_failures(cutoff)
    kept = [at for at in _failures.get(key, []) if at > cutoff]
    if kept:
        _failures[key] = kept
    else:
        _failures.pop(key, None)
    return kept


def _record_failure(key: str) -> None:
    _failures.setdefault(key, []).append(time.monotonic())


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

    # login_id 원문은 LDAP 검색·감사 로그에 그대로 쓴다 — 잠금 카운터만 대소문자를 접어서 판단
    login_id = req.login_id.strip()
    lockout_key = _lockout_key(login_id)
    if len(_recent_failures(lockout_key)) >= _MAX_FAILURES:
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
        _record_failure(lockout_key)
        db.add(AuditLog(action="ldap_login", detail=f"{login_id} fail",
                        requested_by=login_id, requested_at=now))
        # get_db가 예외에서 롤백하므로 감사 행을 먼저 커밋한다 (sources.py와 같은 이유)
        db.commit()
        raise HTTPException(401, _LOGIN_FAILED)

    _failures.pop(lockout_key, None)
    token, expires_at = issue_session_token(login_id, user.name)
    db.add(AuditLog(action="ldap_login", detail=f"{login_id} ok",
                    requested_by=login_id, requested_at=now))
    return {
        "access_token": token, "token_type": "bearer",
        "expires_at": expires_at.isoformat(),
        "login_id": login_id, "name": user.name,
    }
