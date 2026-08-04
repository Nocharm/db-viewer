"""LLM adapter tests with mocked HTTP. / 사내 LLM 어댑터 테스트 (HTTP 목킹)."""

import io
import json
from urllib.error import URLError

import pytest

from app.adapters import llm_ai
from app.adapters.ai import ColumnMeta, CandidatePair, TableMeta, ValidationFacts, ViewFacts
from app.adapters.llm_ai import (
    AiUnavailableError, LlmAiClient, _extract_json, _post_chat,
    filter_search_candidates,
)
from app.config import Settings


def test_ai_settings_defaults():
    s = Settings(_env_file=None)  # 개발자 로컬 .env 간섭 차단
    assert s.ai_base_url == ""
    assert s.ai_model == ""
    assert s.ai_api_key == ""
    assert s.ai_timeout == 60
    assert s.ai_suggest_max_pairs == 40


class _FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _chat_body(content: str) -> bytes:
    return json.dumps({"choices": [{"message": {"content": content}}]}).encode()


@pytest.fixture()
def captured(monkeypatch):
    """urlopen을 가로채 요청 기록 + 준비된 응답 반환 / capture request, return canned reply."""
    calls: dict = {"requests": [], "content": "{}"}

    def fake_urlopen(request, timeout=None):
        calls["requests"].append(request)
        calls["timeout"] = timeout
        return _FakeResponse(_chat_body(calls["content"]))

    monkeypatch.setattr(llm_ai.urllib.request, "urlopen", fake_urlopen)
    return calls


def test_post_chat_sends_openai_payload_with_auth(captured):
    captured["content"] = '{"ok": true}'
    text = _post_chat("http://llm:11434/v1/", "test-model", "sk-x", 30,
                      system="시스템", user="유저")
    assert text == '{"ok": true}'
    req = captured["requests"][0]
    assert req.full_url == "http://llm:11434/v1/chat/completions"  # 슬래시 정규화
    assert req.get_header("Authorization") == "Bearer sk-x"
    body = json.loads(req.data.decode())
    assert body["model"] == "test-model"
    assert body["temperature"] == 0
    assert [m["role"] for m in body["messages"]] == ["system", "user"]


def test_post_chat_omits_auth_header_without_key(captured):
    _post_chat("http://llm:11434/v1", "m", "", 30, system="s", user="u")
    assert captured["requests"][0].get_header("Authorization") is None


def test_post_chat_retries_then_raises(monkeypatch):
    attempts = []

    def failing_urlopen(request, timeout=None):
        attempts.append(1)
        raise URLError("connection refused")

    monkeypatch.setattr(llm_ai.urllib.request, "urlopen", failing_urlopen)
    with pytest.raises(AiUnavailableError) as exc:
        _post_chat("http://llm:11434/v1", "m", "", 5, system="s", user="u")
    assert len(attempts) == 2  # 1회 재시도 후 포기
    assert exc.value.context["url"].endswith("/chat/completions")


def test_extract_json_handles_code_fences():
    assert _extract_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert _extract_json('설명 텍스트 {"a": 1} 끝') == {"a": 1}
    assert _extract_json('{"a": 1}') == {"a": 1}


def test_extract_json_rejects_non_json():
    with pytest.raises(AiUnavailableError):
        _extract_json("JSON 없이 사과문만")
    with pytest.raises(AiUnavailableError):
        _extract_json('{"broken": ')


# Task 4: LlmAiClient.judge_relations


def _pair(i: int) -> CandidatePair:
    return CandidatePair(
        src_object=f"dbo.SRC{i}", src_column="EMP_NO", src_type="int",
        src_is_pk=False, src_row_count=1000,
        tgt_object="dbo.HR_EMP", tgt_column="EMP_NO", tgt_type="int",
        tgt_is_pk=True, tgt_row_count=200,
        score=60, signals=["key", "naming"],
    )


def _client() -> LlmAiClient:
    return LlmAiClient(base_url="http://llm:11434/v1", model="m", api_key="", timeout=30)


def test_judge_relations_maps_accepted_indices(captured):
    captured["content"] = json.dumps({"judgements": [
        {"index": 0, "accept": True, "reason": "사번 참조"},
        {"index": 1, "accept": False, "reason": "무관"},
    ]}, ensure_ascii=False)
    accepted = _client().judge_relations([_pair(0), _pair(1)])
    assert len(accepted) == 1
    assert accepted[0].src_object == "dbo.SRC0"
    assert accepted[0].reason == "사번 참조"
    # 프롬프트에 메타데이터가 실린다 — 판정 재료 검증
    user_msg = json.loads(captured["requests"][0].data.decode())["messages"][1]["content"]
    assert "dbo.SRC0" in user_msg and "EMP_NO" in user_msg and "signals" in user_msg


def test_judge_relations_drops_hallucinated_indices(captured):
    captured["content"] = json.dumps({"judgements": [
        {"index": 7, "accept": True, "reason": "없는 인덱스"},
        {"index": "0", "accept": True, "reason": "타입 오류"},
    ]})
    assert _client().judge_relations([_pair(0)]) == []


def test_judge_relations_skips_llm_when_empty(captured):
    assert _client().judge_relations([]) == []
    assert captured["requests"] == []  # 빈 입력엔 호출 자체가 없다


def test_judge_relations_defaults_reason_when_missing(captured):
    captured["content"] = json.dumps({"judgements": [
        {"index": 0, "accept": True},
    ]})
    accepted = _client().judge_relations([_pair(0)])
    assert len(accepted) == 1
    assert accepted[0].reason == "LLM accepted"


# Task 5: LlmAiClient.search_tables


