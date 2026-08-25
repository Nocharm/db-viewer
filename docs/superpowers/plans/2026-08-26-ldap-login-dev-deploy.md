# LDAP 로그인 병행 + 개발 서버 배포 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사용자가 로그인 화면에서 Keycloak과 LDAP 중 골라 로그인할 수 있게 하고, 운영과 완전히
분리된 개발 스택을 다른 포트에 띄울 수 있게 한다.

**Architecture:** 백엔드가 **직접** LDAP에 바인드한다(서비스 계정으로 사용자 검색 → 그 DN으로
사용자 비밀번호 바인드) — Keycloak에 얹으면 Keycloak이 죽었을 때 폴백도 함께 죽기 때문이다.
성공하면 백엔드가 자체 HS256 토큰을 발급하고, `get_current_user`가 토큰의 `iss`로 검증 경로를
고른다. 하류 게이트(화이트리스트·sysadmin)는 손대지 않는다 — 이미 `get_current_user` 아래에 있다.

**Tech Stack:** FastAPI / PyJWT (HS256) / ldap3 / Next.js 15 / TypeScript

**Spec:** `docs/superpowers/specs/2026-08-26-ldap-login-dev-deploy-design.md`

## Global Constraints

- **비밀번호는 어디에도 남기지 않는다** — 응답 본문, 로그, 예외 메시지, 감사 행 전부.
- **알고리즘을 항상 고정한다.** `jwt.decode(..., algorithms=[...])`를 빠뜨리면 `iss`를 주장하는
  다른 알고리즘 토큰이 통과한다. 로컬 `["HS256"]`, Keycloak `["RS256"]`.
- **미검증 디코드 결과는 라우팅에만 쓴다.** 신원·권한은 전부 검증 후 클레임에서 온다.
- **응답에서 "사용자 없음"과 "비밀번호 틀림"이 구분되면 안 된다** — 같은 401, 같은 본문.
- **`HTTPException`을 올리기 전에 `db.commit()`** — `app/db.py:get_db`가 예외에서 롤백하므로
  감사 행이 조용히 사라진다 (`app/api/sources.py`가 같은 이유로 이미 그렇게 한다).
- **`SESSION_SECRET_KEY`가 비면 로그인 503** — 약한 기본키로 서명하는 경로를 만들지 않는다.
- Python: 타입 힌트 필수, `X | None`(`Optional` 금지), 함수명은 동사로 시작, import는
  stdlib → third-party → local 세 그룹.
- TypeScript: `strict`, `any` 금지, named export, `?.`/`??`, `data-testid`는 `ComponentName-role`.
- 주석은 **왜**를 쓴다. 파일 첫 줄에 한 줄 docstring (한/영 병기).
- 테스트는 AAA — `# Arrange` / `# Act` / `# Assert` 주석.
- 커밋: `type(scope): English summary — 한국어 요약` (양쪽 필수). 커밋 직전 `PROGRESS.md` 갱신
  (기존 `## 2026-08-26` 절 안에).
- **`.env`와 `.env.dev`는 절대 커밋하지 않는다.**

**검증 명령**

```bash
cd backend && .venv/bin/python -m pytest -q      # 426 passed / 4 skipped (또는 427/3 — test_scan.py가 시각 의존)
cd backend && .venv/bin/ruff check app tests
cd frontend && npx tsc --noEmit && npm run lint && npx vitest run   # 123 passed
cd frontend && npm run build
```

**베이스라인:** 백엔드 426 passed / 4 skipped, 프론트 123 passed. 이 숫자가 줄면 회귀다.

---

## File Structure

**신규**

| 파일 | 책임 |
|---|---|
| `backend/app/session_token.py` | 로컬 세션 토큰 발급·검증 (순수, IO 없음) |
| `backend/app/api/auth_login.py` | `/api/auth/ldap-login` 엔드포인트 + 실패 잠금 |
| `backend/tests/test_session_token.py` | 토큰 단위 테스트 |
| `backend/tests/test_ldap_login.py` | 엔드포인트 테스트 |
| `frontend/src/lib/session-token.ts` | 브라우저 세션 저장·만료 판정 (순수) |
| `frontend/src/lib/session-token.test.ts` | vitest |
| `docker-compose-dev.yml` | 개발 스택 (독립) |
| `docs/dev-deploy.md` | 개발 서버 런북 |

**수정**

`backend/app/config.py`, `backend/app/ad/client.py`, `backend/app/auth.py`,
`backend/app/main.py`, `frontend/src/app/login/page.tsx`,
`frontend/src/components/providers.tsx`, `frontend/src/lib/api.ts`,
`frontend/Dockerfile`, `docker-compose.yml`, `.env.example`, `.gitignore`, `README.md`

---

## Task 1: 설정 3종 + 세션 토큰 유틸

**Files:**
- Create: `backend/app/session_token.py`, `backend/tests/test_session_token.py`
- Modify: `backend/app/config.py`, `.env.example`, `docker-compose.yml`

**Interfaces:**
- Produces: `LOCAL_ISSUER = "db-viewer"`
- Produces: `is_session_secret_configured() -> bool`
- Produces: `issue_session_token(login_id: str, name: str | None) -> tuple[str, datetime]`
- Produces: `decode_session_token(token: str) -> dict` — 실패 시 `jwt.PyJWTError` 계열을 올린다
- Produces: `Settings.auth_ldap_login_enabled: bool`, `Settings.session_secret_key: str`,
  `Settings.session_ttl_hours: int`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/tests/test_session_token.py`:

```python
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
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd backend && .venv/bin/python -m pytest tests/test_session_token.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.session_token'`

- [ ] **Step 3: 설정 필드를 추가한다**

