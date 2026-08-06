"""JoinValidator abstraction and FakeJoinValidator tests. / 검증기 추상화·Fake 테스트."""

import json
from pathlib import Path

import pytest

from app.adapters.fake_validator import FakeJoinValidator
from app.domain.validation import ColumnRef, ValidationDataMissing


@pytest.fixture()
def tiny_validator(tmp_path):
    # Arrange: 손으로 계산 가능한 초소형 값 집합 / hand-checkable value sets
    sets = {"columns": [
        {"object": "dbo.P", "column": "ID", "row_count": 5, "distinct_count": 5,
         "values": [1, 2, 3, 4, 5]},                       # 부모 — 유니크
        {"object": "dbo.C", "column": "P_ID", "row_count": 9, "distinct_count": 3,
         "values": [1, 2, 3]},                             # 자식 — 완전 포함
        {"object": "dbo.O", "column": "P_ID", "row_count": 12, "distinct_count": 4,
         "values": [1, 2, 3, 99]},                         # 자식 — 고아 1건
    ]}
    path = tmp_path / "value_sets.json"
    path.write_text(json.dumps(sets))
    return FakeJoinValidator(path)


def test_full_containment_and_cardinality(tiny_validator):
    result = tiny_validator.containment(
        ColumnRef("dbo", "C", "P_ID"), ColumnRef("dbo", "P", "ID")
    )
    assert result.containment == 1.0
    assert result.orphan_count == 0
    assert result.cardinality == "N:1"  # 타깃 유니크 / unique target


def test_orphans_reduce_containment(tiny_validator):
    result = tiny_validator.containment(
        ColumnRef("dbo", "O", "P_ID"), ColumnRef("dbo", "P", "ID")
    )
    assert result.containment == 0.75
    assert result.orphan_count == 1


def test_non_unique_target_is_nm(tiny_validator):
    # 자식↔자식 — 타깃이 유니크하지 않으면 교차 관계 / cross relation, not FK
    result = tiny_validator.containment(
        ColumnRef("dbo", "C", "P_ID"), ColumnRef("dbo", "O", "P_ID")
    )
    assert result.cardinality == "N:M"


def test_missing_value_set_raises_with_context(tiny_validator):
    with pytest.raises(ValidationDataMissing) as exc:
        tiny_validator.containment(
            ColumnRef("dbo", "NOPE", "X"), ColumnRef("dbo", "P", "ID")
        )
    assert "dbo.NOPE.X" in str(exc.value)


def test_preview_respects_limit_and_matches_only(tiny_validator):
    rows = tiny_validator.preview(
        ColumnRef("dbo", "O", "P_ID"), ColumnRef("dbo", "P", "ID"), limit=2
    )
    assert len(rows) == 2
    assert all(row["src.P_ID"] == row["tgt.ID"] for row in rows)


def test_fake_agrees_with_fixture_ground_truth(fixture_dir, load_fixture):
    """Fake 검증기 산출 == 픽스처 기대 관계 전수 / full agreement with expected relations."""
    validator = FakeJoinValidator(fixture_dir / "value_sets.json")
    relations = load_fixture("expected/relations.json")["rows"]
    assert relations
    for rel in relations:
        src_schema, src_table = rel["src_object"].split(".", 1)
        tgt_schema, tgt_table = rel["tgt_object"].split(".", 1)
        result = validator.containment(
            ColumnRef(src_schema, src_table, rel["src_column"]),
            ColumnRef(tgt_schema, tgt_table, rel["tgt_column"]),
        )
        assert abs(result.containment - rel["containment"]) < 1e-3, rel
        assert result.orphan_count == rel["orphan_count"], rel
        assert result.cardinality == rel["cardinality"], rel