def test_prefilter_matches_table_and_column_names():
    tables = [
        TableMeta("dbo.T_SHP_RSLT", [ColumnMeta("SHIP_QTY", "int")]),
        TableMeta("dbo.T_QC_JUDGE", [ColumnMeta("LOT_NO", "varchar")]),
        TableMeta("dbo.T_HR_MST", [ColumnMeta("EMP_NO", "int")]),
    ]
    # 테이블명 매칭 + 컬럼명 매칭 — 둘 다 잡혀야 한다
    assert [t.qname for t in filter_search_candidates("SHP RSLT", tables)] == ["dbo.T_SHP_RSLT"]
    assert [t.qname for t in filter_search_candidates("LOT_NO", tables)] == ["dbo.T_QC_JUDGE"]
    assert filter_search_candidates("ZZQX_NOPE", tables) == []


def test_prefilter_caps_results():
    tables = [TableMeta(f"dbo.T_ORD_{i:04d}", []) for i in range(80)]
    assert len(filter_search_candidates("ORD", tables, limit=50)) == 50


def test_search_tables_reranks_and_drops_unknown_qnames(captured):
    captured["content"] = json.dumps({"items": [
        {"qname": "dbo.T_SHP_RSLT", "score": 0.9, "reason": "출하 실적"},
        {"qname": "dbo.HALLUCINATED", "score": 1.0, "reason": "환각"},
        {"qname": "dbo.T_SHP_PLAN", "score": "bad", "reason": "점수 불량"},
    ]}, ensure_ascii=False)
    tables = [
        TableMeta("dbo.T_SHP_RSLT", [ColumnMeta("SHIP_QTY", "int")]),
        TableMeta("dbo.T_SHP_PLAN", [ColumnMeta("PLAN_QTY", "int")]),
    ]
    hits = _client().search_tables("SHP", tables)
    assert [h.qname for h in hits] == ["dbo.T_SHP_RSLT", "dbo.T_SHP_PLAN"]
    assert hits[0].score == 0.9
    assert hits[1].score == 0.0  # 불량 점수는 0으로 강등, 환각 qname은 제거


def test_search_tables_skips_llm_when_prefilter_empty(captured):
    tables = [TableMeta("dbo.T_HR_MST", [ColumnMeta("EMP_NO", "int")])]
    assert _client().search_tables("ZZQX_NOPE", tables) == []
    assert captured["requests"] == []


def test_search_tables_clamps_rounds_and_zeroes_nan(captured):
    # json.loads는 NaN 리터럴을 허용한다 — dumps로는 못 만들어 raw 문자열 사용
    captured["content"] = (
        '{"items": ['
        '{"qname": "dbo.T_A", "score": 1.5, "reason": "over"},'
        '{"qname": "dbo.T_B", "score": -0.4, "reason": "under"},'
        '{"qname": "dbo.T_C", "score": 0.867, "reason": "round"},'
        '{"qname": "dbo.T_D", "score": NaN, "reason": "nan"}]}'
    )
    tables = [TableMeta(f"dbo.T_{c}", [ColumnMeta("T_COL", "int")]) for c in "ABCD"]
    hits = {h.qname: h.score for h in _client().search_tables("T", tables)}
    assert hits["dbo.T_A"] == 1.0
    assert hits["dbo.T_B"] == 0.0
    assert hits["dbo.T_C"] == 0.87
    assert hits["dbo.T_D"] == 0.0


def test_prefilter_returns_empty_for_blank_or_underscore_query():
    tables = [TableMeta("dbo.T_ORD", [ColumnMeta("ORD_NO", "int")])]
    assert filter_search_candidates("   ", tables) == []
    assert filter_search_candidates("___", tables) == []


# Task 6: LlmAiClient.summarize_table, explain_validation, explain_view


def test_summarize_table_sends_metadata_returns_text(captured):
    captured["content"] = '{"text": "사원 마스터 테이블"}'
    table = TableMeta("dbo.HR_EMP", [ColumnMeta("EMP_NO", "int", is_pk=True)], row_count=200)
    text = _client().summarize_table(table, base_tables=["dbo.HR_ORG"])
    assert text == "사원 마스터 테이블"
    user_msg = json.loads(captured["requests"][0].data.decode())["messages"][1]["content"]
    assert "dbo.HR_EMP" in user_msg and "EMP_NO" in user_msg and "dbo.HR_ORG" in user_msg


def test_explain_validation_forbids_invented_numbers_in_prompt(captured):
    captured["content"] = '{"text": "포함률 99.0%로 사실상 FK입니다"}'
    facts = ValidationFacts(src="dbo.A.X", tgt="dbo.B.X", containment=0.99,
                            cardinality="1:N", orphan_count=2,
                            observation_count=3, pattern="stable_with_orphans")
    text = _client().explain_validation(facts)
    assert "포함률" in text
    user_msg = json.loads(captured["requests"][0].data.decode())["messages"][1]["content"]
    assert "0.99" in user_msg and "stable_with_orphans" in user_msg
    assert "수치를 만들지" in user_msg  # 수치 창작 금지 지시 포함


def test_explain_view_returns_text(captured):
    captured["content"] = '{"text": "주문과 사원을 조인한 요약 뷰"}'
    facts = ViewFacts(qname="dbo.V_ORD", base_tables=["dbo.T_ORD", "dbo.HR_EMP"],
                      join_pairs=["T_ORD.EMP_NO = HR_EMP.EMP_NO"],
                      output_columns=["ORD_NO", "EMP_NM"],
                      definition_excerpt="SELECT ... GROUP BY ...")
    assert _client().explain_view(facts) == "주문과 사원을 조인한 요약 뷰"


def test_empty_text_raises(captured):
    captured["content"] = '{"text": "  "}'
    table = TableMeta("dbo.HR_EMP", [], row_count=None)
    with pytest.raises(AiUnavailableError):
        _client().summarize_table(table, base_tables=[])
