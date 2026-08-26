"""LDAP 로그인 엔드포인트 — 열거 방지·잠금·게이트. / LDAP login endpoint."""

from datetime import UTC, datetime, timedelta

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


@pytest.fixture()
def ldap_login_missing_key(monkeypatch):
    """기능은 켜져 있으나 서명 키가 없는 상태 — `ldap_login_on`과 달리 SESSION_SECRET_KEY가 비어 있다.

    `client` fixture보다 먼저 실행돼야 한다: 라우터 등록은 `create_app()` 시점의
    `get_settings()` 값으로 고정되므로, `client`가 앱을 만든 뒤에 플래그를 켜면 이미
    라우터가 없는 앱이라 항상 404가 난다 (본문에서 monkeypatch.setenv를 쓰면 이 순서를
    지킬 수 없어 픽스처로 분리했다).
    """
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("AUTH_LDAP_LOGIN_ENABLED", "true")
    monkeypatch.setenv("SESSION_SECRET_KEY", "")
    monkeypatch.setenv("LDAP_URL", "ldaps://ad.example:636")
    monkeypatch.setenv("LDAP_BIND_DN", "cn=svc")
    monkeypatch.setenv("LDAP_BIND_CREDENTIALS", "pw")
    monkeypatch.setenv("LDAP_USER_SEARCH_BASE", "dc=example")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _patch_ldap(monkeypatch, *, user, ok):
    from app.api import auth_login
    monkeypatch.setattr(auth_login.ad_client, "fetch_user", lambda _id: user)
    monkeypatch.setattr(auth_login.ad_client, "verify_credentials", lambda _dn, _pw: ok)


def test_successful_login_returns_a_token(ldap_login_on, client, monkeypatch):
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
    ldap_login_on, client, monkeypatch,
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


def test_empty_password_never_succeeds(ldap_login_on, client, monkeypatch):
    """빈 비밀번호는 서버가 익명 바인드로 성공시킬 수 있다 — 그 전에 막혀야 한다."""
    # Arrange: 바인드가 True를 돌려주더라도(=서버가 익명 허용) 통과하면 안 된다
    _patch_ldap(monkeypatch, user=USER, ok=True)

    # Act
    res = client.post("/api/auth/ldap-login",
                      json={"login_id": "hong.gildong", "password": ""})

    # Assert
    assert res.status_code == 401


def test_lockout_after_repeated_failures(ldap_login_on, client, monkeypatch):
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


def test_success_clears_the_failure_counter(ldap_login_on, client, monkeypatch):
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


def test_transport_failure_is_503_not_401(ldap_login_on, client, monkeypatch):
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
    # Arrange: 라우터 등록은 create_app 시점에 결정된다.
    # TestClient를 쓰지 않는 이유 — main.py의 @app.on_event("startup")이 실제 DB 세션을 연다.
    # 라우트 테이블을 직접 보는 편이 더 직접적이고 부작용이 없다.
    monkeypatch.setenv("AUTH_LDAP_LOGIN_ENABLED", "false")
    get_settings.cache_clear()
    from app.main import create_app

    # Act
    paths = {getattr(route, "path", None) for route in create_app().routes}

    # Assert
    assert "/api/auth/ldap-login" not in paths
    get_settings.cache_clear()


def test_endpoint_is_registered_when_the_flag_is_on(ldap_login_on):
    """켜져 있을 때는 반드시 등록된다 — 위 테스트가 오타로 항상 통과하지 않도록."""
    # Arrange / Act
    from app.main import create_app

    paths = {getattr(route, "path", None) for route in create_app().routes}

    # Assert
    assert "/api/auth/ldap-login" in paths


