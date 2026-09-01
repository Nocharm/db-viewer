"""미리보기 SQL 빌더 — 파라미터화·식별자 화이트리스트·op 의미.
/ preview SQL builder: parameterisation, identifier allowlist, operator semantics."""

import pytest

from app.sources.preview_sql import UnknownIdentifier, build_preview_sql

COLUMNS = ["id", "status", "name"]
ALLOWED = {"id", "status", "name"}


def test_builds_unfiltered_select():
    # Act
    sql, params = build_preview_sql("public", "orders", COLUMNS, [], 20, ALLOWED)

    # Assert
    assert sql == 'SELECT "id", "status", "name" FROM "public"."orders" LIMIT 20'
    assert params == {}


def test_contains_is_case_insensitive_and_parameterised():
    # Act
    sql, params = build_preview_sql(
        "public", "orders", COLUMNS,
        [{"column": "status", "op": "contains", "value": "paid"}], 20, ALLOWED)

    # Assert: 값은 파라미터로만 나간다 — SQL 텍스트에 사용자 값이 없다
    assert "paid" not in sql
    assert 'UPPER(CAST("status" AS TEXT)) LIKE UPPER(:p0)' in sql
    assert params == {"p0": "%paid%"}


def test_negative_ops_include_nulls():
    # Arrange/Act: fixture 구현이 NULL을 빈 문자열로 취급해 매칭시킨다 — 그 의미에 맞춘다
    sql, _ = build_preview_sql(
        "public", "orders", COLUMNS,
        [{"column": "status", "op": "not_contains", "value": "paid"}], 20, ALLOWED)

    # Assert
    assert sql.count('"status" IS NULL OR NOT (') == 1


def test_null_ops_take_no_parameter():
    # Act
    sql, params = build_preview_sql(
        "public", "orders", COLUMNS,
        [{"column": "status", "op": "is_null", "value": None}], 20, ALLOWED)

    # Assert
    assert '"status" IS NULL' in sql
    assert params == {}


def test_like_metacharacters_are_escaped():
    # Act: 사용자가 넣은 %는 와일드카드가 아니라 리터럴이어야 한다
    _, params = build_preview_sql(
        "public", "orders", COLUMNS,
        [{"column": "name", "op": "contains", "value": "50%_off"}], 20, ALLOWED)

    # Assert
    assert params == {"p0": r"%50\%\_off%"}


def test_multiple_conditions_are_and_combined():
    # Act
    sql, params = build_preview_sql(
        "public", "orders", COLUMNS,
        [{"column": "status", "op": "eq", "value": "paid"},
         {"column": "name", "op": "not_null", "value": None}], 20, ALLOWED)

    # Assert
    assert " AND " in sql
    assert params == {"p0": "paid"}


@pytest.mark.parametrize("bad", ["password", 'id" FROM secrets --', "ID"])
def test_rejects_columns_outside_the_catalog(bad):
    # Act / Assert: 카탈로그에 없는 이름은 식별자 자리에 절대 못 들어간다
    with pytest.raises(UnknownIdentifier):
        build_preview_sql("public", "orders", COLUMNS,
                          [{"column": bad, "op": "eq", "value": "x"}], 20, ALLOWED)


def test_rejects_select_columns_outside_the_catalog():
    # Act / Assert
    with pytest.raises(UnknownIdentifier):
        build_preview_sql("public", "orders", ["id", "evil"], [], 20, ALLOWED)


def test_falsy_value_numeric_zero_converted_to_string():
    # Arrange/Act: numeric 0 must be converted to string "0" for UPPER(:pN) compatibility
    _, params = build_preview_sql(
        "public", "orders", COLUMNS,
        [{"column": "id", "op": "eq", "value": 0}], 20, ALLOWED)

    # Assert: value must be stringified for SQL type safety (UPPER works on text)
    assert params == {"p0": "0"}


def test_falsy_value_empty_string_preserved():
    # Arrange/Act: "" should remain "" (falsy but not None)
    _, params = build_preview_sql(
        "public", "orders", COLUMNS,
        [{"column": "status", "op": "contains", "value": ""}], 20, ALLOWED)

    # Assert
    assert params == {"p0": "%%"}


def test_numeric_value_in_contains_not_crash():
    # Arrange/Act: numeric 0 in contains must not crash escape_like (needs stringification)
    _, params = build_preview_sql(
        "public", "orders", COLUMNS,
        [{"column": "id", "op": "contains", "value": 0}], 20, ALLOWED)

    # Assert: should safely convert to string and wrap in LIKE pattern
    assert params == {"p0": "%0%"}


def test_none_value_in_eq_becomes_empty_string():
    # Arrange/Act: None value should convert to empty string for eq operator
    _, params = build_preview_sql(
        "public", "orders", COLUMNS,
        [{"column": "id", "op": "eq", "value": None}], 20, ALLOWED)

    # Assert: None → "" (different from is_null which is separate)
    assert params == {"p0": ""}
