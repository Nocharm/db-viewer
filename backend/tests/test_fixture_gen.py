"""Fixture generator regression tests. / 픽스처 생성기 회귀 테스트."""

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import fixture_gen  # noqa: E402


@pytest.fixture(scope="module")
def fx(tmp_path_factory):
    # Arrange: 시드 42로 1세트 생성 / one fixture set with seed 42
    out = tmp_path_factory.mktemp("fixtures")
    fixture_gen.generate(seed=42, out_dir=out)

    def load(name: str) -> dict:
        return json.loads((out / name).read_text())

    return load


def test_scale_matches_plan(fx):
    counts = fx("manifest.json")["counts"]
    assert counts["tables"] == 409
    assert 9000 <= counts["table_columns"] <= 9100
    assert counts["views"] >= 80
    assert counts["fk_constraints"] > 100
    assert counts["relations"] > counts["fk_constraints"]  # real_no_fk 포함


def test_required_cases_present(fx):
    cc = fx("manifest.json")["case_counts"]
    expected_minimums = {
        "select_star": 5, "nested3": 4, "deep_chain_exceeded": 2, "cycle": 2,
        "crossdb": 3, "stale_unresolved": 3, "definition_null": 4,
        "parse_challenge": 6, "dmv_failed": 3, "computed_table_columns": 15,
        "derived_view_columns": 1, "low_cardinality": 100,
    }
    for case, minimum in expected_minimums.items():
        assert cc.get(case, 0) >= minimum, f"case {case}: {cc.get(case, 0)} < {minimum}"


def test_deterministic_output(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    fixture_gen.generate(seed=42, out_dir=a)
    fixture_gen.generate(seed=42, out_dir=b)
    for name in ("catalog.json", "view_deps.json", "value_sets.json",
                 "expected/lineage_phase1.json", "expected/relations.json"):
        assert (a / name).read_bytes() == (b / name).read_bytes(), name


def test_catalog_integrity(fx):
    catalog = fx("catalog.json")
    oids = {o["object_id"] for o in catalog["objects"]}
    assert len(oids) == len(catalog["objects"])  # object_id 유일성
    names = {(o["schema"], o["name"]) for o in catalog["objects"]}
    assert len(names) == len(catalog["objects"])  # 이름 유일성

    cols_by_oid: dict[int, set] = {}
    for c in catalog["columns"]:
        assert c["object_id"] in oids
        cols_by_oid.setdefault(c["object_id"], set()).add(c["name"])
    for fk in catalog["foreign_keys"]:
        assert fk["src_object_id"] in oids and fk["tgt_object_id"] in oids
        for pair in fk["columns"]:
            assert pair["src_column"] in cols_by_oid[fk["src_object_id"]]
            assert pair["tgt_column"] in cols_by_oid[fk["tgt_object_id"]]

    # 권한 차단 뷰는 definition NULL / permission-blocked views carry NULL definitions
    assert sum(1 for vd in catalog["view_definitions"] if vd["definition"] is None) >= 4


def test_deps_reference_known_objects(fx):
    catalog, view_deps = fx("catalog.json"), fx("view_deps.json")
    oids = {o["object_id"] for o in catalog["objects"]}
    view_oids = {o["object_id"] for o in catalog["objects"] if o["type"] == "view"}
    for dep in view_deps["deps"]:
        assert dep["view_object_id"] in view_oids
        if dep["is_resolved"]:
            assert dep["referenced_object_id"] in oids
        else:
            # 미해석 참조는 텍스트 식별자를 반드시 보존 / unresolved must keep textual identity
            assert dep["referenced_object_id"] is None
            assert dep["referenced_name"]
    assert len(view_deps["unresolved_objects"]) >= 3


def test_phase1_lineage_refers_to_catalog(fx):
    catalog = fx("catalog.json")
    by_qname = {f"{o['schema']}.{o['name']}": o for o in catalog["objects"]}
    cols_by_oid: dict[int, set] = {}
    for c in catalog["columns"]:
        cols_by_oid.setdefault(c["object_id"], set()).add(c["name"])

    rows = fx("expected/lineage_phase1.json")["rows"]
    flags = {r["flag"] for r in rows}
    assert {"cycle", "depth_exceeded"} <= flags
    for r in rows:
        assert r["view"] in by_qname
        if r["flag"] is None:
            base = by_qname[r["base"]]
            assert base["type"] == "table"
            if r["base_column"] is not None:
                assert r["base_column"] in cols_by_oid[base["object_id"]]
            assert 1 <= r["depth"] <= fx("manifest.json")["depth_limit"]

    # 체인 11·12는 flag, 10 이하는 정상 해석 / chain 11-12 flagged, <=10 resolved
    chain_flagged = {r["view"] for r in rows if r["flag"] == "depth_exceeded"}
    assert {"dbo.V_CHAIN_11", "dbo.V_CHAIN_12"} <= chain_flagged
    assert any(r["view"] == "dbo.V_CHAIN_10" and r["flag"] is None for r in rows)


def test_value_set_containment_invariant(fx):
    sets = {(v["object"], v["column"]): v for v in fx("value_sets.json")["columns"]}
    relations = fx("expected/relations.json")["rows"]
    checked = 0
    for rel in relations:
        src = sets[(rel["src_object"], rel["src_column"])]
        tgt = sets[(rel["tgt_object"], rel["tgt_column"])]
        src_vals, tgt_vals = set(src["values"]), set(tgt["values"])
        containment = len(src_vals & tgt_vals) / len(src_vals)
        assert abs(containment - rel["containment"]) < 1e-3, rel
        assert len(src_vals - tgt_vals) == rel["orphan_count"], rel
        checked += 1
    assert checked == len(relations)  # 모든 관계에 값 집합 존재


def test_join_expectations_use_relation_columns(fx):
    joins = fx("expected/joins.json")["rows"]
    relations = fx("expected/relations.json")["rows"]
    rel_keys = {(r["src_object"], r["src_column"], r["tgt_object"], r["tgt_column"])
                for r in relations}
    assert len(joins) == 18
    for j in joins:
        key = (j["left_object"], j["left_column"], j["right_object"], j["right_column"])
        assert key in rel_keys
    in_view = {r["in_view_join"] for r in relations}
    assert in_view == {True, False}  # 뷰 JOIN에 나온 관계와 아닌 관계 모두 존재
