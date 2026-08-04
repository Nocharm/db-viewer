"""OpenAI-compatible self-hosted LLM adapter. / 사내 LLM 어댑터 (스펙 2026-08-04).

AiClient Protocol의 실 구현. 입력이 adapters/ai.py의 메타데이터 타입뿐이라
원본 데이터 값이 프롬프트로 샐 경로가 구조적으로 없다 (계획 §5.2 유지).
Empty AI_BASE_URL keeps the offline fake; failures raise, never fall back.
"""

import json
import logging
import urllib.request
from urllib.error import URLError

from app.adapters.ai import AiRelationSuggestion, CandidatePair

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


# 모든 기능 공통 시스템 프롬프트 — JSON-only·한국어 고정 / shared system prompt
_SYSTEM_PROMPT = (
    "너는 MSSQL 스키마 분석 도우미다. 답변은 반드시 한국어로 하고, "
    "요청된 JSON 오브젝트 하나만 출력한다. 설명·마크다운·코드펜스를 덧붙이지 않는다."
)


def build_judge_prompt(candidates: list[CandidatePair]) -> str:
    """후보 페어 → 판정 프롬프트 (순수 함수) / candidates to a judging prompt."""
    payload = [{
        "index": i,
        "src": {"object": c.src_object, "column": c.src_column, "type": c.src_type,
                "is_pk": c.src_is_pk, "row_count": c.src_row_count},
        "tgt": {"object": c.tgt_object, "column": c.tgt_column, "type": c.tgt_type,
                "is_pk": c.tgt_is_pk, "row_count": c.tgt_row_count},
        "score": c.score, "signals": c.signals,
    } for i, c in enumerate(candidates)]
    return (
        "다음은 스키마 메타데이터로 스코어링된 FK 후보 페어 목록이다.\n"
        "각 페어가 실제 조인 관계(src 값이 tgt 값에 포함)일 가능성을 판정하라.\n"
        '출력 스키마: {"judgements": [{"index": <int>, "accept": <bool>, '
        '"reason": "<한국어 한 줄>"}]}\n'
        "모든 index에 대해 판정을 반환하라.\n\n"
        f"{json.dumps(payload, ensure_ascii=False)}"
    )


class LlmAiClient:
    """OpenAI 호환 서버 위 AiClient 구현 — 프롬프트는 순수 빌더로 분리."""

    def __init__(self, base_url: str, model: str, api_key: str, timeout: int):
        self._base_url = base_url
        self._model = model
        self._api_key = api_key
        self._timeout = timeout

    def _chat(self, user_prompt: str) -> dict:
        content = _post_chat(self._base_url, self._model, self._api_key,
                             self._timeout, _SYSTEM_PROMPT, user_prompt)
        return _extract_json(content)

    def judge_relations(self, candidates: list[CandidatePair]) -> list[AiRelationSuggestion]:
        if not candidates:
            return []
        data = self._chat(build_judge_prompt(candidates))
        accepted = []
        for j in data.get("judgements", []):
            if not isinstance(j, dict):
                continue
            idx = j.get("index")
            # 모델이 지어낸 인덱스·타입은 버린다 / drop hallucinated or mistyped indices
            if not isinstance(idx, int) or isinstance(idx, bool) or not 0 <= idx < len(candidates):
                continue
            if not j.get("accept"):
                continue
            c = candidates[idx]
            accepted.append(AiRelationSuggestion(
                src_object=c.src_object, src_column=c.src_column,
                tgt_object=c.tgt_object, tgt_column=c.tgt_column,
                reason=str(j.get("reason") or "LLM accepted"),
            ))
        return accepted
