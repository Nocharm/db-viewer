# backend/tests/test_value_probe_planner.py
"""값 추적 플래너 — 순수 로직 테스트. / value-probe planner tests (no DB)."""

from app.domain import value_probe as vp


def _col(name, data_type, max_length=-1, **kw):
    base = dict(object_id=1, name=name, data_type=data_type, max_length=max_length,
                distinct_count=None, masking_policy=None, has_direct_lineage=False)
    base.update(kw)
    return vp.ProbeCatalogColumn(**base)


# ---------- interpret_value ----------

def test_normalized_text_variants_include_case_and_trim():
    # Arrange / Act
    interp = vp.interpret_value("  Ord-0910-001 ", "normalized")
    # Assert: 원문·trim·대문자·소문자·구분자 제거형이 순서대로, 중복 없이
    assert interp.text[:4] == ("  Ord-0910-001 ", "Ord-0910-001", "ORD-0910-001", "ord-0910-001")
    assert "Ord0910001" in interp.text
    assert len(interp.text) <= vp.PROBE_MAX_VARIANTS
    assert interp.ints == () and interp.dates == ()


def test_normalized_number_with_thousands_separator():
    interp = vp.interpret_value("1,000", "normalized")
    assert interp.ints == (1000,)
    assert interp.decimals == ("1000",)
    assert "1000" in interp.text and "1,000" in interp.text


def test_normalized_decimal_is_not_an_int():
    interp = vp.interpret_value("1000.50", "normalized")
    assert interp.ints == ()
    assert interp.decimals == ("1000.5",)


def test_normalized_date_forms():
    interp = vp.interpret_value("2026.09.10", "normalized")
    assert interp.dates == ("2026-09-10",)
    assert "20260910" in interp.text and "2026-09-10" in interp.text


def test_compact_date_is_both_date_and_int():
    interp = vp.interpret_value("20260910", "normalized")
    assert interp.dates == ("2026-09-10",)
    assert interp.ints == (20260910,)


def test_invalid_date_is_not_a_date():
    assert vp.interpret_value("2026-13-40", "normalized").dates == ()


def test_guid_is_recognized():
    interp = vp.interpret_value("3F2504E0-4F89-11D3-9A0C-0305E82C3301", "normalized")
    assert interp.guids == ("3f2504e0-4f89-11d3-9a0c-0305e82c3301",)


def test_exact_mode_keeps_only_the_raw_text():
    interp = vp.interpret_value(" 1,000 ", "exact")
    assert interp.text == (" 1,000 ",)
    assert interp.ints == () and interp.decimals == ()


def test_exact_mode_parses_plain_numbers():
    interp = vp.interpret_value("1000", "exact")
    assert interp.ints == (1000,) and interp.decimals == ("1000",)


def test_contains_mode_uses_stripped_raw_only():
    interp = vp.interpret_value(" abc ", "contains")
    assert interp.text == ("abc",)


# ---------- families ----------

def test_families_per_engine():
    assert vp.get_probe_family("mssql", "nvarchar") == vp.FAMILY_TEXT
    assert vp.get_probe_family("mssql", "timestamp") is None       # rowversion
    assert vp.get_probe_family("postgres", "timestamp") == vp.FAMILY_DATE
    assert vp.get_probe_family("postgres", "character varying") == vp.FAMILY_TEXT
    assert vp.get_probe_family("mssql", "bit") is None
    assert vp.get_probe_family("sqlite", "VARCHAR(50)") == vp.FAMILY_TEXT
    assert vp.get_probe_family("sqlite", "INTEGER") == vp.FAMILY_INT
    assert vp.get_probe_family("sqlite", "DATETIME") == vp.FAMILY_TEXT   # 텍스트로 저장된다
    assert vp.get_probe_family("sqlite", "BLOB") is None


def test_literal_kind_distinguishes_wide_text_on_mssql():
    assert vp.get_literal_kind("mssql", "varchar", vp.FAMILY_TEXT) == "text-narrow"
    assert vp.get_literal_kind("mssql", "nvarchar", vp.FAMILY_TEXT) == "text-wide"
    assert vp.get_literal_kind("postgres", "text", vp.FAMILY_TEXT) == "text-narrow"
    assert vp.get_literal_kind("mssql", "int", vp.FAMILY_INT) == "number"
    assert vp.get_literal_kind("mssql", "date", vp.FAMILY_DATE) == "date"


# ---------- select_candidate_columns ----------

def _select(columns, raw, mode="normalized", engine="mssql"):
    interp = vp.interpret_value(raw, mode)
    return vp.select_candidate_columns(columns, interp, engine, mode, 50, {"USE_YN"})