@pytest.mark.parametrize(
    ("verified", "attempts", "expected_status"),
    [(True, 1, 200), (False, 1, 401), (False, 6, 429)],
)
def test_password_never_appears_in_any_response(
    ldap_login_on, client, monkeypatch, verified, attempts, expected_status,
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


def test_password_is_absent_from_the_503_body(ldap_login_on, client, monkeypatch):
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


def test_password_is_redacted_from_validation_errors(ldap_login_on, client):
    """422 본문에 비밀번호가 되돌아오지 않는지 — main.py의 _redact_validation_error 가드."""
    # Arrange / Act: password에 잘못된 타입을 보내 422를 유발한다
    res = client.post("/api/auth/ldap-login",
                      json={"login_id": "hong.gildong", "password": 12345678})

    # Assert
    assert res.status_code == 422
    assert "12345678" not in res.text


def test_missing_signing_key_is_503(ldap_login_missing_key, client):
    # Act
    res = client.post("/api/auth/ldap-login",
                      json={"login_id": "hong.gildong", "password": "x"})

    # Assert
    assert res.status_code == 503


def test_lockout_not_bypassed_by_changing_case(ldap_login_on, client, monkeypatch):
    """AD sAMAccountName은 대소문자를 구분하지 않는다 — 케이스만 바꿔 잠금을 우회하면 안 된다."""
    # Arrange
    _patch_ldap(monkeypatch, user=USER, ok=False)

    # Act: 소문자로 5회 실패 후, 대문자로 한 번 더
    for _ in range(5):
        assert client.post("/api/auth/ldap-login",
                           json={"login_id": "hong.gildong", "password": "x"}
                           ).status_code == 401
    res = client.post("/api/auth/ldap-login",
                      json={"login_id": "HONG.GILDONG", "password": "x"})

    # Assert
    assert res.status_code == 429


def test_success_clears_the_failure_counter_across_casing(ldap_login_on, client, monkeypatch):
    """대소문자가 달라도 같은 카운터를 공유해야, 그중 하나로 성공했을 때 카운터가 비워진다.

    소문자로 4회(임계치 미만 — 성공 시도 자체가 잠기지 않도록) 실패시킨 뒤 대문자로 성공시킨다.
    카운터가 진짜 공유되지 않으면(=버그) 소문자 카운터 4회가 그대로 남아 있어, 뒤이은 4회의
    새 소문자 실패가 누적 8회가 되어 다섯 번째(전체 통산) 시도에서 이미 잠긴다.
    """
    # Arrange: 소문자로 4회 실패(임계치 미만) 후 대문자로 성공
    _patch_ldap(monkeypatch, user=USER, ok=False)
    for _ in range(4):
        client.post("/api/auth/ldap-login",
                    json={"login_id": "hong.gildong", "password": "x"})
    _patch_ldap(monkeypatch, user=USER, ok=True)
    success = client.post("/api/auth/ldap-login",
                          json={"login_id": "HONG.GILDONG", "password": "ok"})
    assert success.status_code == 200  # 성공 시도 자체가 잠금에 막히지 않았는지 먼저 확인

    # Act: 소문자로 4번 더 실패해도(카운터가 비워졌다면 매번 임계치 미만) 잠기면 안 된다
    _patch_ldap(monkeypatch, user=USER, ok=False)
    statuses = [
        client.post("/api/auth/ldap-login",
                    json={"login_id": "hong.gildong", "password": "x"}).status_code
        for _ in range(4)
    ]

    # Assert
    assert statuses == [401, 401, 401, 401]


def test_failures_dict_stays_bounded(ldap_login_on, client, monkeypatch):
    """공격자가 서로 다른 무작위 id로 실패를 채워도 `_failures`가 무한정 자라면 안 된다."""
    # Arrange: 10,000건을 실제로 보내지 않도록 상수를 낮춘다
    from app.api import auth_login
    monkeypatch.setattr(auth_login, "_SWEEP_THRESHOLD", 10)
    monkeypatch.setattr(auth_login, "_MAX_TRACKED_IDS", 20)
    _patch_ldap(monkeypatch, user=USER, ok=False)

    # Act: 서로 다른 id 40개로 상한(20)의 두 배를 채운 뒤, 이미 있는 키로 한 번 더 요청해
    # (새 키를 추가하지 않으면서) 마지막 스윕이 한 번 더 돌 기회를 준다
    for i in range(40):
        client.post("/api/auth/ldap-login",
                    json={"login_id": f"attacker{i}", "password": "x"})
    client.post("/api/auth/ldap-login",
                json={"login_id": "attacker39", "password": "x"})

    # Assert
    assert len(auth_login._failures) <= auth_login._MAX_TRACKED_IDS


def test_overlong_login_id_is_422_not_500(ldap_login_on, client):
    """감사 컬럼(String(64))보다 긴 id가 그대로 들어가면 db.commit()에서 DataError → 500이 될 수 있다."""
    # Act: 100자 id — 변경 전 Field 상한이었던 길이, 감사 컬럼 한도 64자를 넘는다
    res = client.post("/api/auth/ldap-login",
                      json={"login_id": "a" * 100, "password": "x"})

    # Assert
    assert res.status_code == 422


def test_whitelist_still_gates_ldap_logins(ldap_login_on, client, monkeypatch):
    """LDAP으로 들어와도 화이트리스트에 없으면 조회 API는 403이어야 한다.

    403은 두 가지를 동시에 증명한다 — 토큰이 `get_current_user`를 통과했고(401이 아님),
    하류 게이트가 그대로 적용됐다는 것. `/api/me`로는 이걸 못 본다: 그 경로는
    `ad_service.sync_one`을 부르는데 함수 안에서 모듈을 import하므로 몽키패치가 닿지 않는다.
    """
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


def test_local_path_short_circuits_before_decoding_when_no_key_is_configured(
    client, monkeypatch,
):
    """가드가 실제로 동작을 바꾼다는 증명 — 401이라는 결과만으로는 증명되지 않는다.

    가드가 없어도 pyjwt가 빈 키를 거부해(InvalidKeyError) 결국 401이 되므로, 상태 코드만
    보는 테스트는 라이브러리의 우연 덕에 통과한다. 여기서는 디코드가 아예 시도되지
    않는다는 것을 직접 단언한다 — 그게 가드가 존재하는 이유다.
    """
    # Arrange
    import jwt

    from app import auth as auth_module

    decode_calls: list[str] = []
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("SESSION_SECRET_KEY", "")
    get_settings.cache_clear()
    monkeypatch.setattr(auth_module, "decode_session_token", decode_calls.append)
    forged = jwt.encode(
        {"iss": "db-viewer", "sub": "attacker",
         "iat": datetime.now(UTC), "exp": datetime.now(UTC) + timedelta(hours=1)},
        "attacker-chosen-key", algorithm="HS256",
    )

    # Act
    res = client.get("/api/objects", headers={"Authorization": f"Bearer {forged}"})

    # Assert
    assert res.status_code == 401
    # 가드를 지우면 여기서 실패한다 — 위의 401 단언만으로는 잡히지 않는다
    assert decode_calls == []
    get_settings.cache_clear()