`backend/app/config.py`의 `Settings`에서 `preview_admin_password` 아래에:

```python
    # Environment: LDAP 로그인 병행 스위치. false면 라우터가 등록되지 않고 프론트 폼도 안 뜬다.
    auth_ldap_login_enabled: bool = False
    # Environment: 로컬 세션 토큰 HS256 서명 키. 비어 있으면 LDAP 로그인이 503 —
    # 약한 기본키로 조용히 서명하는 경로를 만들지 않는다.
    # **운영과 개발이 이 값을 공유하면 개발에서 발급한 토큰이 운영에서 유효해진다.**
    session_secret_key: str = ""
    # Tuning: 세션 수명(시간). 갱신 토큰이 없으므로 이 값이 곧 재로그인 주기다.
    session_ttl_hours: int = 12
```

- [ ] **Step 4: 토큰 모듈을 쓴다**

`backend/app/session_token.py`:

```python
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
```

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `cd backend && .venv/bin/python -m pytest tests/test_session_token.py -q`
Expected: PASS (7 passed)

- [ ] **Step 6: 환경변수 배선**

`.env.example` 끝에:

```bash
# LDAP 로그인 병행 스위치 — true면 로그인 화면에 사번·비밀번호 폼이 뜬다.
# LDAP_* 4종(URL·BIND_DN·BIND_CREDENTIALS·USER_SEARCH_BASE)이 모두 있어야 실제로 동작한다.
AUTH_LDAP_LOGIN_ENABLED=false

# 로컬 세션 토큰 서명 키(HS256). 비어 있으면 LDAP 로그인이 503.
# 생성: python -c "import secrets; print(secrets.token_urlsafe(48))"
# 주의: 운영과 개발이 같은 값을 쓰면 개발에서 발급한 토큰이 운영에서 유효해진다.
SESSION_SECRET_KEY=

# 세션 수명(시간). 갱신 토큰이 없으므로 이 값이 곧 재로그인 주기다.
SESSION_TTL_HOURS=12
```

`docker-compose.yml`의 `backend` 서비스 `environment:`에:

```yaml
      AUTH_LDAP_LOGIN_ENABLED: ${AUTH_LDAP_LOGIN_ENABLED:-false}
      SESSION_SECRET_KEY: ${SESSION_SECRET_KEY}
      SESSION_TTL_HOURS: ${SESSION_TTL_HOURS:-12}
```

- [ ] **Step 7: 회귀 확인**

Run: `cd backend && .venv/bin/python -m pytest -q && .venv/bin/ruff check app tests`
Expected: 433 passed / 4 skipped, ruff 클린

- [ ] **Step 8: 커밋**

`PROGRESS.md`의 `## 2026-08-26` 절에 한 줄 추가한 뒤:

```bash
git add backend/app/session_token.py backend/app/config.py \
        backend/tests/test_session_token.py .env.example docker-compose.yml PROGRESS.md
git commit -m "feat(auth): locally issued session tokens with a pinned algorithm — 세션 토큰 발급·검증"
```

---

## Task 2: 사용자 바인드 + 로그인 엔드포인트 + 실패 잠금

**Files:**
- Create: `backend/app/api/auth_login.py`, `backend/tests/test_ldap_login.py`
- Modify: `backend/app/ad/client.py`, `backend/app/main.py`

**Interfaces:**
- Consumes: `issue_session_token`, `is_session_secret_configured` (Task 1)
- Produces: `app.ad.client.verify_credentials(dn: str, password: str) -> bool`
- Produces: `app.api.auth_login.router` — `POST /api/auth/ldap-login`
- Produces: 모듈 전역 `_failures: dict[str, list[float]]` (테스트가 비운다)

### 반드시 알아야 할 LDAP 함정 — unauthenticated bind

RFC 4513: **DN은 주고 비밀번호를 빈 문자열로 바인드하면 많은 LDAP 서버가 익명 바인드로 처리해
성공을 돌려준다.** `conn.bind()` 결과를 그대로 믿으면 **비밀번호를 비워두는 것만으로 아무 계정이나
로그인된다.** `verify_credentials`가 빈 비밀번호를 **바인드 전에** 거부해야 한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/tests/test_ldap_login.py`:

```python
"""LDAP 로그인 엔드포인트 — 열거 방지·잠금·게이트. / LDAP login endpoint."""

import pytest
from ldap3.core.exceptions import LDAPSocketOpenError

from app.ad.org import RawUser
from app.config import get_settings

USER = RawUser(login_id="hong.gildong", name="홍길동", title=None,
               dn="CN=홍길동,OU=사람,DC=example", uac=512, email=None)


@pytest.fixture()
def ldap_login_on(monkeypatch):
    # Arrange: LDAP 4종 + 서명 키 + 기능 플래그
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("AUTH_LDAP_LOGIN_ENABLED", "true")
    monkeypatch.setenv("SESSION_SECRET_KEY", "test-signing-key-not-a-real-secret")
    monkeypatch.setenv("LDAP_URL", "ldaps://ad.example:636")
    monkeypatch.setenv("LDAP_BIND_DN", "cn=svc")
    monkeypatch.setenv("LDAP_BIND_CREDENTIALS", "pw")
    monkeypatch.setenv("LDAP_USER_SEARCH_BASE", "dc=example")
    get_settings.cache_clear()
    from app.api import auth_login
    auth_login._failures.clear()
    yield
    auth_login._failures.clear()
    get_settings.cache_clear()


def _patch_ldap(monkeypatch, *, user, ok):
    from app.api import auth_login
    monkeypatch.setattr(auth_login.ad_client, "fetch_user", lambda _id: user)
    monkeypatch.setattr(auth_login.ad_client, "verify_credentials", lambda _dn, _pw: ok)


