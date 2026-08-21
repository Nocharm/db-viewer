"""Business-Postgres sources — SQL building, registry, gate, preview.
/ 업무 Postgres 소스 — 질의 조립·연결 레지스트리·게이트·미리보기.

실 Postgres 없이 도는 테스트다: 순수 조립 함수는 SQL 문자열로 검증하고, API는
어댑터를 가짜로 바꿔 규약(등록 → 게이트 → 조회 → 감사 로그)만 확인한다.
"""

import pytest

from app.adapters import pg_source as pg
from app.config import Settings, get_settings
from app.services import pg_sources

SECRET = "unit-test-secret"
PASSWORD = "p@ss:word/1"


@pytest.fixture()
def pg_enabled(monkeypatch):
    """암호화 키가 설정된 배포 / a deployment with the credential key configured."""
    monkeypatch.setenv("PG_SOURCE_SECRET", SECRET)
    monkeypatch.setenv("PREVIEW_ADMIN_PASSWORD", "s3cret")
    get_settings.cache_clear()
    yield "s3cret"
    monkeypatch.delenv("PG_SOURCE_SECRET", raising=False)
    monkeypatch.delenv("PREVIEW_ADMIN_PASSWORD", raising=False)
    get_settings.cache_clear()


@pytest.fixture()
def registered(client, pg_enabled, monkeypatch):
    """소스 1건이 등록되고 목록 조회가 가짜로 물린 상태 / one registered source."""
    monkeypatch.setattr(pg, "list_tables", lambda *a, **k: [
        {"schema": "public", "name": "orders", "type": "table", "row_estimate": 10},
        {"schema": "public", "name": "items", "type": "table", "row_estimate": 4},
        {"schema": "billing", "name": "invoice", "type": "view", "row_estimate": None},
    ])
    res = client.post("/api/admin/pg-sources", headers={"X-Preview-Password": pg_enabled},
                      json={"slug": "bizdb", "label": "업무 DB", "host": "172.48.0.1",
                            "port": 5433, "database": "biz", "username": "viewer_ro",
                            "password": PASSWORD, "note": "확인용"})
    assert res.status_code == 200
    return "bizdb"


def _unlock(client, password, slug="bizdb", schema="public", allowed=True):
    return client.post(f"/api/admin/pg-sources/{slug}/schemas",
                       headers={"X-Preview-Password": password},
                       json={"schema": schema, "allowed": allowed})


def _sql(schema, table, columns, limit, filters):
    query, params = pg.build_rows_query(schema, table, columns, limit, filters)
    return query.as_string(None), params


def test_identifiers_are_quoted_and_values_are_bound():
    """식별자만 인용하고 값은 전부 바인딩 — 문자열 보간 금지 규칙의 실행 가능한 형태."""
    sql, params = _sql("public", "order; drop", ["id", 'we"ird'], 20, [])

    assert sql == 'SELECT "id", "we""ird" FROM "public"."order; drop" LIMIT %s'
    assert params == [20]


@pytest.mark.parametrize(("op", "expected_sql", "expected_params"), [
    ("contains", '"note"::text ILIKE %s', ["%A%"]),
    ("not_contains", '"note"::text NOT ILIKE %s', ["%A%"]),
    ("eq", 'upper("note"::text) = upper(%s)', ["A"]),
    ("neq", 'upper("note"::text) <> upper(%s)', ["A"]),
    ("is_null", '"note" IS NULL', []),
    ("not_null", '"note" IS NOT NULL', []),
])
def test_each_filter_op_becomes_a_where_fragment(op, expected_sql, expected_params):
    """조건 의미는 MSSQL 경로와 같다 — 문자 비교는 대소문자 무시."""
    sql, params = _sql("public", "t", ["note"], 5,
                       [{"column": "note", "op": op, "value": "A"}])

    assert f"WHERE {expected_sql} LIMIT %s" in sql
    assert params == [*expected_params, 5]


def test_conditions_are_combined_with_and():
    sql, params = _sql("public", "t", ["a", "b"], 7, [
        {"column": "a", "op": "eq", "value": "x"},
        {"column": "b", "op": "contains", "value": "y"},
    ])

    assert 'WHERE upper("a"::text) = upper(%s) AND "b"::text ILIKE %s LIMIT %s' in sql
    assert params == ["x", "%y%", 7]


