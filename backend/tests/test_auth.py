"""Auth, whitelist, and ingest-key gate tests. / 인증·화이트리스트·ingest 키 게이트 테스트."""

from datetime import UTC, datetime

import pytest
import sqlalchemy as sa

from app.ad.org import RawUser, is_active, is_excluded, parse_org_levels, to_user_fields
from app.config import get_settings
from app.models import Base


@pytest.fixture()
def auth_on(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "dbv_sysadmins", "admin.sys")
    return settings


# ── AD 매핑 순수 함수 (bpm 규칙) ──


def test_parse_org_levels_drops_noise_and_orders_root_to_leaf():
    dn = ("CN=Hong Gil\\, Dong,OU=Team A,OU=Div B,OU=SAMSUNGBIOLOGICS,"
          "DC=corp,DC=example,DC=com")
    assert parse_org_levels(dn) == ["Div B", "Team A"]


def test_is_active_reads_account_disable_bit():
    assert is_active(512) is True
    assert is_active(514) is False  # ACCOUNTDISABLE
    assert is_active(None) is True  # 속성 없으면 보수적으로 활성


def test_exclusion_rules():
    assert is_excluded("Partners", "hong.gil", "Hong Gil") is True
    assert is_excluded("Div B", "svcaccount", "Svc") is True      # '.' 없는 계정
    assert is_excluded("Div B", "hong.gil", "sys_batch") is True  # '_' 이름
    assert is_excluded("Div B", "hong.gil", "Hong Gil") is False


def test_to_user_fields_maps_and_assigns_role():
    raw = RawUser("admin.sys", "Admin Sys", "Manager",
                  "CN=x,OU=Team A,OU=Div B,DC=c,DC=e", 512, "a@ex.com")
    fields = to_user_fields(raw, sysadmin_ids={"admin.sys"})
    assert fields is not None
    assert fields["role"] == "admin"
    assert fields["department"] == "Team A"
    assert fields["org_path"] == "Div B/Team A"


def test_ldap_filter_escaping_is_rfc4515():
    from app.ad.client import escape_filter_value

    assert escape_filter_value("hong.gil") == "hong.gil"
    # 백슬래시 먼저 — 아니면 이중 이스케이프 / backslash first or it double-escapes
    assert escape_filter_value("a\\b") == "a\\5cb"
    assert escape_filter_value("*)(uid=*") == "\\2a\\29\\28uid=\\2a"
    assert escape_filter_value("x\x00y") == "x\\00y"


def test_login_sync_is_throttled_per_user(client, monkeypatch):
    from app.ad import service as ad_service
    from app.api import me as me_module

    settings = get_settings()
    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "ldap_url", "ldaps://ad.example:636")
    monkeypatch.setattr(settings, "ldap_bind_dn", "cn=svc")
    monkeypatch.setattr(settings, "ldap_bind_credentials", "pw")
    monkeypatch.setattr(settings, "ldap_user_search_base", "dc=example")
    monkeypatch.setattr(settings, "dbv_sysadmins", "admin.sys")
    monkeypatch.setattr(me_module, "_last_sync_at", {})

    calls: list[str] = []
    monkeypatch.setattr(ad_service, "sync_one", lambda db, login_id: calls.append(login_id))

    from app import auth as auth_module

    client.app.dependency_overrides[auth_module.get_current_user] = lambda: "admin.sys"
    assert client.get("/api/me").status_code == 200
    assert client.get("/api/me").status_code == 200
    assert calls == ["admin.sys"]  # 두 번째 호출은 스로틀 / second call throttled


def test_login_recorded_once_per_day(client, migrated_engine):
    client.get("/api/me")
    client.get("/api/me")
    with migrated_engine.connect() as conn:
        logins = conn.execute(
            sa.select(Base.metadata.tables["audit_logs"])
            .where(Base.metadata.tables["audit_logs"].c.action == "login")
        ).all()
    assert len(logins) == 1  # KST 하루 1건 중복 제거 / daily dedupe
    assert logins[0].detail == "dev.user"


# ── 게이트 동작 ──


def test_auth_off_trusts_dev_user_header(client):
    res = client.get("/api/me", headers={"X-Dev-User": "someone.dev"})
    body = res.json()
    assert body["login_id"] == "someone.dev"
    assert body["whitelisted"] is True and body["auth_enabled"] is False


