"""Secondary Postgres source — SQL building, gate, preview shape.
/ 업무 Postgres 소스 — 질의 조립·게이트·미리보기 응답 규약.

실 Postgres 없이 도는 테스트다: 순수 조립 함수는 SQL 문자열로 검증하고, API는
어댑터를 가짜로 바꿔 규약(게이트 → 조회 → 감사 로그)만 확인한다.
"""

import pytest

from app.adapters import pg_source
from app.config import get_settings

DSN = "postgresql://viewer_ro:pw@172.17.0.1:5432/bizdb"


@pytest.fixture()
def pg_enabled(monkeypatch):
    monkeypatch.setenv("PG_SOURCE_DSN", DSN)
    get_settings.cache_clear()
    yield DSN
    monkeypatch.delenv("PG_SOURCE_DSN", raising=False)
    get_settings.cache_clear()


def _sql(schema, table, columns, limit, filters):
    query, params = pg_source.build_rows_query(schema, table, columns, limit, filters)
    return query.as_string(None), params


def test_identifiers_are_quoted_and_values_are_bound():
    """식별자만 인용하고 값은 전부 바인딩 — 문자열 보간 금지 규칙의 실행 가능한 형태."""
    sql, params = _sql("public", "order; drop", ["id", 'we"ird'], 20, [])

    assert sql == 'SELECT "id", "we""ird" FROM "public"."order; drop" LIMIT %s'
    assert params == [20]


@pytest.mark.parametrize(("op", "expected_sql", "expected_params"), [
    ("contains", '"note"::text ILIKE %s', ["%A%"]),
    ("not_contains", '"note"::text NOT ILIKE %s', ["%A%"]),
    ("eq", "upper(\"note\"::text) = upper(%s)", ["A"]),
    ("neq", "upper(\"note\"::text) <> upper(%s)", ["A"]),
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


def test_describe_dsn_hides_the_password():
    """상태 API가 그대로 내보내는 값이라 자격증명이 섞이면 안 된다."""
    described = pg_source.describe_dsn(DSN)

    assert described == {"host": "172.17.0.1", "port": "5432",
                         "database": "bizdb", "user": "viewer_ro"}
    assert "pw" not in str(described)


def test_source_is_off_until_the_dsn_is_configured(client):
    status = client.get("/api/pg/status").json()
    assert status["enabled"] is False and status["connection"] is None
    assert client.get("/api/pg/tables").status_code == 503
    assert client.get("/api/pg/preview?schema=public&table=orders").status_code == 503


def test_preview_is_denied_until_the_schema_is_allowed(client, pg_enabled, monkeypatch):
    """게이트가 연결보다 먼저 — 허용 목록에 없으면 소스에 질의조차 하지 않는다."""
    def explode(*args, **kwargs):  # pragma: no cover - 호출되면 테스트가 실패한다
        raise AssertionError("the source must not be queried before the gate passes")

    monkeypatch.setattr(pg_source, "list_columns", explode)

    res = client.get("/api/pg/preview?schema=public&table=orders")

    assert res.status_code == 403
    assert "pg:public" in res.json()["error"]["message"]


def test_allowed_schema_previews_with_the_shared_response_shape(
    client, pg_enabled, allow_preview, monkeypatch,
):
    """응답 규약은 MSSQL 미리보기와 같다 — 화면이 같은 PreviewSection을 쓴다."""
    allow_preview("pg:public")
    monkeypatch.setattr(pg_source, "list_columns", lambda *a, **k: [
        {"name": "id", "data_type": "integer"}, {"name": "note", "data_type": "text"},
    ])
    monkeypatch.setattr(pg_source, "fetch_rows",
                        lambda *a, **k: [{"id": 1, "note": "가"}, {"id": 2, "note": None}])

    body = client.get("/api/pg/preview?schema=public&table=orders&limit=20").json()

    assert body["object"] == "public.orders"
    assert body["columns"] == ["id", "note"]
    assert body["rows"][0] == {"id": 1, "note": "가"}
    assert body["source"] == "pg" and body["masked_columns"] == []
    audit = client.get("/api/admin/audit?action=pg_preview").json()
    assert audit["items"][0]["detail"].startswith("pg:public.orders (2 rows)")


def test_unknown_table_is_a_404_not_an_empty_preview(client, pg_enabled, allow_preview,
                                                     monkeypatch):
    allow_preview("pg:public")
    monkeypatch.setattr(pg_source, "list_columns", lambda *a, **k: [])

    res = client.get("/api/pg/preview?schema=public&table=nope")

    assert res.status_code == 404


def test_source_failure_surfaces_as_502_with_the_reason(client, pg_enabled, allow_preview,
                                                        monkeypatch):
    allow_preview("pg:public")

    def fail(*args, **kwargs):
        raise pg_source.PgSourceError("connection refused")

    monkeypatch.setattr(pg_source, "list_columns", fail)

    res = client.get("/api/pg/preview?schema=public&table=orders")

    assert res.status_code == 502
    assert "connection refused" in res.json()["error"]["message"]


def test_admin_rejects_a_pg_schema_that_the_source_does_not_have(client, pg_enabled,
                                                                 monkeypatch):
    """오타 방어 — `pg:` 키는 카탈로그가 아니라 소스에 실재를 묻는다."""
    monkeypatch.setenv("PREVIEW_ADMIN_PASSWORD", "s3cret")
    get_settings.cache_clear()
    monkeypatch.setattr(pg_source, "list_tables", lambda *a, **k: [
        {"schema": "public", "name": "orders", "type": "table", "row_estimate": 10},
    ])

    headers = {"X-Preview-Password": "s3cret"}
    bad = client.post("/api/admin/preview-allowlist", headers=headers,
                      json={"schema": "pg:ghost"})
    good = client.post("/api/admin/preview-allowlist", headers=headers,
                       json={"schema": "pg:public", "note": "업무 DB 확인용"})

    assert bad.status_code == 400
    assert good.status_code == 200 and good.json()["created"] is True
    assert "pg:public" in client.get("/api/objects/preview-allowlist").json()["items"]
