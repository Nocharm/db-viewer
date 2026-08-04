"""LLM adapter tests with mocked HTTP. / 사내 LLM 어댑터 테스트 (HTTP 목킹)."""

import io
import json
from urllib.error import URLError

import pytest

from app.adapters import llm_ai
from app.adapters.ai import CandidatePair
from app.adapters.llm_ai import AiUnavailableError, LlmAiClient, _extract_json, _post_chat
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