def test_passwords_round_trip_and_die_with_the_key():
    """키가 바뀌면 조용히 비어버리는 대신 명시적으로 실패한다 / explicit failure, not silence."""
    settings = Settings(pg_source_secret=SECRET)
    ciphertext = pg_sources.encrypt_password(settings, PASSWORD)

    assert ciphertext != PASSWORD
    assert pg_sources.decrypt_password(settings, ciphertext) == PASSWORD
    with pytest.raises(pg_sources.PgSecretMismatch):
        pg_sources.decrypt_password(Settings(pg_source_secret="other"), ciphertext)
    with pytest.raises(pg_sources.PgSecretMissing):
        pg_sources.encrypt_password(Settings(), PASSWORD)


def test_dsn_escapes_credential_punctuation():
    """비밀번호에 `:` `/` `@`가 있어도 DSN이 깨지지 않는다 / punctuation-safe DSN."""
    settings = Settings(pg_source_secret=SECRET)

    class Row:
        username, host, port, database = "viewer_ro", "h", 5433, "biz"
        password_enc = pg_sources.encrypt_password(settings, PASSWORD)

    assert pg_sources.build_dsn(settings, Row) == (
        "postgresql://viewer_ro:p%40ss%3Aword%2F1@h:5433/biz")


def test_the_feature_is_off_until_the_key_is_set(client):
    status = client.get("/api/pg/status").json()

    assert status["enabled"] is False and status["secret_configured"] is False
    assert status["sources"] == []
    assert client.get("/api/pg/tables?source=bizdb").status_code == 404


def test_registering_a_source_lists_it_without_the_password(client, registered, pg_enabled):
    listed = client.get("/api/admin/pg-sources").json()

    assert listed["secret_configured"] is True
    assert listed["items"][0]["slug"] == "bizdb"
    assert listed["items"][0]["username"] == "viewer_ro"
    assert PASSWORD not in str(listed) and "password" not in listed["items"][0]
    status = client.get("/api/pg/status").json()
    assert status["enabled"] is True
    assert status["sources"] == [{"slug": "bizdb", "label": "업무 DB", "database": "biz",
                                  "allowed_schemas": []}]


def test_editing_requires_the_preview_password(client, registered, pg_enabled):
    """자격증명·노출 범위를 바꾸는 조작이라 관리자 로그인만으로는 안 된다."""
    no_password = client.patch("/api/admin/pg-sources/bizdb", json={"label": "x"})
    wrong = client.patch("/api/admin/pg-sources/bizdb", json={"label": "x"},
                         headers={"X-Preview-Password": "nope"})

    assert no_password.status_code == 401 and wrong.status_code == 401
    assert client.get("/api/admin/pg-sources").json()["items"][0]["label"] == "업무 DB"


def test_update_keeps_the_password_when_omitted(client, registered, pg_enabled):
    before = client.get("/api/admin/pg-sources").json()["items"][0]
    res = client.patch("/api/admin/pg-sources/bizdb",
                       headers={"X-Preview-Password": pg_enabled},
                       json={"label": "업무 DB(운영)", "port": 5432})

    assert res.json()["changed"] == ["label", "port"]
    after = client.get("/api/admin/pg-sources").json()["items"][0]
    assert after["label"] == "업무 DB(운영)" and after["port"] == 5432
    assert after["username"] == before["username"]


def test_slug_must_be_url_and_key_safe(client, pg_enabled):
    res = client.post("/api/admin/pg-sources", headers={"X-Preview-Password": pg_enabled},
                      json={"slug": "Biz DB:1", "label": "x", "host": "h", "port": 5432,
                            "database": "d", "username": "u", "password": "p"})

    assert res.status_code == 400
    assert "slug" in res.json()["error"]["message"]


def test_preview_is_denied_until_the_schema_is_unlocked(client, registered, monkeypatch):
    """게이트가 연결보다 먼저 — 허용 전에는 소스에 질의조차 하지 않는다."""
    def explode(*args, **kwargs):  # pragma: no cover - 호출되면 테스트가 실패한다
        raise AssertionError("the source must not be queried before the gate passes")

    monkeypatch.setattr(pg, "list_columns", explode)

    res = client.get("/api/pg/preview?source=bizdb&schema=public&table=orders")

    assert res.status_code == 403
    assert "pg:bizdb:public" in res.json()["error"]["message"]


