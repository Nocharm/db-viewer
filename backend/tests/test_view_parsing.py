"""sqlglot view parser unit tests. / 뷰 파서 단위 테스트."""

from app.domain.view_parsing import parse_view


def test_simple_projection_is_direct():
    p = parse_view("CREATE VIEW dbo.V AS SELECT A, B FROM dbo.T")
    assert p.status == "ok"
    assert [(o.name, o.kind) for o in p.outputs] == [("A", "direct"), ("B", "direct")]
    assert all(src.qname == "dbo.T" for o in p.outputs for src, _ in o.sources)


def test_aliased_join_extracts_pairs_and_types():
    p = parse_view(
        "CREATE VIEW dbo.V AS SELECT c.A, p.B FROM dbo.C c "
        "LEFT JOIN dbo.P p ON c.PID = p.ID AND c.SUB = p.SUB"
    )
    assert p.status == "ok"
    pairs = {(j.left[0].qname, j.left[1], j.right[0].qname, j.right[1], j.join_type)
             for j in p.joins}
    assert pairs == {
        ("dbo.C", "PID", "dbo.P", "ID", "left"),
        ("dbo.C", "SUB", "dbo.P", "SUB", "left"),
    }


def test_expression_column_is_derived_with_sources():
    p = parse_view("CREATE VIEW dbo.V AS SELECT CONCAT(A, '-', B) AS AB FROM dbo.T")
    assert p.status == "ok"
    assert p.outputs[0].kind == "derived"
    assert {c for _, c in p.outputs[0].sources} == {"A", "B"}


def test_select_star_single_source():
    p = parse_view("CREATE VIEW dbo.V AS SELECT * FROM dbo.T")
    assert p.status == "ok"
    assert p.select_star_source is not None and p.select_star_source.qname == "dbo.T"


def test_cross_database_reference_is_detected():
    p = parse_view(
        "CREATE VIEW dbo.V AS SELECT l.K, r.X FROM dbo.L l "
        "JOIN OTHER_DB.dbo.R r ON l.K = r.K"
    )
    assert p.cross_databases == ["OTHER_DB"]
    r_source = next(o for o in p.outputs if o.name == "X").sources[0][0]
    assert r_source.database == "OTHER_DB"


def test_pivot_is_not_ok():
    p = parse_view(
        "CREATE VIEW dbo.V AS SELECT * FROM dbo.T PIVOT (SUM(A) FOR B IN ([X],[Y])) AS pv"
    )
    # sqlglot 버전에 따라 파싱 자체가 실패할 수도 있다 — 어느 쪽이든 ok는 아니어야 한다
    assert p.status in ("unsupported", "parse_failed")


def test_garbage_sql_is_isolated_as_parse_failed():
    p = parse_view("CREATE VIEW dbo.V AS SELEC A FRM T")
    assert p.status == "parse_failed"
    assert p.error


def test_constant_expression_carries_no_lineage_but_stays_ok():
    p = parse_view("CREATE VIEW dbo.V AS SELECT 1 AS ONE, A FROM dbo.T")
    assert p.status == "ok"
    assert [o.name for o in p.outputs] == ["A"]


def test_unqualified_column_over_multiple_tables_is_partial():
    p = parse_view(
        "CREATE VIEW dbo.V AS SELECT A FROM dbo.T1 t1 JOIN dbo.T2 t2 ON t1.K = t2.K"
    )
    assert p.status == "partial"
