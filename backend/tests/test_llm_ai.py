"""LLM adapter tests with mocked HTTP. / 사내 LLM 어댑터 테스트 (HTTP 목킹)."""

import io
import json
from urllib.error import URLError

import pytest

from app.adapters import llm_ai
from app.adapters.ai import (
    CandidatePair,
    ChatContext,
    ChatTableContext,
    ColumnMeta,
    TableMeta,
    ValidationFacts,
    ViewFacts,
)
from app.adapters.llm_ai import (
    AiUnavailableError, CHAT_HISTORY_LIMIT, LlmAiClient, _extract_json, _post_chat,
    build_chat_prompt, filter_search_candidates, embed_texts, cosine_similarity,
)
from app.config import Settings
from app.services.ai_search import rank_by_cosine


def test_ai_settings_defaults():
    s = Settings(_env_file=None)  # 개발자 로컬 .env 간섭 차단
    assert s.ai_base_url == ""
    assert s.ai_model == ""
    assert s.ai_api_key == ""
    assert s.ai_timeout == 60
    assert s.ai_suggest_max_pairs == 40
    # Task 7: embedding settings — URL·모델·타임아웃은 사내 공통 변수명(BPM과 동일)
    assert s.embed_url == ""
    assert s.embed_model == ""
    assert s.embed_timeout_seconds == 30
    assert s.embed_batch == 32
    assert s.embed_job_cap == 1000
    assert s.embed_sleep_ms == 500


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
    verdicts = _client().judge_relations([_pair(0), _pair(1)])
    assert len(verdicts) == 2  # 판정 전체 반환 — 수용+기각
    by_object = {v.src_object: v for v in verdicts}
    assert by_object["dbo.SRC0"].accepted is True
    assert by_object["dbo.SRC0"].reason == "사번 참조"
    assert by_object["dbo.SRC1"].accepted is False
    assert by_object["dbo.SRC1"].reason == "무관"
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
        {"index": 1, "accept": False},
    ]})
    verdicts = _client().judge_relations([_pair(0), _pair(1)])
    by_object = {v.src_object: v for v in verdicts}
    assert by_object["dbo.SRC0"].reason == "LLM accepted"
    assert by_object["dbo.SRC1"].reason == "LLM rejected"


def test_judge_relations_rejects_non_list_judgements(captured):
    captured["content"] = '{"judgements": null}'
    with pytest.raises(AiUnavailableError):
        _client().judge_relations([_pair(0)])


def test_judge_relations_skips_duplicate_indices(captured):
    captured["content"] = json.dumps({"judgements": [
        {"index": 0, "accept": True, "reason": "첫 판정"},
        {"index": 0, "accept": True, "reason": "중복 판정"},
    ]}, ensure_ascii=False)
    accepted = _client().judge_relations([_pair(0)])
    assert len(accepted) == 1
    assert accepted[0].reason == "첫 판정"


def test_judge_relations_rejects_non_bool_accept(captured):
    captured["content"] = '{"judgements": [{"index": 0, "accept": "false", "reason": "x"}]}'
    assert _client().judge_relations([_pair(0)]) == []


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


def test_search_tables_rejects_non_list_items(captured):
    captured["content"] = '{"items": null}'
    tables = [TableMeta("dbo.T_ORD", [ColumnMeta("ORD_NO", "int")])]
    with pytest.raises(AiUnavailableError):
        _client().search_tables("ORD", tables)


def test_search_tables_dedupes_duplicate_qnames(captured):
    captured["content"] = json.dumps({"items": [
        {"qname": "dbo.T_ORD", "score": 0.9, "reason": "a"},
        {"qname": "dbo.T_ORD", "score": 0.5, "reason": "b"},
    ]}, ensure_ascii=False)
    tables = [TableMeta("dbo.T_ORD", [ColumnMeta("ORD_NO", "int")])]
    hits = _client().search_tables("ORD", tables)
    assert len(hits) == 1
    assert hits[0].score == 0.9


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


# Task 7: cosine_similarity and embed_texts


def test_cosine_similarity_identical_vectors():
    """벡터가 같으면 1.0 반환 / identical vectors return 1.0."""
    assert cosine_similarity([1.0, 0.0, 0.0], [1.0, 0.0, 0.0]) == 1.0


def test_cosine_similarity_orthogonal_vectors():
    """직교 벡터는 0.0 반환 / orthogonal vectors return 0.0."""
    assert cosine_similarity([1.0, 0.0], [0.0, 1.0]) == 0.0


def test_cosine_similarity_opposite_vectors():
    """반대 방향 벡터는 -1.0 반환 / opposite vectors return -1.0."""
    assert cosine_similarity([1.0, 0.0], [-1.0, 0.0]) == -1.0


def test_cosine_similarity_length_mismatch_returns_zero():
    """길이 불일치는 0.0 반환 / length mismatch returns 0.0."""
    assert cosine_similarity([1.0, 2.0], [3.0, 4.0, 5.0]) == 0.0