def test_unlocked_schema_previews_with_the_shared_response_shape(
    client, registered, pg_enabled, monkeypatch,
):
    """응답 규약은 MSSQL 미리보기와 같다 — 화면이 같은 PreviewSection을 쓴다."""
    assert _unlock(client, pg_enabled).status_code == 200
    monkeypatch.setattr(pg, "list_columns", lambda *a, **k: [
        {"name": "id", "data_type": "integer"}, {"name": "note", "data_type": "text"},
    ])
    monkeypatch.setattr(pg, "fetch_rows",
                        lambda *a, **k: [{"id": 1, "note": "가"}, {"id": 2, "note": None}])

    body = client.get(
        "/api/pg/preview?source=bizdb&schema=public&table=orders&limit=20").json()

    assert body["object"] == "public.orders" and body["source_label"] == "업무 DB"
    assert body["columns"] == ["id", "note"]
    assert body["rows"][0] == {"id": 1, "note": "가"}
    assert body["source"] == "pg" and body["masked_columns"] == []
    audit = client.get("/api/admin/audit?action=pg_preview").json()
    assert audit["items"][0]["detail"].startswith("bizdb:public.orders (2 rows)")


def test_unlocking_is_per_source(client, registered, pg_enabled, monkeypatch):
    """같은 이름의 스키마라도 다른 연결까지 함께 열리지 않는다 / unlocks never leak across sources."""
    monkeypatch.setattr(pg, "list_columns", lambda *a, **k: [
        {"name": "id", "data_type": "integer"}])
    monkeypatch.setattr(pg, "fetch_rows", lambda *a, **k: [{"id": 1}])
    client.post("/api/admin/pg-sources", headers={"X-Preview-Password": pg_enabled},
                json={"slug": "other", "label": "다른 DB", "host": "h", "port": 5432,
                      "database": "other", "username": "u", "password": "p"})
    _unlock(client, pg_enabled, slug="bizdb", schema="public")

    assert client.get("/api/pg/preview?source=bizdb&schema=public&table=orders"
                      ).status_code == 200
    assert client.get("/api/pg/preview?source=other&schema=public&table=orders"
                      ).status_code == 403


def test_schema_list_marks_what_is_unlocked(client, registered, pg_enabled):
    _unlock(client, pg_enabled, schema="public")

    items = client.get("/api/admin/pg-sources/bizdb/schemas").json()["items"]

    assert items == [{"schema": "billing", "table_count": 1, "allowed": False},
                     {"schema": "public", "table_count": 2, "allowed": True}]


def test_removing_a_source_also_drops_its_unlocks(client, registered, pg_enabled):
    """연결 없는 유령 허용이 남으면 같은 slug를 재등록할 때 조용히 열린다."""
    _unlock(client, pg_enabled, schema="public")

    removed = client.delete("/api/admin/pg-sources/bizdb",
                            headers={"X-Preview-Password": pg_enabled}).json()

    assert removed == {"slug": "bizdb", "removed": True, "unlocked_removed": 1}
    assert client.get("/api/admin/pg-sources").json()["items"] == []
    assert client.get("/api/objects/preview-allowlist").json()["items"] == []


def test_connection_test_reports_failure_as_a_result_not_an_error(client, registered,
                                                                  monkeypatch):
    def fail(*args, **kwargs):
        raise pg.PgSourceError("connection refused")

    monkeypatch.setattr(pg, "list_tables", fail)

    body = client.post("/api/admin/pg-sources/bizdb/test").json()

    assert body["ok"] is False and "connection refused" in body["error"]


def test_connection_test_reports_the_reachable_schemas(client, registered):
    body = client.post("/api/admin/pg-sources/bizdb/test").json()

    assert body == {"ok": True, "schemas": ["billing", "public"], "table_count": 3}


def test_pg_keys_stay_out_of_the_catalog_allowlist_screen(client, registered, pg_enabled):
    """카탈로그 화면은 자기 스키마만 — `pg:` 행은 연결 관리 화면이 보여준다."""
    _unlock(client, pg_enabled, schema="public")

    assert client.get("/api/admin/preview-allowlist").json()["items"] == []
    rejected = client.post("/api/admin/preview-allowlist",
                           headers={"X-Preview-Password": pg_enabled},
                           json={"schema": "pg:bizdb:public"})
    assert rejected.status_code == 400


def test_a_stale_secret_blocks_use_instead_of_failing_silently(client, registered,
                                                               pg_enabled, monkeypatch):
    _unlock(client, pg_enabled, schema="public")
    monkeypatch.setenv("PG_SOURCE_SECRET", "rotated-key")
    get_settings.cache_clear()

    res = client.get("/api/pg/preview?source=bizdb&schema=public&table=orders")

    assert res.status_code == 503
    assert "PG_SOURCE_SECRET" in res.json()["error"]["message"]
