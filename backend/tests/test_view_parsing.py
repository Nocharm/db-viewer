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


def test_commented_out_sql_is_never_parsed():
    """주석 속 옛 쿼리(조인·테이블)가 살아있는 관계로 오인되면 안 된다."""
    from app.domain.view_parsing import parse_view, strip_sql_comments

    parsed = parse_view("""CREATE VIEW dbo.V_C AS
    /* 구버전 백업
       SELECT a.ID FROM dbo.OLD_TBL a
       LEFT JOIN dbo.DEAD_TBL b ON a.ID = b.ID  /* 중첩 메모 */
    */
    SELECT t.EMP_NO  -- JOIN dbo.GHOST g ON t.EMP_NO = g.EMP_NO
    FROM dbo.HR_EMP t
    """)
    assert parsed.status == "ok"
    assert parsed.joins == []  # 주석 속 조인은 증거가 아니다
    sources = {src.name for out in parsed.outputs for src, _ in out.sources}
    assert sources == {"HR_EMP"}

    # 문자열·식별자 안의 주석 기호는 보존 / comment markers inside literals survive
    kept = strip_sql_comments(
        "SELECT '--not comment' AS A, [weird--name] AS B, 'it''s /*fine*/' AS C FROM T"
    )
    assert "'--not comment'" in kept
    assert "[weird--name]" in kept
    assert "'it''s /*fine*/'" in kept

    # 미종결 블록 주석은 끝까지 제거 / unterminated block comment strips to EOF
    assert strip_sql_comments("SELECT 1 /* dangling").strip() == "SELECT 1"