def test_successful_login_returns_a_token(client, ldap_login_on, monkeypatch):
    # Arrange
    _patch_ldap(monkeypatch, user=USER, ok=True)

    # Act
    res = client.post("/api/auth/ldap-login",
                      json={"login_id": "hong.gildong", "password": "correct-horse"})

    # Assert
    assert res.status_code == 200
    body = res.json()
    assert body["login_id"] == "hong.gildong"
    assert body["name"] == "홍길동"
    assert body["token_type"] == "bearer"
    assert body["access_token"]
    # 비밀번호가 어떤 형태로도 응답에 없어야 한다
    assert "correct-horse" not in res.text


def test_unknown_user_and_wrong_password_are_indistinguishable(
    client, ldap_login_on, monkeypatch,
):
    """열거 방지 — 두 실패가 상태·본문에서 구분되면 사번의 존재 여부가 새 나간다."""
    # Arrange / Act: 없는 사용자
    _patch_ldap(monkeypatch, user=None, ok=False)
    missing = client.post("/api/auth/ldap-login",
                          json={"login_id": "nobody.here", "password": "x"})

    # Arrange / Act: 있는 사용자 + 틀린 비밀번호
    from app.api import auth_login
    auth_login._failures.clear()
    _patch_ldap(monkeypatch, user=USER, ok=False)
    wrong = client.post("/api/auth/ldap-login",
                        json={"login_id": "hong.gildong", "password": "x"})

    # Assert
    assert missing.status_code == wrong.status_code == 401
    assert missing.json() == wrong.json()
    assert "nobody.here" not in missing.text


def test_empty_password_never_succeeds(client, ldap_login_on, monkeypatch):
    """빈 비밀번호는 서버가 익명 바인드로 성공시킬 수 있다 — 그 전에 막혀야 한다."""
    # Arrange: 바인드가 True를 돌려주더라도(=서버가 익명 허용) 통과하면 안 된다
    _patch_ldap(monkeypatch, user=USER, ok=True)

    # Act
    res = client.post("/api/auth/ldap-login",
                      json={"login_id": "hong.gildong", "password": ""})

    # Assert
    assert res.status_code == 401


def test_lockout_after_repeated_failures(client, ldap_login_on, monkeypatch):
    # Arrange
    _patch_ldap(monkeypatch, user=USER, ok=False)

    # Act: 5회 실패 후 6번째
    for _ in range(5):
        assert client.post("/api/auth/ldap-login",
                           json={"login_id": "hong.gildong", "password": "x"}
                           ).status_code == 401
    locked = client.post("/api/auth/ldap-login",
                         json={"login_id": "hong.gildong", "password": "x"})

    # Assert
    assert locked.status_code == 429
    assert locked.headers.get("Retry-After")


def test_success_clears_the_failure_counter(client, ldap_login_on, monkeypatch):
    # Arrange: 4회 실패 후 성공
    _patch_ldap(monkeypatch, user=USER, ok=False)
    for _ in range(4):
        client.post("/api/auth/ldap-login",
                    json={"login_id": "hong.gildong", "password": "x"})
    _patch_ldap(monkeypatch, user=USER, ok=True)
    client.post("/api/auth/ldap-login",
                json={"login_id": "hong.gildong", "password": "ok"})

    # Act: 다시 실패해도 잠기지 않아야 한다 (카운터가 비워졌으므로)
    _patch_ldap(monkeypatch, user=USER, ok=False)
    res = client.post("/api/auth/ldap-login",
                      json={"login_id": "hong.gildong", "password": "x"})

    # Assert
    assert res.status_code == 401


def test_transport_failure_is_503_not_401(client, ldap_login_on, monkeypatch):
    """인증 서버에 못 닿는 것과 비밀번호가 틀린 것은 다르다 — 사용자를 헛되이 재시도시키지 않는다."""
    # Arrange
    from app.api import auth_login

    def boom(_id):
        raise LDAPSocketOpenError("connection refused")

    monkeypatch.setattr(auth_login.ad_client, "fetch_user", boom)

    # Act
    res = client.post("/api/auth/ldap-login",
                      json={"login_id": "hong.gildong", "password": "x"})

    # Assert
    assert res.status_code == 503
    assert "connection refused" not in res.text  # 드라이버 원문 미노출


def test_endpoint_is_absent_when_the_flag_is_off(client, monkeypatch):
    """AUTH_LDAP_LOGIN_ENABLED=false면 라우터 자체가 등록되지 않아야 한다."""
    # Arrange: 앱을 플래그 없이 새로 만든다 (라우터 등록은 create_app 시점 결정)
    from fastapi.testclient import TestClient

    monkeypatch.setenv("AUTH_LDAP_LOGIN_ENABLED", "false")
    get_settings.cache_clear()
    from app.main import create_app

    # Act
    with TestClient(create_app()) as off_client:
        res = off_client.post("/api/auth/ldap-login",
                              json={"login_id": "hong.gildong", "password": "x"})

    # Assert
    assert res.status_code == 404
    get_settings.cache_clear()


@pytest.mark.parametrize(
    ("verified", "attempts", "expected_status"),
    [(True, 1, 200), (False, 1, 401), (False, 6, 429)],
)
def test_password_never_appears_in_any_response(
    client, ldap_login_on, monkeypatch, verified, attempts, expected_status,
):
    """성공·실패·잠금 어느 응답에도 비밀번호 원문이 실리면 안 된다 (raw text 검사)."""
    # Arrange
    secret = "correct-horse-battery-staple"
    _patch_ldap(monkeypatch, user=USER, ok=verified)

    # Act
    for _ in range(attempts):
        res = client.post("/api/auth/ldap-login",
                          json={"login_id": "hong.gildong", "password": secret})

    # Assert
    assert res.status_code == expected_status
    assert secret not in res.text