def test_auth_on_requires_bearer_token(client, auth_on):
    assert client.get("/api/me").status_code == 401
    assert client.get("/api/objects", params={"q": "x"}).status_code == 401
    # X-Dev-User는 auth ON에서 신뢰하지 않는다 / dev header ignored when auth is on
    assert client.get("/api/me", headers={"X-Dev-User": "hacker"}).status_code == 401


def test_whitelist_gate_blocks_and_admits(client, migrated_engine, auth_on):
    from app import auth as auth_module

    client.app.dependency_overrides[auth_module.get_current_user] = lambda: "hong.gil"

    res = client.get("/api/objects", params={"q": "x"})
    assert res.status_code == 403
    assert "whitelisted" in res.json()["error"]["message"]

    with migrated_engine.begin() as conn:
        conn.execute(sa.insert(Base.metadata.tables["login_whitelist"]).values(
            login_id="hong.gil", note=None, added_by="admin.sys",
            created_at=datetime.now(UTC),
        ))
    res = client.get("/api/objects", params={"q": "x"})
    assert res.status_code in (200, 404)  # 게이트 통과 (404 = ready 스냅샷 없음)


def test_sysadmin_bypasses_whitelist(client, auth_on):
    from app import auth as auth_module

    client.app.dependency_overrides[auth_module.get_current_user] = lambda: "admin.sys"
    res = client.get("/api/objects", params={"q": "x"})
    assert res.status_code in (200, 404)


def test_admin_router_requires_sysadmin(client, auth_on):
    from app import auth as auth_module

    client.app.dependency_overrides[auth_module.get_current_user] = lambda: "hong.gil"
    assert client.get("/api/admin/whitelist").status_code == 403

    client.app.dependency_overrides[auth_module.get_current_user] = lambda: "admin.sys"
    assert client.get("/api/admin/whitelist").status_code == 200


def test_whitelist_admin_crud_writes_audit(client, migrated_engine, auth_on):
    from app import auth as auth_module

    client.app.dependency_overrides[auth_module.get_current_user] = lambda: "admin.sys"
    res = client.post("/api/admin/whitelist",
                      json={"login_id": "hong.gil", "note": "ERD 사용자"})
    assert res.status_code == 200 and res.json()["created"] is True

    items = client.get("/api/admin/whitelist").json()["items"]
    assert [i["login_id"] for i in items] == ["hong.gil"]

    assert client.delete("/api/admin/whitelist/hong.gil").json()["removed"] is True
    assert client.delete("/api/admin/whitelist/hong.gil").status_code == 404

    with migrated_engine.connect() as conn:
        actions = [r.action for r in conn.execute(
            sa.select(Base.metadata.tables["audit_logs"])
        )]
    assert actions == ["whitelist_add", "whitelist_remove"]


def test_ingest_requires_api_key_when_configured(client, load_fixture, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "ingest_api_key", "sekrit")

    payload = load_fixture("catalog.json")
    assert client.post("/api/ingest/catalog", json=payload).status_code == 401
    res = client.post("/api/ingest/catalog", json=payload,
                      headers={"X-API-Key": "sekrit"})
    assert res.status_code == 200


def test_ingest_blocked_without_key_when_auth_on(client, load_fixture, auth_on):
    res = client.post("/api/ingest/catalog", json=load_fixture("catalog.json"))
    assert res.status_code == 401
    assert "INGEST_API_KEY" in res.json()["error"]["message"]


# ── AD 동기화 서비스 (가짜 LDAP 데이터) ──


