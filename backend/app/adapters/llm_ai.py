"""OpenAI-compatible self-hosted LLM adapter. / 사내 LLM 어댑터 (스펙 2026-08-04).

AiClient Protocol의 실 구현. 입력이 adapters/ai.py의 메타데이터 타입뿐이라
원본 데이터 값이 프롬프트로 샐 경로가 구조적으로 없다 (계획 §5.2 유지).
Empty AI_BASE_URL keeps the offline fake; failures raise, never fall back.
"""

import json
import logging
import urllib.request
from urllib.error import URLError

logger = logging.getLogger(__name__)

# 일시 오류 1회 재시도 — n8n_query.py와 동일 규약 / one retry with logging, then raise
RETRY_COUNT = 1
# 같은 입력이면 같은 출력 지향 / determinism-leaning decoding
TEMPERATURE = 0


class AiUnavailableError(RuntimeError):
    """LLM 호출·응답 파싱 실패 — 앱 핸들러가 502로 변환 / mapped to 502 by the app."""

    def __init__(self, message: str, context: dict):
        super().__init__(message)
        self.context = context


def _post_chat(base_url: str, model: str, api_key: str, timeout: int,
               system: str, user: str) -> str:
    """chat completions 1회 호출 → assistant 본문 텍스트 / returns message content."""
    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(
        url,
        data=json.dumps({
            "model": model,
            "temperature": TEMPERATURE,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user}],
        }, ensure_ascii=False).encode(),
        headers=headers,
        method="POST",
    )
    last_error: Exception | None = None
    for attempt in range(RETRY_COUNT + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode())
            return payload["choices"][0]["message"]["content"]
        except (URLError, TimeoutError, KeyError, IndexError, TypeError,
                json.JSONDecodeError) as e:
            last_error = e
            logger.warning("llm chat attempt failed",
                           extra={"url": url, "model": model, "attempt": attempt})
    raise AiUnavailableError(
        "llm request failed after retries",
        {"url": url, "model": model, "cause": str(last_error)},
    ) from last_error


def _extract_json(text: str) -> dict:
    """코드펜스·주변 텍스트를 관용 처리해 JSON 오브젝트만 파싱 / lenient JSON extraction."""
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise AiUnavailableError("llm returned no JSON object", {"text": text[:200]})
    try:
        parsed = json.loads(text[start:end + 1])
    except json.JSONDecodeError as e:
        raise AiUnavailableError("llm returned malformed JSON",
                                 {"text": text[:200]}) from e
    if not isinstance(parsed, dict):
        raise AiUnavailableError("llm returned non-object JSON", {"text": text[:200]})
    return parsed