def test_password_is_absent_from_the_503_body(client, ldap_login_on, monkeypatch):
    """422 핸들러가 비밀번호를 되돌려준 전례가 있다 — 503 경로도 확인한다."""
    # Arrange
    from app.api import auth_login

    secret = "correct-horse-battery-staple"

    def boom(_id):
        raise LDAPSocketOpenError("connection refused")

    monkeypatch.setattr(auth_login.ad_client, "fetch_user", boom)

    # Act
    res = client.post("/api/auth/ldap-login",
                      json={"login_id": "hong.gildong", "password": secret})

    # Assert
    assert res.status_code == 503
    assert secret not in res.text


def test_password_is_redacted_from_validation_errors(client, ldap_login_on):
    """422 본문에 비밀번호가 되돌아오지 않는지 — main.py의 _redact_validation_error 가드."""
    # Arrange / Act: password에 잘못된 타입을 보내 422를 유발한다
    res = client.post("/api/auth/ldap-login",
                      json={"login_id": "hong.gildong", "password": 12345678})

    # Assert
    assert res.status_code == 422
    assert "12345678" not in res.text


def test_missing_signing_key_is_503(client, monkeypatch):
    # Arrange: 기능은 켜져 있으나 서명 키가 없다
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("AUTH_LDAP_LOGIN_ENABLED", "true")
    monkeypatch.setenv("SESSION_SECRET_KEY", "")
    monkeypatch.setenv("LDAP_URL", "ldaps://ad.example:636")
    monkeypatch.setenv("LDAP_BIND_DN", "cn=svc")
    monkeypatch.setenv("LDAP_BIND_CREDENTIALS", "pw")
    monkeypatch.setenv("LDAP_USER_SEARCH_BASE", "dc=example")
    get_settings.cache_clear()

    # Act
    res = client.post("/api/auth/ldap-login",
                      json={"login_id": "hong.gildong", "password": "x"})

    # Assert
    assert res.status_code == 503
    get_settings.cache_clear()
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd backend && .venv/bin/python -m pytest tests/test_ldap_login.py -q`
Expected: FAIL — 404 (라우터 없음)

- [ ] **Step 3: 사용자 바인드를 추가한다**

`backend/app/ad/client.py` 끝에:

```python
def verify_credentials(dn: str, password: str) -> bool:
    """사용자 DN으로 바인드해 자격증명을 확인 / bind as the user to verify credentials.

    `_connect()`는 서비스 계정으로 붙지만 여기서는 **사용자 자신으로** 붙는다 — 바인드 성공
    여부가 곧 인증 결과다.

    빈 비밀번호를 바인드 전에 거부하는 이유(RFC 4513): DN은 주고 비밀번호를 비운 바인드를
    다수의 서버가 **익명 바인드로 처리해 성공을 돌려준다**. 그대로 믿으면 비밀번호를
    비워두는 것만으로 아무 계정이나 로그인된다.

    접속 자체가 안 되는 경우(LDAPException)는 여기서 삼키지 않는다 — 호출부가 자격증명
    실패(401)와 인증 서버 장애(503)를 구분해야 하기 때문이다.
    """
    if not password:
        return False
    settings = get_settings()
    use_ssl = settings.ldap_url.lower().startswith("ldaps://")
    needs_tls = use_ssl or settings.ldap_start_tls
    server = Server(
        settings.ldap_url, use_ssl=use_ssl, tls=_make_tls() if needs_tls else None
    )
    conn = Connection(server, user=dn, password=password, auto_bind=False)
    try:
        if settings.ldap_start_tls:
            conn.start_tls()
        return bool(conn.bind())
    finally:
        conn.unbind()
```

- [ ] **Step 4: 엔드포인트를 쓴다**

`backend/app/api/auth_login.py`:

```python
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
        verified = user is not None and ad_client.verify_credentials(user.dn, req.password)
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
```

- [ ] **Step 5: 라우터를 등록한다 — 게이트 없이**

`backend/app/main.py`의 `create_app()`에서, `app.include_router(me.router)` 근처에:

```python
    # 로그인 자체는 어떤 사용자 게이트도 뒤에 둘 수 없다 — 아직 신원이 없기 때문이다.
    # 화이트리스트는 발급된 토큰으로 다른 API를 부를 때 판정된다.
    if get_settings().auth_ldap_login_enabled:
        from app.api import auth_login

        app.include_router(auth_login.router)
```

`from app.config import get_settings`를 import 목록에 추가한다.

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run: `cd backend && .venv/bin/python -m pytest tests/test_ldap_login.py -q`
Expected: PASS (13 passed)

- [ ] **Step 7: 회귀 + 커밋**

Run: `cd backend && .venv/bin/python -m pytest -q && .venv/bin/ruff check app tests`
Expected: 446 passed / 4 skipped

```bash
git add backend/app/api/auth_login.py backend/app/ad/client.py backend/app/main.py \
        backend/tests/test_ldap_login.py PROGRESS.md
git commit -m "feat(auth): LDAP credential login endpoint with lockout — LDAP 로그인 엔드포인트"
```

---

## Task 3: `get_current_user` 분기

**Files:**
- Modify: `backend/app/auth.py`
- Test: `backend/tests/test_ldap_login.py` (추가)

**Interfaces:**
- Consumes: `decode_session_token`, `LOCAL_ISSUER` (Task 1)
- Produces: `get_current_user`가 로컬 토큰과 Keycloak 토큰을 모두 받는다 (시그니처 불변)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/tests/test_ldap_login.py`에 이어붙인다:

```python
def test_issued_token_authenticates_subsequent_requests(client, ldap_login_on, monkeypatch):
    # Arrange: 로그인해서 토큰을 받는다
    _patch_ldap(monkeypatch, user=USER, ok=True)
    token = client.post("/api/auth/ldap-login",
                        json={"login_id": "hong.gildong", "password": "ok"}
                        ).json()["access_token"]

    # Act: 그 토큰으로 /api/me 를 부른다
    res = client.get("/api/me", headers={"Authorization": f"Bearer {token}"})

    # Assert: 화이트리스트에 없으므로 신원은 통과하고 게이트에서 막힌다(401이 아니라)
    assert res.status_code != 401


def test_whitelist_still_gates_ldap_logins(client, ldap_login_on, monkeypatch):
    """LDAP으로 들어와도 화이트리스트에 없으면 조회 API는 403이어야 한다."""
    # Arrange
    _patch_ldap(monkeypatch, user=USER, ok=True)
    token = client.post("/api/auth/ldap-login",
                        json={"login_id": "hong.gildong", "password": "ok"}
                        ).json()["access_token"]

    # Act
    res = client.get("/api/objects", headers={"Authorization": f"Bearer {token}"})

    # Assert
    assert res.status_code == 403
    assert "whitelist" in res.json()["error"]["message"]


def test_garbage_token_is_401_not_500(client, ldap_login_on):
    # Act
    res = client.get("/api/objects", headers={"Authorization": "Bearer not-a-jwt"})

    # Assert
    assert res.status_code == 401
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd backend && .venv/bin/python -m pytest tests/test_ldap_login.py -q`
Expected: FAIL — 로컬 토큰이 Keycloak 경로로 가서 401

- [ ] **Step 3: 분기를 구현한다**

`backend/app/auth.py`에 import를 추가한다:

```python
from app.session_token import LOCAL_ISSUER, decode_session_token
```

그리고 `get_current_user` 위에 헬퍼를 둔다:

```python
def _decode_local_session(token: str) -> dict | None:
    """우리가 발급한 토큰이면 완전 검증해 클레임을, 아니면 None을 돌려준다.

    `iss`를 읽으려고 서명 검증 없이 한 번 디코드하는데, 그 결과는 **경로 선택에만** 쓴다.
    신원·권한은 아래 `decode_session_token`이 서명·만료·발급자·알고리즘을 전부 검증한 뒤
    나온 클레임에서만 온다.
    """
    try:
        unverified = jwt.decode(token, options={"verify_signature": False})
    except jwt.PyJWTError:
        return None  # 파싱조차 안 되면 Keycloak 경로가 기존과 같은 401을 낸다
    if unverified.get("iss") != LOCAL_ISSUER:
        return None
    return decode_session_token(token)
```

`get_current_user`의 토큰 추출 직후(`token = authorization.removeprefix("Bearer ")` 다음)에:

```python
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
```

이후는 기존 Keycloak 경로 그대로다 — **`algorithms=["RS256"]`을 지우지 마라.**

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd backend && .venv/bin/python -m pytest tests/test_ldap_login.py tests/test_auth.py -q`
Expected: PASS — 기존 `test_auth.py`가 전부 그대로 통과해야 한다

- [ ] **Step 5: 회귀 + 커밋**

Run: `cd backend && .venv/bin/python -m pytest -q && .venv/bin/ruff check app tests`
Expected: 449 passed / 4 skipped

```bash
git add backend/app/auth.py backend/tests/test_ldap_login.py PROGRESS.md
git commit -m "feat(auth): accept locally issued tokens alongside Keycloak — 두 토큰 경로 병행"
```

---

## Task 4: 프론트엔드 로그인 폼

**Files:**
- Create: `frontend/src/lib/session-token.ts`, `frontend/src/lib/session-token.test.ts`
- Modify: `frontend/src/app/login/page.tsx`, `frontend/src/components/providers.tsx`,
  `frontend/src/lib/api.ts`, `frontend/Dockerfile`, `docker-compose.yml`

**Interfaces:**
- Produces: `interface StoredSession { token: string; expiresAt: string; loginId: string; name: string | null }`
- Produces: `readStoredSession(now?: Date): StoredSession | null`
- Produces: `storeSession(s: StoredSession): void`
- Produces: `clearStoredSession(): void`
- Produces: `loginWithLdap(loginId: string, password: string): Promise<StoredSession>` (`api.ts`)

- [ ] **Step 1: 순수 헬퍼 테스트를 쓴다**

`frontend/src/lib/session-token.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";

import { clearStoredSession, readStoredSession, storeSession } from "./session-token";

const VALID = {
  token: "a.b.c",
  expiresAt: "2026-08-27T00:00:00.000Z",
  loginId: "hong.gildong",
  name: "홍길동",
};

