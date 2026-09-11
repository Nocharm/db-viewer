"""값 추적 SQL 빌더 — 보안 경계와 타입별 바인딩. / probe SQL builder tests."""

import uuid
from datetime import date, datetime
from decimal import Decimal

import pytest

from app.sources.preview_sql import UnknownIdentifier, build_count_sql, build_probe_sql

TEXT = {"name": "ord_no", "family": "text", "literal": "text-narrow", "values": ["A", "a"], "op": "eq"}
INT = {"name": "amt", "family": "int", "literal": "number", "values": [1000], "op": "eq"}
ALLOWED = {"ord_no", "amt", "dt", "gid", "price"}


def test_probe_sql_one_or_clause_per_column_with_bound_values():
    sql, params = build_probe_sql("main", "orders", [TEXT, INT], ALLOWED, "sqlite")
    assert sql == ('SELECT "ord_no", "amt" FROM "main"."orders" '
                   'WHERE "ord_no" IN (:p0_0, :p0_1) OR "amt" IN (:p1_0) LIMIT 1')
    assert params == {"p0_0": "A", "p0_1": "a", "p1_0": 1000}


def test_probe_sql_rejects_columns_outside_the_catalog():
    with pytest.raises(UnknownIdentifier):
        build_probe_sql("main", "orders", [{**TEXT, "name": "evil"}], ALLOWED, "sqlite")


def test_probe_sql_contains_uses_escaped_like():
    col = {**TEXT, "op": "contains", "values": ["50%"]}
    sql, params = build_probe_sql("main", "orders", [col], ALLOWED, "sqlite")
    assert '"ord_no" LIKE :p0_0 ESCAPE \'\\\'' in sql
    assert params == {"p0_0": "%50\\%%"}


def test_probe_sql_binds_typed_values_for_postgres():
    cols = [
        {"name": "dt", "family": "date", "literal": "date", "values": ["2026-09-10", "2026-09-10 14:30:00"], "op": "eq"},
        {"name": "gid", "family": "guid", "literal": "guid", "values": ["3f2504e0-4f89-11d3-9a0c-0305e82c3301"], "op": "eq"},
        {"name": "price", "family": "decimal", "literal": "number", "values": ["1000.5"], "op": "eq"},
    ]
    _, params = build_probe_sql("public", "t", cols, ALLOWED, "postgresql")
    assert params["p0_0"] == date(2026, 9, 10)
    assert params["p0_1"] == datetime(2026, 9, 10, 14, 30)
    assert params["p1_0"] == uuid.UUID("3f2504e0-4f89-11d3-9a0c-0305e82c3301")
    assert params["p2_0"] == Decimal("1000.5")


def test_probe_sql_binds_decimal_as_float_on_sqlite():
    col = {"name": "price", "family": "decimal", "literal": "number", "values": ["1000.5"], "op": "eq"}
    _, params = build_probe_sql("main", "t", [col], ALLOWED, "sqlite")
    assert params == {"p0_0": 1000.5}


def test_count_sql_caps_via_inner_limit():
    sql, params = build_count_sql("main", "orders", INT, ALLOWED, 1000, "sqlite")
    assert sql == ('SELECT COUNT(*) AS n FROM (SELECT 1 AS x FROM "main"."orders" '
                   'WHERE "amt" IN (:p0_0) LIMIT 1001) q')
    assert params == {"p0_0": 1000}


def test_probe_sql_needs_at_least_one_column():
    with pytest.raises(UnknownIdentifier):
        build_probe_sql("main", "orders", [], ALLOWED, "sqlite")