def test_cosine_similarity_zero_vector_returns_zero():
    """영벡터는 0.0 반환 / zero vector returns 0.0."""
    assert cosine_similarity([0.0, 0.0], [1.0, 2.0]) == 0.0


def test_cosine_similarity_empty_vectors_returns_zero():
    """빈 벡터는 0.0 반환 / empty vectors return 0.0."""
    assert cosine_similarity([], []) == 0.0


def _embed_response(embeddings: list[list[float]], indices: list[int] | None = None) -> bytes:
    """임베딩 응답 생성 — index 순 섞음 가능 / generate embeddings response, indices can be shuffled."""
    if indices is None:
        indices = list(range(len(embeddings)))
    data = [{"index": i, "embedding": emb} for i, emb in zip(indices, embeddings)]
    return json.dumps({"data": data}).encode()


@pytest.fixture()
def embed_captured(monkeypatch):
    """urlopen 가로채 임베딩 요청 기록 + 준비된 응답 반환 / capture embeddings request, return canned reply."""
    calls: dict = {"requests": [], "response": _embed_response([[0.1, 0.2]])}

    def fake_urlopen(request, timeout=None):
        calls["requests"].append(request)
        calls["timeout"] = timeout
        return _FakeResponse(calls["response"])

    monkeypatch.setattr(llm_ai.urllib.request, "urlopen", fake_urlopen)
    return calls


def test_embed_texts_success(embed_captured):
    """임베딩 요청 성공 시 벡터 리스트 반환 / successful embeddings request returns vector list."""
    embed_captured["response"] = _embed_response([
        [0.1, 0.2],
        [0.3, 0.4],
        [0.5, 0.6],
    ])
    result = embed_texts("http://llm:11434/v1", "embed-model", "sk-key", 30,
                         ["text1", "text2", "text3"])
    assert len(result) == 3
    assert result[0] == [0.1, 0.2]
    assert result[2] == [0.5, 0.6]
    # 요청 검증
    req = embed_captured["requests"][0]
    assert req.full_url == "http://llm:11434/v1/embeddings"
    assert req.get_header("Authorization") == "Bearer sk-key"
    body = json.loads(req.data.decode())
    assert body["model"] == "embed-model"
    assert body["input"] == ["text1", "text2", "text3"]


def test_embed_texts_reorders_by_index(monkeypatch):
    """서버가 역순 반환 시 index로 정렬 / reorder by index if server returns out-of-order."""
    from app.adapters.llm_ai import embed_texts
    calls: dict = {"requests": [], "response": _embed_response(
        [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]],
        indices=[2, 0, 1]  # 역순
    )}

    def fake_urlopen(request, timeout=None):
        calls["requests"].append(request)
        return _FakeResponse(calls["response"])

    monkeypatch.setattr(llm_ai.urllib.request, "urlopen", fake_urlopen)

    result = embed_texts("http://llm:11434/v1", "model", "key", 30, ["a", "b", "c"])
    # index 0, 1, 2 순으로 정렬되어야 함
    assert result[0] == [0.3, 0.4]  # index 0
    assert result[1] == [0.5, 0.6]  # index 1
    assert result[2] == [0.1, 0.2]  # index 2


def test_embed_texts_accepts_full_embeddings_path(embed_captured):
    """EMBED_URL이 /embeddings 전체 경로여도 그대로 사용 — 사내 타 서비스 .env 값 복사 호환.

    BPM `kb/embed_client._embeddings_url()`와 같은 규약 (변수명·값 통일).
    """
    embed_texts("http://embed:8000/v1/embeddings", "bge-m3", "", 30, ["text"])
    assert embed_captured["requests"][0].full_url == "http://embed:8000/v1/embeddings"


def test_embed_texts_mismatch_count_raises(embed_captured):
    """응답 개수 불일치 시 raise / raise on count mismatch."""
    embed_captured["response"] = _embed_response([[0.1, 0.2], [0.3, 0.4]])  # 2개만
    with pytest.raises(AiUnavailableError):
        embed_texts("http://llm:11434/v1", "model", "key", 30, ["a", "b", "c"])  # 3개 요청


def test_embed_texts_retries_on_timeout(monkeypatch):
    """타임아웃 시 재시도 후 raise / retry on timeout then raise."""
    attempts = []

    def failing_urlopen(request, timeout=None):
        attempts.append(1)
        raise TimeoutError("connection timeout")

    monkeypatch.setattr(llm_ai.urllib.request, "urlopen", failing_urlopen)
    with pytest.raises(AiUnavailableError):
        embed_texts("http://llm:11434/v1", "model", "key", 30, ["text"])
    assert len(attempts) == 2  # 1회 재시도 후 포기


def test_embed_texts_omits_auth_without_key(embed_captured):
    """API 키 없으면 Authorization 헤더 생략 / omit auth header without key."""
    embed_captured["response"] = _embed_response([[0.1, 0.2]])
    embed_texts("http://llm:11434/v1", "model", "", 30, ["text"])
    req = embed_captured["requests"][0]
    assert req.get_header("Authorization") is None


# Task 7: create_ai_client 스위치