describe("session-token", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips a stored session", () => {
    storeSession(VALID);
    expect(readStoredSession(new Date("2026-08-26T12:00:00Z"))).toEqual(VALID);
  });

  it("returns null once the session has expired", () => {
    storeSession(VALID);
    expect(readStoredSession(new Date("2026-08-27T00:00:01Z"))).toBeNull();
  });

  it("clears the stored value when it has expired", () => {
    storeSession(VALID);
    readStoredSession(new Date("2026-08-27T00:00:01Z"));
    expect(localStorage.getItem("dbv.session")).toBeNull();
  });

  it("returns null for malformed stored JSON instead of throwing", () => {
    localStorage.setItem("dbv.session", "{not json");
    expect(readStoredSession(new Date("2026-08-26T12:00:00Z"))).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    localStorage.setItem("dbv.session", JSON.stringify({ token: "a.b.c" }));
    expect(readStoredSession(new Date("2026-08-26T12:00:00Z"))).toBeNull();
  });

  it("clearStoredSession removes the key", () => {
    storeSession(VALID);
    clearStoredSession();
    expect(localStorage.getItem("dbv.session")).toBeNull();
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd frontend && npx vitest run src/lib/session-token.test.ts`
Expected: FAIL — `Cannot find module './session-token'`

- [ ] **Step 3: 순수 헬퍼를 쓴다**

`frontend/src/lib/session-token.ts`:

```typescript
/** LDAP 로그인 세션의 브라우저 저장 — 순수 로직. / browser-side storage for the LDAP session.
 *  갱신 토큰이 없으므로 만료된 값은 읽는 즉시 버린다. */

const KEY = "dbv.session";

export interface StoredSession {
  token: string;
  expiresAt: string;
  loginId: string;
  name: string | null;
}

function isSession(value: unknown): value is StoredSession {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.token === "string" && typeof v.expiresAt === "string"
    && typeof v.loginId === "string";
}

export function readStoredSession(now: Date = new Date()): StoredSession | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null; // 사파리 프라이빗 등 storage 접근 자체가 막힌 경우
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearStoredSession();
    return null;
  }
  if (!isSession(parsed)) {
    clearStoredSession();
    return null;
  }
  // 만료분을 남겨두면 매 요청이 401을 받고 리다이렉트가 반복된다
  if (new Date(parsed.expiresAt).getTime() <= now.getTime()) {
    clearStoredSession();
    return null;
  }
  return { ...parsed, name: typeof parsed.name === "string" ? parsed.name : null };
}

export function storeSession(session: StoredSession): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    // 저장 실패는 치명적이지 않다 — 이번 탭에서는 메모리의 토큰으로 동작한다
  }
}

export function clearStoredSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // 위와 같은 이유
  }
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd frontend && npx vitest run src/lib/session-token.test.ts`
Expected: PASS (6 passed)

- [ ] **Step 5: API 클라이언트에 로그인 + 401 처리를 더한다**

`frontend/src/lib/api.ts`에 추가:

```typescript
export interface LdapLoginResponse {
  access_token: string;
  token_type: string;
  expires_at: string;
  login_id: string;
  name: string | null;
}