def test_text_value_skips_numeric_and_date_columns():
    cols = [_col("ORD_NO", "varchar", 20), _col("AMT", "int", 4), _col("ORD_DT", "datetime", 8)]
    picked = _select(cols, "ORD-0910-001")
    assert [c.name for _, c in picked] == ["ORD_NO"]


def test_numeric_value_hits_int_decimal_and_text_columns():
    cols = [_col("AMT", "int", 4), _col("PRICE", "decimal", 9), _col("MEMO", "nvarchar", 100)]
    picked = {c.name: c for _, c in _select(cols, "1,000")}
    assert picked["AMT"].values == (1000,) and picked["AMT"].literal == "number"
    assert picked["PRICE"].values == ("1000",)
    assert "1000" in picked["MEMO"].values and picked["MEMO"].literal == "text-wide"


def test_length_check_halves_nvarchar_bytes():
    # nvarchar(5) → max_length 10 bytes → 5 chars; "ABCDEF" (6) 안 들어간다
    cols = [_col("A", "nvarchar", 10), _col("B", "varchar", 10)]
    picked = {c.name: c for _, c in _select(cols, "ABCDEF")}
    assert "A" not in picked and "B" in picked


def test_short_variant_survives_length_check():
    # "1,000"(5자)는 char(4)에 못 들어가지만 "1000"(4자)은 들어간다
    cols = [_col("CD", "char", 4)]
    picked = {c.name: c for _, c in _select(cols, "1,000")}
    assert picked["CD"].values == ("1000",)


def test_max_length_minus_one_means_unbounded():
    assert _select([_col("BIG", "nvarchar", -1)], "x" * 90)


def test_masked_blacklisted_low_distinct_and_direct_lineage_are_dropped():
    cols = [
        _col("SSN", "varchar", 20, masking_policy="hash"),
        _col("USE_YN", "char", 1),
        _col("STATUS", "varchar", 10, distinct_count=3),
        _col("V_COL", "varchar", 20, has_direct_lineage=True),
        _col("KEEP", "varchar", 20, distinct_count=None),
    ]
    assert [c.name for _, c in _select(cols, "Y")] == ["KEEP"]


def test_contains_mode_only_text_columns_with_like_op():
    cols = [_col("NM", "nvarchar", 100), _col("AMT", "int", 4)]
    picked = _select(cols, "kim", mode="contains")
    assert [(c.name, c.op, c.values) for _, c in picked] == [("NM", "contains", ("kim",))]


def test_variants_are_capped():
    cols = [_col("NM", "nvarchar", 200)]
    (_, col), = _select(cols, "2026-09-10 aB")
    assert len(col.values) <= vp.PROBE_MAX_VARIANTS


# ---------- ProbeColumn round trip ----------

def test_probe_column_round_trips_through_dict():
    col = vp.ProbeColumn("AMT", vp.FAMILY_INT, "number", (1000,), "eq")
    assert vp.ProbeColumn.from_dict(col.to_dict()) == col


# ---------- match_cell / match_columns ----------

def test_match_text_trims_and_reports_the_variant():
    col = vp.ProbeColumn("NM", vp.FAMILY_TEXT, "text-narrow", ("kim", "KIM"))
    assert vp.match_cell("KIM  ", col) == "KIM"
    assert vp.match_cell("kimchi", col) is None
    assert vp.match_cell(None, col) is None


def test_match_numbers_compares_numerically():
    col = vp.ProbeColumn("AMT", vp.FAMILY_DECIMAL, "number", ("1000",))
    assert vp.match_cell("1000.00", col) == "1000"
    assert vp.match_cell(1000, col) == "1000"
    assert vp.match_cell("abc", col) is None


def test_match_date_requires_midnight_when_value_has_no_time():
    col = vp.ProbeColumn("DT", vp.FAMILY_DATE, "date", ("2026-09-10",))
    assert vp.match_cell("2026-09-10T00:00:00", col) == "2026-09-10"
    assert vp.match_cell("2026-09-10 14:30:00", col) is None
    timed = vp.ProbeColumn("DT", vp.FAMILY_DATE, "date", ("2026-09-10 14:30:00",))
    assert vp.match_cell("2026-09-10T14:30:00", timed) == "2026-09-10 14:30:00"


def test_match_contains_is_case_insensitive():
    col = vp.ProbeColumn("NM", vp.FAMILY_TEXT, "text-narrow", ("kim",), "contains")
    assert vp.match_cell("Mr. KIM", col) == "kim"


def test_match_columns_returns_only_matches():
    cols = [vp.ProbeColumn("A", vp.FAMILY_TEXT, "text-narrow", ("x",)),
            vp.ProbeColumn("B", vp.FAMILY_INT, "number", (5,))]
    matched = vp.match_columns({"A": "y", "B": "5"}, cols)
    assert [(m.name, m.matched_variant) for m in matched] == [("B", "5")]