def test_live_mode_requires_webhook_base_then_uses_n8n():
    from app.adapters import create_join_validator, create_table_preview
    from app.adapters.n8n_query import N8nJoinValidator, N8nTablePreview
    from app.config import Settings

    # webhook 미설정 live는 차단 — 게이트 유지 / gate holds without the executor
    with pytest.raises(RuntimeError, match="N8N_WEBHOOK_BASE"):
        create_join_validator(Settings(source_mode="live"))
    with pytest.raises(RuntimeError, match="N8N_WEBHOOK_BASE"):
        create_table_preview(Settings(source_mode="live"))

    live = Settings(source_mode="live", n8n_webhook_base="http://n8n/webhook")
    assert isinstance(create_join_validator(live), N8nJoinValidator)
    assert isinstance(create_table_preview(live), N8nTablePreview)


def test_preview_refuses_synthetic_rows_on_a_real_deployment():
    """실 원천이 붙었는데 live가 아니면 합성 행 대신 명시 실패 — 합성값은 실값과 구분되지 않는다.

    수집 경로와 같은 신호(N8N_WEBHOOK_BASE)로 실배포를 판별한다 (create_collect_runner와 동일 규칙).
    """
    from app.adapters import SyntheticDataRefused, create_table_preview
    from app.config import Settings

    real_deployment = Settings(source_mode="fixture", n8n_webhook_base="http://n8n/webhook")
    with pytest.raises(SyntheticDataRefused, match="SOURCE_MODE=live"):
        create_table_preview(real_deployment)


def test_preview_still_synthesizes_for_pure_offline_use():
    """원천이 아예 없는 순수 오프라인(로컬 UI 리뷰)에선 합성 유지 — 실값과 혼동될 여지가 없다."""
    from app.adapters import create_table_preview
    from app.adapters.table_preview import FakeTablePreview
    from app.config import Settings

    offline = Settings(source_mode="fixture", n8n_webhook_base="")
    assert isinstance(create_table_preview(offline), FakeTablePreview)


def test_fake_validator_without_value_sets_reports_data_missing(tmp_path):
    """픽스처 없는 배포에서도 검증은 '값 데이터 없음'으로 떨어진다 (크래시 아님)."""
    validator = FakeJoinValidator(tmp_path / "absent.json")
    with pytest.raises(ValidationDataMissing):
        validator.containment(ColumnRef("dbo", "O", "P_ID"), ColumnRef("dbo", "P", "ID"))


def test_relative_fixture_dir_anchors_to_repo_root_not_cwd(tmp_path, monkeypatch):
    """상대 FIXTURE_DIR은 실행 위치와 무관해야 한다 — 픽스처는 저장소 루트에 생성된다."""
    from app.config import Settings

    monkeypatch.chdir(tmp_path)
    relative = Settings(fixture_dir="fixtures").resolved_fixture_dir
    assert relative.is_absolute()
    assert relative == Path(__file__).resolve().parents[2] / "fixtures"

    # 절대 경로는 그대로 통과 — 컨테이너 마운트 지점 지정용
    absolute = Settings(fixture_dir=str(tmp_path / "mounted")).resolved_fixture_dir
    assert absolute == tmp_path / "mounted"


def test_fake_sample_stats_approximates_top_n(tmp_path):
    path = tmp_path / "value_sets.json"
    path.write_text(json.dumps({"columns": [
        {"object": "dbo.BIG", "column": "EMP_NO",
         "values": ["a", "b"], "row_count": 5000, "distinct_count": 2},
        {"object": "dbo.SMALL", "column": "EMP_NO",
         "values": ["a", "b", "c"], "row_count": 3, "distinct_count": 3},
    ]}))
    v = FakeJoinValidator(path)

    # 표본은 TOP N로 절단 — 행 수는 min(top, row_count), distinct는 표본을 못 넘는다
    assert v.sample_stats(ColumnRef("dbo", "BIG", "EMP_NO"), 200) == (200, 2)
    assert v.sample_stats(ColumnRef("dbo", "SMALL", "EMP_NO"), 200) == (3, 3)