export function loginWithLdap(
  loginId: string, password: string,
): Promise<LdapLoginResponse> {
  return postJson("/api/auth/ldap-login", { login_id: loginId, password });
}
```

`handle()`을 고친다 — **로컬 세션이 만료되면 조용한 오류 대신 로그인 화면으로 보낸다:**

```typescript
async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    // 로컬 세션 토큰은 갱신이 없다 — 만료되면 401이 오고, 여기가 유일한 응답 깔때기다.
    // 로그인 화면 자신에서는 리다이렉트하지 않는다(무한 루프 방지).
    if (res.status === 401 && typeof window !== "undefined"
        && window.location.pathname !== "/login") {
      const { clearStoredSession, readStoredSession } = await import("./session-token");
      if (readStoredSession() !== null) {
        clearStoredSession();
        setAuthToken(null);
        window.location.href = "/login";
      }
    }
    const body = await res.json().catch(() => null);
    const message = body?.error?.message ?? `request failed (${res.status})`;
    throw new Error(message);
  }
  return res.json();
}
```

- [ ] **Step 6: 로그인 화면에 폼을 더한다**

`frontend/src/app/login/page.tsx`를 고친다. 두 경로를 **독립적으로** 켜고 끈다:

```tsx
const AUTH_ENABLED = process.env.NEXT_PUBLIC_AUTH_ENABLED === "true";
const LDAP_ENABLED = process.env.NEXT_PUBLIC_LDAP_LOGIN_ENABLED === "true";
const KEYCLOAK_ENABLED = (process.env.NEXT_PUBLIC_KEYCLOAK_ISSUER ?? "") !== "";
```

- `AUTH_ENABLED`가 false면 기존 `DevRedirect` 그대로.
- `KEYCLOAK_ENABLED`일 때만 기존 Keycloak 자동시도·버튼을 렌더한다
  (**`KeycloakLogin`은 `useAuth()`를 쓰므로 `AuthProvider` 아래에서만 마운트되어야 한다**).
- `LDAP_ENABLED`일 때 사번·비밀번호 폼을 같은 카드에 렌더한다.
- **둘 다 꺼져 있으면** "로그인 수단이 설정되지 않았습니다 — 관리자에게 문의하세요"를 명시적으로
  보여준다. 조용한 빈 카드를 남기지 마라.

폼 제출 핸들러:

```tsx
async function handleLdapSubmit(event: React.FormEvent): Promise<void> {
  event.preventDefault();
  setError(null);
  setPending(true);
  try {
    const res = await loginWithLdap(loginId, password);
    storeSession({
      token: res.access_token, expiresAt: res.expires_at,
      loginId: res.login_id, name: res.name,
    });
    setAuthToken(res.access_token);
    router.replace(consumeReturnTo());
  } catch (e) {
    setError(e instanceof Error ? e.message : "로그인에 실패했습니다");
  } finally {
    setPassword("");   // 실패해도 비밀번호를 상태에 남기지 않는다
    setPending(false);
  }
}
```

import는 `consumeReturnTo`가 `@/lib/auth-return`, `loginWithLdap`·`setAuthToken`이
`@/lib/api`, `storeSession`이 `@/lib/session-token`이다 (`postJson`은 `api.ts` 모듈 내부
전용이므로 `loginWithLdap`은 반드시 그 파일 안에 둔다).

`data-testid`: `LoginPage-ldapForm`, `LoginPage-loginIdInput`, `LoginPage-passwordInput`,
`LoginPage-ldapSubmit`, `LoginPage-ldapError`, `LoginPage-noAuthMethod`.

비밀번호 입력은 `type="password"` + `autoComplete="current-password"`.

- [ ] **Step 7: 부팅 시 저장분 복원 + Keycloak 조건부 마운트 + 로그아웃**

`frontend/src/components/providers.tsx`:

- 마운트 시 `readStoredSession()`을 읽어 유효하면 `setAuthToken(session.token)`.
- **`AuthProvider`를 `NEXT_PUBLIC_KEYCLOAK_ISSUER`가 있을 때만 마운트한다.** 지금
  `buildOidcConfig()`가 `?? ""`로 빈 authority를 만드는데, 개발 스택은 이 값을 비운다(§B.4).
  **빈 설정으로 실제 렌더해 확인하고**, 못 견디면 Provider 자체를 조건부로 감싼다.

**`useLogout`이 여기서 깨진다 — 반드시 함께 고친다.** 현재
`providers.tsx:150`의 `useLogout()`은 첫 줄에서 `useAuth()`를 부르는데, 그 훅은
**`AuthProvider` 밖에서 던진다.** `AppHeader`는 `LogoutButton`을 조건 없이 렌더하므로,
Provider를 조건부로 만드는 순간 **LDAP 전용 배포에서 모든 화면이 크래시한다.** 훅이 두 경우를
모두 견디게 고친다:

```tsx
/** 로컬 로그아웃 — Keycloak SSO 세션은 유지 (bpm 패턴) / local logout, SSO stays. */
export function useLogout(): () => void {
  // Keycloak이 꺼진 배포에서는 AuthProvider가 없다 — useAuth()는 그 밖에서 던지므로
  // 컨텍스트를 직접 읽어 null을 허용한다 (훅 규칙상 조건부 호출은 불가).
  const auth = useContext(AuthContext);
  const router = useRouter();
  return () => {
    markAutoLoginTried(); // /login 재진입 시 자동 로그인 루프 방지
    clearStoredSession(); // LDAP 세션도 함께 끊는다 — 안 지우면 부팅 시 되살아난다
    setAuthToken(null);
    void Promise.resolve(auth?.removeUser()).then(() => router.replace("/login"));
  };
}
```

`AuthContext`는 `react-oidc-context`가 내보낸다. 내보내지 않는 버전이면 Provider 유무를
읽는 자체 컨텍스트를 하나 두고 그 값으로 분기한다 — **`useAuth()`를 조건부로 부르지 마라**
(훅 규칙 위반이고 eslint가 잡는다).

- Keycloak이 꺼진 배포에서 `useAuth()`를 부르는 컴포넌트가 **하나도 남지 않아야 한다.**
  `grep -rn "useAuth" src`로 전수 확인하고, 남은 곳마다 같은 방식으로 처리한다.

- [ ] **Step 8: 빌드 인자 배선**

`frontend/Dockerfile`:

```dockerfile
ARG NEXT_PUBLIC_LDAP_LOGIN_ENABLED=false
```
그리고 기존 `ENV NEXT_PUBLIC_AUTH_ENABLED=$NEXT_PUBLIC_AUTH_ENABLED \` 체인에
`NEXT_PUBLIC_LDAP_LOGIN_ENABLED=$NEXT_PUBLIC_LDAP_LOGIN_ENABLED` 를 더한다.

`docker-compose.yml`의 `frontend.build.args`에:

```yaml
        NEXT_PUBLIC_LDAP_LOGIN_ENABLED: ${AUTH_LDAP_LOGIN_ENABLED:-false}
```

- [ ] **Step 9: 네 게이트**

Run: `cd frontend && npx tsc --noEmit && npm run lint && npx vitest run && npm run build`
Expected: 전부 통과, vitest 129 passed

- [ ] **Step 10: 커밋**

```bash
git add frontend/src/lib/session-token.ts frontend/src/lib/session-token.test.ts \
        frontend/src/lib/api.ts frontend/src/app/login/page.tsx \
        frontend/src/components/providers.tsx frontend/Dockerfile \
        docker-compose.yml PROGRESS.md
git commit -m "feat(auth): LDAP login form beside the Keycloak button — 로그인 화면 병행"
```

---

## Task 5: 개발 스택 + 런북

**Files:**
- Create: `docker-compose-dev.yml`, `docs/dev-deploy.md`
- Modify: `.gitignore`, `README.md`

- [ ] **Step 1: `.env.dev`를 gitignore에 넣는다**

`.gitignore`에 `.env` 항목 옆에:

```
.env.dev
```

**`.env.dev.example`을 만들지 않는다** — `.env.example`과 45개 키 중 40개가 같아 반드시 어긋난다.
델타는 런북의 표가 담당한다.

- [ ] **Step 2: 개발 compose를 쓴다**

`docker-compose-dev.yml` — 운영 compose의 오버레이가 **아니라** 독립 스택이다.
`docker-compose.yml`을 읽고 서비스 구조를 그대로 따르되 다음을 바꾼다:

```yaml
# 개발 스택 — 운영과 완전히 분리된 별도 프로젝트.
# 사용법: docker compose --env-file .env.dev -f docker-compose-dev.yml up -d --build
# 주의: 운영 docker-compose.yml과 함께 -f 로 겹쳐 쓰지 마라. 독립 스택이다.
name: dbviewer-dev