def test_sync_all_upserts_excludes_and_prunes(client, migrated_engine, monkeypatch):
    from sqlalchemy.orm import sessionmaker

    from app.ad import service

    factory = sessionmaker(bind=migrated_engine)
    now = datetime.now(UTC)
    with factory() as db:
        # 기존 AD 유저 1명(퇴사 예정) + local 유저 1명(보존 대상)
        db.execute(sa.insert(Base.metadata.tables["app_users"]).values([
            dict(login_id="old.timer", name="Old Timer", title=None, department=None,
                 org_path=None, email=None, active=True, source="ad", role="user",
                 created_at=now, updated_at=now),
            dict(login_id="local.admin", name="Local", title=None, department=None,
                 org_path=None, email=None, active=True, source="local", role="admin",
                 created_at=now, updated_at=now),
        ]))
        db.commit()

    raws = [
        RawUser("hong.gil", "Hong Gil", "Staff", "CN=x,OU=Team A,OU=Div B,DC=c", 512, None),
        RawUser("svcaccount", "svc_bot", None, "CN=y,OU=Service,DC=c", 512, None),
    ]
    with factory() as db:
        summary = service.sync_all(db, raws=raws)
        db.commit()

    assert (summary.scanned, summary.upserted, summary.excluded) == (2, 1, 1)
    assert summary.purged == 1  # old.timer 제거, local.admin 보존
    with migrated_engine.connect() as conn:
        ids = {r.login_id for r in conn.execute(sa.select(Base.metadata.tables["app_users"]))}
    assert ids == {"hong.gil", "local.admin"}


def _seed_users(engine, rows: list[tuple[str, str, str]]) -> None:
    now = datetime.now(UTC)
    with engine.begin() as conn:
        conn.execute(sa.insert(Base.metadata.tables["app_users"]).values([
            dict(login_id=lid, name=name, title=None, department=dept, org_path=None,
                 email=f"{lid}@corp", active=True, source="ad", role="user",
                 created_at=now, updated_at=now)
            for lid, name, dept in rows
        ]))


def test_admin_users_lists_synced_ad_users(client, migrated_engine):
    """관리 콘솔 AD 사용자 목록의 데이터 원천 — 화이트리스트와 별개 테이블."""
    _seed_users(migrated_engine, [("hong.gil", "Hong Gil", "Team A")])

    res = client.get("/api/admin/users")
    assert res.status_code == 200, res.text
    body = res.json()
    assert [u["login_id"] for u in body["items"]] == ["hong.gil"]
    assert body["items"][0]["department"] == "Team A"
    assert (body["total"], body["has_more"]) == (1, False)

    # 화이트리스트는 별개 — 동기화만으로는 비어 있다 / a sync does not whitelist anyone
    assert client.get("/api/admin/whitelist").json()["items"] == []


def test_admin_users_search_covers_everyone_not_just_a_page(client, migrated_engine):
    """검색은 DB에서 — 로드된 페이지가 아니라 전체 인원을 대상으로 한다."""
    _seed_users(migrated_engine, [(f"user.{i:03d}", f"Name {i}", "생산관리팀")
                                  for i in range(120)])
    _seed_users(migrated_engine, [("zz.kim", "Kim QC", "품질보증팀")])

    # 첫 페이지에 없는 사람도 검색되면 전체 대상 / the match sits past page 1
    first = client.get("/api/admin/users?limit=100").json()
    assert len(first["items"]) == 100 and first["has_more"] is True
    assert "zz.kim" not in {u["login_id"] for u in first["items"]}

    found = client.get("/api/admin/users?q=품질").json()
    assert [u["login_id"] for u in found["items"]] == ["zz.kim"]
    assert found["total"] == 1

    # 이름·ID로도 매칭 / matches login_id and name too
    assert client.get("/api/admin/users?q=Kim QC").json()["total"] == 1
    assert client.get("/api/admin/users?q=zz.ki").json()["total"] == 1


def test_admin_users_paging_walks_the_whole_set(client, migrated_engine):
    _seed_users(migrated_engine, [(f"u{i:03d}", f"N{i}", "T") for i in range(30)])

    page1 = client.get("/api/admin/users?limit=20").json()
    page2 = client.get("/api/admin/users?limit=20&offset=20").json()
    assert (len(page1["items"]), page1["has_more"]) == (20, True)
    assert (len(page2["items"]), page2["has_more"]) == (10, False)
    ids = [u["login_id"] for u in page1["items"] + page2["items"]]
    assert len(set(ids)) == 30  # 경계에서 중복·누락 없음 / no overlap or gap


def test_health_is_exempt_from_auth(client, auth_on):
    # 헬스체크는 인증 면제 — compose healthcheck·배포 검증용 (bpm 패턴)
    res = client.get("/api/health")
    assert res.status_code == 200 and res.json() == {"status": "ok"}