def test_create_ai_client_switches_on_base_url(monkeypatch):
    """AI_BASE_URL 설정 시 실 LlmAiClient, 아니면 Fake — 연결 단계 결정 이행."""
    from app.adapters import ai as ai_module
    from app.adapters.llm_ai import LlmAiClient
    from app.config import get_settings

    monkeypatch.setenv("AI_BASE_URL", "http://llm:11434/v1")
    monkeypatch.setenv("AI_MODEL", "test-model")
    get_settings.cache_clear()
    try:
        assert isinstance(ai_module.create_ai_client(), LlmAiClient)
    finally:
        monkeypatch.delenv("AI_BASE_URL", raising=False)
        monkeypatch.delenv("AI_MODEL", raising=False)
        get_settings.cache_clear()


def test_create_ai_client_defaults_to_fake(monkeypatch):
    """AI_BASE_URL 미설정 시 FakeAiClient — 개발자 로컬 .env 간섭 차단."""
    from app.adapters import ai as ai_module
    from app.config import get_settings

    monkeypatch.setenv("AI_BASE_URL", "")  # 개발자 로컬 .env 간섭 차단
    get_settings.cache_clear()
    try:
        assert isinstance(ai_module.create_ai_client(), ai_module.FakeAiClient)
    finally:
        monkeypatch.delenv("AI_BASE_URL", raising=False)
        get_settings.cache_clear()


# Task 9: rank_by_cosine — pure ranking, DB/HTTP 없음


def test_rank_by_cosine_orders_by_similarity_descending():
    query_vec = [1.0, 0.0]
    rows = [
        ("dbo.T_ORTHO", [0.0, 1.0]),   # 직교 — 유사도 0.0
        ("dbo.T_EXACT", [1.0, 0.0]),   # 동일 — 유사도 1.0
        ("dbo.T_CLOSE", [0.9, 0.1]),   # 유사하지만 완전 일치는 아님
    ]
    assert rank_by_cosine(query_vec, rows, top_k=2) == ["dbo.T_EXACT", "dbo.T_CLOSE"]


def test_rank_by_cosine_breaks_ties_by_qname():
    """동점이면 qname 오름차순 — 결정론적 순서 보장 / deterministic tie-break."""
    query_vec = [1.0, 0.0]
    rows = [("dbo.T_Z", [1.0, 0.0]), ("dbo.T_A", [1.0, 0.0])]
    assert rank_by_cosine(query_vec, rows, top_k=2) == ["dbo.T_A", "dbo.T_Z"]


def test_rank_by_cosine_caps_at_top_k():
    query_vec = [1.0, 0.0]
    rows = [(f"dbo.T_{i:02d}", [1.0, 0.0]) for i in range(10)]
    assert len(rank_by_cosine(query_vec, rows, top_k=3)) == 3


# Task 10 (사이클2): build_chat_prompt, LlmAiClient.answer_question


def _chat_context() -> ChatContext:
    return ChatContext(tables=[ChatTableContext(
        qname="dbo.T_ORD", columns=[ColumnMeta("ORD_NO", "int", is_pk=True)],
        summary="주문 테이블", relations=["dbo.T_ORD.ORD_NO → dbo.T_SHP.ORD_NO (validated)"],
        base_tables=["dbo.V_ORD_BASE"],
    )])


def test_build_chat_prompt_includes_context_history_and_question():
    history = [("user", "이전 질문"), ("assistant", "이전 답변")]
    prompt = build_chat_prompt("새 질문", history, _chat_context())
    assert "dbo.T_ORD" in prompt and "ORD_NO" in prompt  # 컨텍스트 테이블·컬럼
    assert "주문 테이블" in prompt and "dbo.T_SHP.ORD_NO" in prompt and "dbo.V_ORD_BASE" in prompt
    assert "이전 질문" in prompt and "이전 답변" in prompt  # 이전 대화
    assert "새 질문" in prompt  # 질문


def test_build_chat_prompt_omits_history_block_when_empty():
    prompt = build_chat_prompt("질문", [], ChatContext(tables=[]))
    assert "이전 대화" not in prompt


def test_build_chat_prompt_keeps_only_last_history_limit_turns():
    history = [("user", f"q{i}") for i in range(8)]
    prompt = build_chat_prompt("질문", history, ChatContext(tables=[]))
    assert CHAT_HISTORY_LIMIT == 6
    assert "q0" not in prompt and "q1" not in prompt  # 상한 밖 — 잘림
    assert "q2" in prompt and "q7" in prompt  # 최근 6턴만 유지


def test_answer_question_maps_llm_text_response(captured):
    captured["content"] = '{"text": "답변입니다"}'
    assert _client().answer_question("질문", [], ChatContext(tables=[])) == "답변입니다"


def test_answer_question_sends_context_and_history_in_prompt(captured):
    captured["content"] = '{"text": "답변"}'
    _client().answer_question("두 번째 질문", [("user", "첫 질문")], _chat_context())
    user_msg = json.loads(captured["requests"][0].data.decode())["messages"][1]["content"]
    assert "dbo.T_ORD" in user_msg and "첫 질문" in user_msg and "두 번째 질문" in user_msg