services:
  postgres:
    # 운영과 같은 이미지·헬스체크, 볼륨만 다르다
    volumes:
      - pgdata-dev:/var/lib/postgresql/data
    networks: [dbviewer-dev]

  backend:
    # 운영과 같은 build/command/environment. env_file로 값만 갈아끼운다
    env_file: .env.dev
    networks: [dbviewer-dev]

  frontend:
    build:
      context: ./frontend
      args:
        # NEXT_PUBLIC_*는 빌드 타임 인라인 — .env.dev만 바꿔선 반영되지 않는다
        NEXT_PUBLIC_AUTH_ENABLED: ${AUTH_ENABLED}
        NEXT_PUBLIC_LDAP_LOGIN_ENABLED: ${AUTH_LDAP_LOGIN_ENABLED:-true}
        NEXT_PUBLIC_KEYCLOAK_ISSUER: ${KEYCLOAK_ISSUER}
        NEXT_PUBLIC_KEYCLOAK_CLIENT_ID: ${KEYCLOAK_CLIENT_ID}
        BACKEND_URL: http://backend:8000
    ports:
      - "${DEV_APP_PORT:-6679}:3000"
    networks: [dbviewer-dev]

networks:
  dbviewer-dev:
    driver: bridge
    ipam:
      config:
        # 운영(172.48/16)과 소스 네트워크(172.50.x/24) 사이의 빈 자리
        - subnet: 172.49.0.0/16
          gateway: 172.49.0.1

volumes:
  pgdata-dev:
```

운영 `docker-compose.yml`의 `backend` `environment:` 블록 전체를 그대로 복사해 넣는다 —
`env_file`만으로는 compose가 컨테이너 환경에 넣어주지 않는 값이 있다(운영 파일이 명시 나열하는
이유와 같다). 복사한 뒤 `docker compose config`로 실제 값이 들어가는지 확인한다.

- [ ] **Step 3: 문법을 검증한다**

Run: `docker compose --env-file .env.example -f docker-compose-dev.yml config -q`
Expected: 종료 코드 0 (변수 미설정 경고는 정상)

docker가 없으면 그렇다고 리포트에 적는다 — 통과했다고 쓰지 마라.

- [ ] **Step 4: 런북을 쓴다**

`docs/dev-deploy.md`:

1. **`cp .env.example .env.dev` 후 바꿀 키** — 설계 §B.3의 표를 그대로 옮긴다.
   `SESSION_SECRET_KEY`와 `SOURCE_SECRET_KEY`가 **운영과 달라야 하는 이유**를 굵게 남긴다:
   전자를 공유하면 개발에서 발급한 토큰이 운영에서 유효해진다.
2. **띄우기**: `docker compose --env-file .env.dev -f docker-compose-dev.yml up -d --build`
3. **`NEXT_PUBLIC_*`는 빌드 인라인** — 그 값을 바꾸면 반드시 `--build`.
4. **Keycloak**: 개발 포트의 redirect URI와 **Web origins** 등록 절차. 등록하지 않을 거면
   `KEYCLOAK_ISSUER`를 비워 버튼을 숨기고 LDAP으로만 들어간다.
5. **첫 기동 시 `alembic upgrade head` 출력 확인** — 개발 DB는 비어 있으므로 전체 체인이 돈다.
6. **정리**: `docker compose -f docker-compose-dev.yml down` (개발 스택은 독립이라 안전하다).
   `-v`를 붙이면 `pgdata-dev`까지 지워진다.
7. **트러블슈팅 표** — 포트 충돌, 서브넷 충돌, `NEXT_PUBLIC` 미반영, Web origins 누락.

- [ ] **Step 5: README에 링크**

`## 배포` 절에 한 줄, 트러블슈팅 표에 두 행:

| 증상 | 확인 |
|---|---|
| LDAP 로그인 폼이 안 보임 | `AUTH_LDAP_LOGIN_ENABLED=true` 후 **`--build`** 했는지 (`NEXT_PUBLIC_*`는 빌드 인라인) |
| LDAP 로그인이 503 | `SESSION_SECRET_KEY` 미설정 또는 `LDAP_*` 4종 중 빈 값 |

- [ ] **Step 6: 전체 게이트 + 커밋**

```bash
cd backend && .venv/bin/python -m pytest -q && .venv/bin/ruff check app tests
cd ../frontend && npx tsc --noEmit && npm run lint && npx vitest run
```

```bash
git add docker-compose-dev.yml docs/dev-deploy.md .gitignore README.md PROGRESS.md
git commit -m "feat(deploy): standalone dev stack on its own port — 개발 스택 독립 배포"
```

---

## 완료 기준

- [ ] 백엔드 449 passed 이상 / ruff 클린
- [ ] `NEXT_PUBLIC_KEYCLOAK_ISSUER`가 빈 상태로 `npm run build` + 렌더가 크래시하지 않는다
      (`useLogout`/`useAuth` 경로 포함)
- [ ] 로그아웃이 저장된 LDAP 세션을 지운다 — 로그아웃 후 새로고침에 되로그인되지 않는다
- [ ] 프론트 tsc / eslint / vitest 129 passed / build 그린
- [ ] **빈 비밀번호로 로그인이 절대 성공하지 않는다** (unauthenticated bind 방어)
- [ ] "없는 사용자"와 "틀린 비밀번호"의 응답이 동일하다
- [ ] LDAP 로그인 사용자가 화이트리스트에 없으면 조회 API가 403
- [ ] `iss`를 주장하는 다른 알고리즘 토큰이 거부된다
- [ ] 어떤 응답에도 비밀번호 문자열이 없다
- [ ] `docker compose -f docker-compose-dev.yml config -q` 통과
- [ ] `.env.dev`가 git에 없다 (`git ls-files .env.dev`가 빈 출력)
