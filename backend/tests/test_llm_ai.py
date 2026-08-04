"""LLM adapter tests with mocked HTTP. / 사내 LLM 어댑터 테스트 (HTTP 목킹)."""

import io
import json
from urllib.error import URLError

import pytest

from app.adapters import llm_ai
from app.adapters.llm_ai import AiUnavailableError, _extract_json, _post_chat
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
