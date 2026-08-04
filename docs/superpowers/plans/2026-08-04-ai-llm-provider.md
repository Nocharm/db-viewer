# AI 실 LLM 프로바이더 전환 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 AI 5기능(관계 제안·자연어 탐색·요약·검증 해석·뷰 해석)을 `FakeAiClient`에서 사내 셀프호스트 LLM(OpenAI 호환)으로 전환한다.

**Architecture:** `adapters/llm_ai.py`에 stdlib `urllib` 기반 `LlmAiClient`를 신설하고 `create_ai_client()` 한 곳에서 `AI_BASE_URL` 유무로 Fake/LLM을 스위치한다. 관계 제안은 스코어러 상위 후보만 LLM이 재판정하도록 Protocol을 `judge_relations`로 교체한다(2,342 테이블 전량 프롬프트 불가). 엔드포인트 5종의 요청·응답 계약은 불변 — 프론트엔드 무변경.

**Tech Stack:** Python 3.12 / FastAPI / pydantic-settings / stdlib urllib (신규 의존성 없음) / pytest

**Spec:** `docs/superpowers/specs/2026-08-04-ai-llm-provider-design.md`

## Global Constraints

- 신규 의존성 금지 — HTTP는 stdlib `urllib`만 (`rules/common/dependencies.md`).
- 프롬프트 입력은 `adapters/ai.py`의 메타데이터 타입만 — 원본 데이터 값 금지 (계획 §5.2).
- AI 출력은 `status="candidate", origin="ai"`로만 적재 — confirmed 금지 가드 유지.
- LLM 장애 시 조용한 Fake 폴백 금지 — `AiUnavailableError` → 502 `{"error": {code, message, context}}` 규약.
- `temperature=0`, LLM 응답은 한국어.
- 타입 힌트 전체 시그니처 필수, `X | None`·`list[str]` 스타일 (`rules/languages/python.md`).
- 주석은 기존 파일 스타일(한/영 병기, WHY 위주) 유지.
- 커밋: `type(scope): English summary — 한국어 요약`, 커밋 직전 PROGRESS.md의 "AI 실 LLM 프로바이더 전환" 항목 끝 진행 표기를 갱신(예: "(구현 중 — Task N/8)")해 함께 스테이징.
- 테스트: `cd backend && .venv/bin/python -m pytest tests -q` 전체 그린 + `.venv/bin/ruff check app alembic tests` 클린 상태로만 커밋.
- 저장소 관행대로 main에 순차 커밋 (단일 개발자 저장소 — 브랜치 불필요).

---

### Task 1: Settings + env 배관

**Files:**
- Modify: `backend/app/config.py` (n8n_query_timeout 필드 아래)
- Modify: `.env.example` (N8N_QUERY_TIMEOUT=120 라인 아래)
- Modify: `docker-compose.yml` (backend environment 블록)
- Test: `backend/tests/test_llm_ai.py` (신규 파일 시작)

**Interfaces:**
- Produces: `Settings.ai_base_url: str`, `Settings.ai_model: str`, `Settings.ai_api_key: str`, `Settings.ai_timeout: int`, `Settings.ai_suggest_max_pairs: int` — Task 7의 `create_ai_client()`와 Task 3의 엔드포인트가 사용.

- [ ] **Step 1: 실패하는 테스트 작성** — `backend/tests/test_llm_ai.py` 신규 생성:

```python
"""LLM adapter tests with mocked HTTP. / 사내 LLM 어댑터 테스트 (HTTP 목킹)."""

from app.config import Settings


def test_ai_settings_defaults():
    s = Settings(_env_file=None)  # 개발자 로컬 .env 간섭 차단
    assert s.ai_base_url == ""
    assert s.ai_model == ""
    assert s.ai_api_key == ""
    assert s.ai_timeout == 60
    assert s.ai_suggest_max_pairs == 40
```

- [ ] **Step 2: 실패 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_llm_ai.py -q`
Expected: FAIL — `AttributeError: 'Settings' object has no attribute 'ai_base_url'`

- [ ] **Step 3: Settings 필드 추가** — `backend/app/config.py`의 `n8n_query_timeout: int = 120` 라인 바로 아래에:

```python
    # Environment: 사내 LLM OpenAI 호환 베이스 URL (예: http://<llm-host>:11434/v1).
    # 비우면 FakeAiClient — 로컬·CI는 오프라인 유지 / empty keeps the offline fake
    ai_base_url: str = ""
    # Environment: LLM 서버에 로드된 모델명 그대로 / model name as loaded on the server
    ai_model: str = ""
    # Environment: LLM API 키 — 비우면 Authorization 헤더 생략 (사내 무인증 서버 대응)
    ai_api_key: str = ""
    # Tuning: LLM 응답 대기 상한(초) — CPU 추론 대비 여유 / LLM response wait cap
    ai_timeout: int = 60
    # Tuning: LLM 재판정에 넘길 후보 페어 상한 — 프롬프트 크기·응답 시간 제어
    ai_suggest_max_pairs: int = 40
```

- [ ] **Step 4: .env.example 갱신** — `N8N_QUERY_TIMEOUT=120` 라인 아래에 추가:

```
# ── AI (사내 LLM — OpenAI 호환 /v1/chat/completions) ── 비우면 결정론적 목업 동작
# 베이스 URL (예: http://<llm-host>:11434/v1)
AI_BASE_URL=
# 모델명 — LLM 서버에 로드된 이름 그대로
AI_MODEL=
# API 키 — 무인증 서버면 비워둔다
AI_API_KEY=
# LLM 응답 대기 상한(초)
AI_TIMEOUT=60
# LLM 재판정 후보 페어 상한
AI_SUGGEST_MAX_PAIRS=40
```

- [ ] **Step 5: docker-compose.yml 갱신** — backend `environment:`의 `N8N_QUERY_TIMEOUT: ${N8N_QUERY_TIMEOUT}` 라인이 없으면 `INGEST_API_KEY: ${INGEST_API_KEY}` 아래에, 있으면 그 아래에 추가 (기존 키들과 같은 형식):

```yaml
      AI_BASE_URL: ${AI_BASE_URL}
      AI_MODEL: ${AI_MODEL}
      AI_API_KEY: ${AI_API_KEY}
      AI_TIMEOUT: ${AI_TIMEOUT}
      AI_SUGGEST_MAX_PAIRS: ${AI_SUGGEST_MAX_PAIRS}
```

주의: `N8N_WEBHOOK_BASE`가 compose에 없다면 이 프로젝트는 `.env` → compose 주입을 쓰는 변수만 등재한다 — 그 경우에도 위 5종은 추가한다(서버 배포에서 필요). Dockerfile ENV는 `SOURCE_MODE`만 폴백으로 두는 기존 관행 유지 — 추가하지 않는다.

- [ ] **Step 6: 통과 확인 + compose 검증**

Run: `cd backend && .venv/bin/python -m pytest tests/test_llm_ai.py -q && cd .. && docker compose config -q`
Expected: PASS, compose 에러 없음 (`.env` 없는 환경이면 `AI_BASE_URL` 빈 값 경고는 무해)

- [ ] **Step 7: 커밋**

```bash
git add backend/app/config.py .env.example docker-compose.yml backend/tests/test_llm_ai.py PROGRESS.md
git commit -m "feat(ai): add self-hosted LLM settings — 사내 LLM 설정 5종 추가"
```

---

### Task 2: llm_ai.py 코어 — AiUnavailableError · _post_chat · _extract_json

**Files:**
- Create: `backend/app/adapters/llm_ai.py`
- Test: `backend/tests/test_llm_ai.py` (추가)

**Interfaces:**
- Produces:
  - `AiUnavailableError(RuntimeError)` — `.context: dict` 보유. Task 7의 502 핸들러가 사용.
  - `_post_chat(base_url: str, model: str, api_key: str, timeout: int, system: str, user: str) -> str` — assistant 본문 텍스트 반환.
  - `_extract_json(text: str) -> dict` — 코드펜스 관용 JSON 파싱.

- [ ] **Step 1: 실패하는 테스트 작성** — `backend/tests/test_llm_ai.py`에 추가 (`test_n8n_query.py`의 목킹 패턴 준용). 이후 태스크 포함 모든 테스트 추가 시 import는 파일 상단에 합쳐 배치한다 (ruff import 규칙):

```python
import io
import json
from urllib.error import URLError

import pytest

from app.adapters import llm_ai
from app.adapters.llm_ai import AiUnavailableError, _extract_json, _post_chat


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
```

- [ ] **Step 2: 실패 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_llm_ai.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.adapters.llm_ai'`

- [ ] **Step 3: 구현** — `backend/app/adapters/llm_ai.py` 신규 생성:

```python
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
```

- [ ] **Step 4: 통과 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_llm_ai.py -q`
Expected: PASS (전건)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/adapters/llm_ai.py backend/tests/test_llm_ai.py PROGRESS.md
git commit -m "feat(ai): LLM HTTP core with retry and lenient JSON parsing — LLM 호출 코어"
```

---

### Task 3: judge 인터페이스 전환 — CandidatePair · Fake · 스코어러 후보 · 엔드포인트

가장 큰 태스크. Protocol 변경과 엔드포인트 개편은 함께 커밋해야 스위트가 중간에 깨지지 않는다.

**Files:**
- Modify: `backend/app/domain/scoring.py` (`_normalize` → `normalize_name` 공개화)
- Modify: `backend/app/adapters/ai.py` (CandidatePair 추가, Protocol·Fake의 suggest_relations → judge_relations)
- Modify: `backend/app/api/ai.py` (select_ai_candidates 신설, suggest_relations 엔드포인트 개편)
- Test: `backend/tests/test_ai.py` (Fake 단위 테스트 교체 + select_ai_candidates 단위 테스트 추가)

**Interfaces:**
- Consumes: `scoring.ScoringColumn(column_id, object_qname, object_type, name, data_type, max_length, is_pk, is_computed, distinct_count)`, `scoring.Candidate(target, score, signals)`, `scoring.score_candidates(src, targets, view_join_pairs, existing_fk_pairs, min_distinct, blacklist)`, `load_scoring_columns(db, snapshot_id)`, `load_pair_sets(db, snapshot_id) -> (view_pairs, fk_pairs)`, Task 1의 Settings.
- Produces:
  - `scoring.normalize_name(name: str) -> str` (기존 `_normalize` 공개화)
  - `adapters/ai.py`의 `CandidatePair` dataclass (아래 정의 그대로 — Task 4가 사용)
  - `AiClient.judge_relations(self, candidates: list[CandidatePair]) -> list[AiRelationSuggestion]` (수용된 페어만 반환, reason = 판정 근거)
  - `api/ai.py`의 `select_ai_candidates(columns, view_pairs, fk_pairs, min_distinct, blacklist, max_pairs) -> list[tuple[scoring.ScoringColumn, scoring.Candidate]]`
  - 엔드포인트 응답 계약 불변: `{"snapshot_id", "suggested", "created", "items"}` (suggested = 판정에 넘긴 페어 수)

- [ ] **Step 1: scoring 정규화 함수 공개화** — `backend/app/domain/scoring.py`에서 `def _normalize(name: str) -> str:` 를 `def normalize_name(name: str) -> str:` 로 리네임하고, 같은 파일 안의 호출 2곳(`_normalize(src.name) == _normalize(tgt.name)`)을 갱신. 다른 참조 확인:

Run: `grep -rn "scoring._normalize\|from app.domain.scoring import" backend/app backend/tests`
Expected: scoring.py 밖 참조 없음 (있으면 함께 갱신)

- [ ] **Step 2: Fake judge 실패 테스트 작성** — `backend/tests/test_ai.py`에서 `test_fake_client_suggests_naming_variants`를 삭제하고 그 자리에:

```python
from app.adapters.ai import CandidatePair


def _pair(src_object, src_column, tgt_object, tgt_column, signals):
    return CandidatePair(
        src_object=src_object, src_column=src_column, src_type="int",
        src_is_pk=False, src_row_count=100,
        tgt_object=tgt_object, tgt_column=tgt_column, tgt_type="int",
        tgt_is_pk=True, tgt_row_count=50,
        score=52, signals=signals,
    )


def test_fake_client_judges_by_name_affinity_and_view_join():
    pairs = [
        _pair("dbo.T_ORD", "EMPNO", "dbo.T_EMP", "EMP_NO", ["key", "naming"]),
        _pair("dbo.T_A", "X_ID", "dbo.T_B", "Y_ID", ["view_join"]),
        _pair("dbo.T_C", "AAA", "dbo.T_D", "BBB", ["key"]),
    ]
    accepted = FakeAiClient().judge_relations(pairs)
    keys = [(s.src_object, s.src_column, s.tgt_object, s.tgt_column) for s in accepted]
    assert ("dbo.T_ORD", "EMPNO", "dbo.T_EMP", "EMP_NO") in keys
    assert ("dbo.T_A", "X_ID", "dbo.T_B", "Y_ID") in keys
    assert ("dbo.T_C", "AAA", "dbo.T_D", "BBB") not in keys  # 신호 없는 페어는 기각
```

- [ ] **Step 3: select_ai_candidates 실패 테스트 작성** — `backend/tests/test_ai.py`에 추가:

```python
from app.api.ai import select_ai_candidates
from app.domain import scoring


def _col(cid, qname, name, is_pk=False):
    return scoring.ScoringColumn(
        column_id=cid, object_qname=qname, object_type="table", name=name,
        data_type="int", max_length=4, is_pk=is_pk, is_computed=False,
        distinct_count=100,
    )


def test_select_ai_candidates_prefers_pk_direction_and_caps():
    cols = {
        1: _col(1, "dbo.T_EMP", "EMP_NO", is_pk=True),
        2: _col(2, "dbo.T_ORD", "EMPNO"),
        3: _col(3, "dbo.T_ORD", "ORD_NO", is_pk=True),
        4: _col(4, "dbo.T_SHP", "ORD_NO"),
    }
    ranked = select_ai_candidates(cols, view_pairs=set(), fk_pairs=set(),
                                  min_distinct=50, blacklist=set(), max_pairs=1)
    assert len(ranked) == 1  # 상한 적용
    src, cand = ranked[0]
    # 정확 동명(40+key20=60) > 정규화 변형(32+20=52) — 방향은 PK 쪽이 타깃
    assert (src.object_qname, src.name) == ("dbo.T_SHP", "ORD_NO")
    assert (cand.target.object_qname, cand.target.name) == ("dbo.T_ORD", "ORD_NO")


def test_select_ai_candidates_includes_view_join_pairs():
    cols = {
        1: _col(1, "dbo.T_A", "HDR_KEY"),
        2: _col(2, "dbo.T_B", "REF_CODE"),
    }
    ranked = select_ai_candidates(cols, view_pairs={frozenset((1, 2))},
                                  fk_pairs=set(), min_distinct=50,
                                  blacklist=set(), max_pairs=10)
    # 이름이 달라도 뷰 JOIN 증거만으로 후보가 된다
    assert len(ranked) == 1
    assert ranked[0][1].signals.get("view_join") == scoring.WEIGHT_VIEW_JOIN
```

- [ ] **Step 4: 실패 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_ai.py -q`
Expected: FAIL — `ImportError: cannot import name 'CandidatePair'`

- [ ] **Step 5: adapters/ai.py 전환** — `AiTableHit` 정의 아래에 CandidatePair 추가:

```python
@dataclass(frozen=True)
class CandidatePair:
    """스코어러가 뽑은 후보 페어 + 판정용 메타 / scored pair with judging metadata."""

    src_object: str
    src_column: str
    src_type: str
    src_is_pk: bool
    src_row_count: int | None
    tgt_object: str
    tgt_column: str
    tgt_type: str
    tgt_is_pk: bool
    tgt_row_count: int | None
    score: int
    signals: list[str]
```

`AiClient` Protocol의 `def suggest_relations(self, tables: list[TableMeta]) -> list[AiRelationSuggestion]: ...` 를 다음으로 교체:

```python
    def judge_relations(self, candidates: list[CandidatePair]) -> list[AiRelationSuggestion]: ...
```

`FakeAiClient.suggest_relations` 메서드(내부 pk_index 휴리스틱 포함)를 통째로 다음으로 교체:

```python
    def judge_relations(self, candidates: list[CandidatePair]) -> list[AiRelationSuggestion]:
        # 뷰 JOIN 증거 또는 명명 유사면 수용 — 실 LLM의 판정을 결정론으로 흉내
        accepted = []
        for c in candidates:
            if "view_join" in c.signals or _normalize(c.src_column) == _normalize(c.tgt_column):
                accepted.append(AiRelationSuggestion(
                    src_object=c.src_object, src_column=c.src_column,
                    tgt_object=c.tgt_object, tgt_column=c.tgt_column,
                    reason=f"signals: {', '.join(c.signals)}",
                ))
        return accepted
```

- [ ] **Step 6: api/ai.py 개편** — import에 `from app.config import get_settings`, `from app.domain import scoring`, adapters import에 `CandidatePair` 추가. `suggest_relations` 엔드포인트 위(모듈 레벨)에 후보 선별 함수 추가:

```python
def select_ai_candidates(
    columns: dict[int, scoring.ScoringColumn],
    view_pairs: set[frozenset],
    fk_pairs: set[frozenset],
    min_distinct: int,
    blacklist: set[str],
    max_pairs: int,
) -> list[tuple[scoring.ScoringColumn, scoring.Candidate]]:
    """스냅샷 전체 상위 후보 — 무순서 페어당 고점 방향 1건.

    후보 우주는 뷰 JOIN 페어 + 정규화 동명 컬럼↔PK 페어로 한정한다.
    전 컬럼 O(N²) 스코어링은 실 규모(2,342 테이블)에서 불가능하고,
    스코어러 신호 자체가 이 두 우주 밖에서는 0점이라 손실도 없다
    (비PK↔비PK 동명 페어만 제외되는데, 그쪽은 컬럼 단위 후보 API가 커버).
    """
    all_columns = list(columns.values())
    pairs: set[frozenset] = {p for p in view_pairs if len(p) == 2}
    pk_index: dict[str, list[scoring.ScoringColumn]] = {}
    for col in all_columns:
        if col.is_pk:
            pk_index.setdefault(scoring.normalize_name(col.name), []).append(col)
    for col in all_columns:
        for pk in pk_index.get(scoring.normalize_name(col.name), []):
            if pk.object_qname != col.object_qname:
                pairs.add(frozenset((col.column_id, pk.column_id)))

    best: dict[frozenset, tuple[scoring.ScoringColumn, scoring.Candidate]] = {}
    for pair in pairs:
        ids = tuple(pair)
        for src_id, tgt_id in (ids, ids[::-1]):
            src, tgt = columns.get(src_id), columns.get(tgt_id)
            if src is None or tgt is None:
                continue
            if scoring.check_exclusion(src, min_distinct, blacklist) is not None:
                continue
            for cand in scoring.score_candidates(
                src, [tgt], view_pairs, fk_pairs, min_distinct, blacklist
            ):
                if pair not in best or cand.score > best[pair][1].score:
                    best[pair] = (src, cand)
    ranked = sorted(best.values(), key=lambda p: (-p[1].score, p[0].object_qname, p[0].name))
    return ranked[:max_pairs]
```

`suggest_relations` 엔드포인트 본문을 다음으로 교체 (데코레이터·시그니처·docstring 유지):

```python
    snapshot = resolve_snapshot(db, snapshot_id)
    settings = get_settings()
    columns = load_scoring_columns(db, snapshot.id)
    view_pairs, fk_pairs = load_pair_sets(db, snapshot.id)
    ranked = select_ai_candidates(
        columns, view_pairs, fk_pairs,
        settings.low_cardinality_min_distinct,
        {b.upper() for b in settings.low_cardinality_blacklist},
        settings.ai_suggest_max_pairs,
    )

    # 기존 관계와 중복 제거(양방향) — LLM 호출 전에 걸러 토큰 낭비·재실행 중복을 막는다
    existing: set[tuple] = set()
    for r in db.execute(select(Relation)).scalars():
        existing.add((r.src_object, r.src_column, r.tgt_object, r.tgt_column))
        existing.add((r.tgt_object, r.tgt_column, r.src_object, r.src_column))

    row_counts = {
        f"{o.schema}.{o.name}": o.row_count
        for o in db.execute(
            select(CatalogObject).where(CatalogObject.snapshot_id == snapshot.id)
        ).scalars()
    }
    pairs_meta = []
    for src, cand in ranked:
        tgt = cand.target
        if (src.object_qname, src.name, tgt.object_qname, tgt.name) in existing:
            continue
        pairs_meta.append(CandidatePair(
            src_object=src.object_qname, src_column=src.name,
            src_type=src.data_type, src_is_pk=src.is_pk,
            src_row_count=row_counts.get(src.object_qname),
            tgt_object=tgt.object_qname, tgt_column=tgt.name,
            tgt_type=tgt.data_type, tgt_is_pk=tgt.is_pk,
            tgt_row_count=row_counts.get(tgt.object_qname),
            score=cand.score, signals=sorted(cand.signals),
        ))

    suggestions = ai.judge_relations(pairs_meta)

    now = datetime.now(UTC)
    created = []
    for s in suggestions:
        key = (s.src_object, s.src_column, s.tgt_object, s.tgt_column)
        db.add(Relation(
            src_object=s.src_object, src_column=s.src_column,
            tgt_object=s.tgt_object, tgt_column=s.tgt_column,
            status="candidate", origin="ai", created_at=now,
        ))
        created.append({**key_as_dict(key), "reason": s.reason})
    return {"snapshot_id": snapshot.id, "suggested": len(pairs_meta),
            "created": len(created), "items": created[:100]}
```

이 개편으로 endpoint 안의 옛 dedupe 블록(`by_identity`, `fk_pairs` 재검사, `_load_table_meta` 호출)은 사라진다. `_load_table_meta`는 search·summarize가 계속 쓰므로 유지. 사라진 지역 참조(예: `tables` 변수)만 정리 — 파일의 다른 부분은 건드리지 않는다.

- [ ] **Step 7: 전체 테스트 + 린트**

Run: `cd backend && .venv/bin/python -m pytest tests -q && .venv/bin/ruff check app alembic tests`
Expected: 전체 PASS (기존 엔드포인트 테스트 4종 — creates_ai_candidates_only·idempotent·cannot_be_confirmed·render_as_edges — 는 계약 유지로 그대로 통과해야 한다). 실패 시 원인 파악 먼저 — 계약이 깨진 것이지 테스트를 고칠 일이 아니다.

- [ ] **Step 8: 커밋**

```bash
git add backend/app/domain/scoring.py backend/app/adapters/ai.py backend/app/api/ai.py backend/tests/test_ai.py PROGRESS.md
git commit -m "feat(ai): scorer candidates judged by AiClient — 스코어러 후보 LLM 재판정 구조 전환"
```

---

### Task 4: LlmAiClient.judge_relations

**Files:**
- Modify: `backend/app/adapters/llm_ai.py`
- Test: `backend/tests/test_llm_ai.py`

**Interfaces:**
- Consumes: Task 2의 `_post_chat`·`_extract_json`, Task 3의 `CandidatePair`·`AiRelationSuggestion`.
- Produces: `LlmAiClient(base_url: str, model: str, api_key: str, timeout: int)` 클래스 + `.judge_relations(candidates) -> list[AiRelationSuggestion]`, `build_judge_prompt(candidates) -> str`. Task 5~7이 같은 클래스에 메서드를 추가한다.

- [ ] **Step 1: 실패하는 테스트 작성** — `backend/tests/test_llm_ai.py`에 추가:

```python
from app.adapters.ai import CandidatePair
from app.adapters.llm_ai import LlmAiClient


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
```

- [ ] **Step 2: 실패 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_llm_ai.py -q`
Expected: FAIL — `ImportError: cannot import name 'LlmAiClient'`

- [ ] **Step 3: 구현** — `backend/app/adapters/llm_ai.py`에 추가. import에 `from app.adapters.ai import AiRelationSuggestion, CandidatePair` 추가:

```python
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
```

- [ ] **Step 4: 통과 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_llm_ai.py -q`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add backend/app/adapters/llm_ai.py backend/tests/test_llm_ai.py PROGRESS.md
git commit -m "feat(ai): LLM candidate judging with hallucination guards — LLM 후보 재판정"
```

---

### Task 5: LlmAiClient.search_tables — 프리필터 + 재랭크

**Files:**
- Modify: `backend/app/adapters/llm_ai.py`
- Test: `backend/tests/test_llm_ai.py`

**Interfaces:**
- Consumes: `TableMeta(qname, columns, row_count)`, `AiTableHit(qname, score, reason)`, `ColumnMeta(name, data_type, is_pk)` — `app.adapters.ai`에서 import. 테스트는 Task 4에서 정의한 `_client()`·`captured` 헬퍼 재사용.
- Produces: `filter_search_candidates(query: str, tables: list[TableMeta], limit: int = SEARCH_PREFILTER_LIMIT) -> list[TableMeta]`, `build_search_prompt(query: str, tables: list[TableMeta]) -> str`, `LlmAiClient.search_tables(query, tables) -> list[AiTableHit]`.

- [ ] **Step 1: 실패하는 테스트 작성** — `backend/tests/test_llm_ai.py`에 추가:

```python
from app.adapters.ai import ColumnMeta, TableMeta
from app.adapters.llm_ai import filter_search_candidates


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
```

- [ ] **Step 2: 실패 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_llm_ai.py -q`
Expected: FAIL — `ImportError: cannot import name 'filter_search_candidates'`

- [ ] **Step 3: 구현** — `backend/app/adapters/llm_ai.py`에 추가. import에 `AiTableHit`, `TableMeta` 추가:

```python
# 프리필터 상한 — 프롬프트 크기 제어 (비즈니스 상수, 스펙 §기능 2) / prompt-size cap
SEARCH_PREFILTER_LIMIT = 50
# 결과 상한 — Fake와 동일 / same cap as the fake client
SEARCH_RESULT_LIMIT = 20
# 프롬프트에 싣는 테이블당 컬럼 수 — 대형 테이블 토큰 폭주 방지
SEARCH_COLUMNS_PER_TABLE = 12


def _normalize(name: str) -> str:
    return name.replace("_", "").upper()


def filter_search_candidates(query: str, tables: list[TableMeta],
                             limit: int = SEARCH_PREFILTER_LIMIT) -> list[TableMeta]:
    """이름·컬럼 정규화 매칭 프리필터 — LLM 재랭크 입력을 상한 내로 줄인다.

    이름·컬럼에 흔적 없는 순수 의미 질의는 여기서 리콜되지 않는다(스펙 명시 한계).
    """
    terms = [t for t in _normalize(query).split() if t] or [_normalize(query)]
    scored: list[tuple[int, TableMeta]] = []
    for table in tables:
        haystack = _normalize(" ".join([table.qname, *(c.name for c in table.columns)]))
        matched = sum(1 for term in terms if term in haystack)
        if matched:
            scored.append((matched, table))
    scored.sort(key=lambda pair: (-pair[0], pair[1].qname))
    return [table for _, table in scored[:limit]]


def build_search_prompt(query: str, tables: list[TableMeta]) -> str:
    payload = [{"qname": t.qname, "row_count": t.row_count,
                "columns": [c.name for c in t.columns[:SEARCH_COLUMNS_PER_TABLE]]}
               for t in tables]
    return (
        f'사용자 질의: "{query}"\n'
        "다음 테이블 목록에서 질의와 관련 있는 것만 관련도 순으로 골라라.\n"
        '출력 스키마: {"items": [{"qname": "<입력 목록의 qname 그대로>", '
        '"score": <0~1 실수>, "reason": "<한국어 한 줄>"}]}\n\n'
        f"{json.dumps(payload, ensure_ascii=False)}"
    )
```

`LlmAiClient`에 메서드 추가:

```python
    def search_tables(self, query: str, tables: list[TableMeta]) -> list[AiTableHit]:
        candidates = filter_search_candidates(query, tables)
        if not candidates:
            return []
        data = self._chat(build_search_prompt(query, candidates))
        known = {t.qname for t in candidates}
        hits = []
        for item in data.get("items", []):
            if not isinstance(item, dict) or item.get("qname") not in known:
                continue  # 입력에 없는 테이블명은 환각 — 버린다
            try:
                score = min(max(float(item.get("score", 0)), 0.0), 1.0)
            except (TypeError, ValueError):
                score = 0.0
            hits.append(AiTableHit(qname=item["qname"], score=round(score, 2),
                                   reason=str(item.get("reason") or "")))
        hits.sort(key=lambda h: (-h.score, h.qname))
        return hits[:SEARCH_RESULT_LIMIT]
```

- [ ] **Step 4: 통과 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_llm_ai.py -q`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add backend/app/adapters/llm_ai.py backend/tests/test_llm_ai.py PROGRESS.md
git commit -m "feat(ai): two-stage LLM table search (prefilter + rerank) — 프리필터·재랭크 탐색"
```

---

### Task 6: LlmAiClient — 요약·검증 해석·뷰 해석

**Files:**
- Modify: `backend/app/adapters/llm_ai.py`
- Test: `backend/tests/test_llm_ai.py`

**Interfaces:**
- Consumes: `ValidationFacts(src, tgt, containment, cardinality, orphan_count, observation_count, pattern)`, `ViewFacts(qname, base_tables, join_pairs, output_columns, definition_excerpt)` — `app.adapters.ai`에서 import.
- Produces: `LlmAiClient.summarize_table(table, base_tables) -> str`, `.explain_validation(facts) -> str`, `.explain_view(facts) -> str`, `_require_text(data: dict) -> str`.

- [ ] **Step 1: 실패하는 테스트 작성** — `backend/tests/test_llm_ai.py`에 추가:

```python
from app.adapters.ai import ValidationFacts, ViewFacts
from app.adapters.llm_ai import AiUnavailableError as _AiErr


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
    with pytest.raises(_AiErr):
        _client().summarize_table(table, base_tables=[])
```

- [ ] **Step 2: 실패 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_llm_ai.py -q`
Expected: FAIL — `AttributeError: 'LlmAiClient' object has no attribute 'summarize_table'`

- [ ] **Step 3: 구현** — `backend/app/adapters/llm_ai.py`에 추가. import에 `ValidationFacts`, `ViewFacts` 추가:

```python
def _require_text(data: dict) -> str:
    """{"text": ...} 응답 검증 — 빈 응답은 실패로 취급 / empty narration is a failure."""
    text = data.get("text")
    if not isinstance(text, str) or not text.strip():
        raise AiUnavailableError("llm returned empty text", {"data": str(data)[:200]})
    return text.strip()


def build_summary_prompt(table: TableMeta, base_tables: list[str]) -> str:
    payload = {
        "qname": table.qname, "row_count": table.row_count,
        "columns": [{"name": c.name, "type": c.data_type, "pk": c.is_pk}
                    for c in table.columns],
        "base_tables": base_tables,
    }
    return (
        "다음 테이블(또는 뷰)의 업무 도메인을 추정해 한 문장으로 요약하라.\n"
        '출력 스키마: {"text": "<한국어 한 문장>"}\n\n'
        f"{json.dumps(payload, ensure_ascii=False)}"
    )


def build_validation_prompt(facts: ValidationFacts) -> str:
    payload = {
        "src": facts.src, "tgt": facts.tgt, "containment": facts.containment,
        "cardinality": facts.cardinality, "orphan_count": facts.orphan_count,
        "observation_count": facts.observation_count, "pattern": facts.pattern,
    }
    return (
        "다음 조인 검증 관측 통계를 자연어로 진단하라. "
        "payload의 수치만 인용하고 새 수치를 만들지 마라.\n"
        '출력 스키마: {"text": "<한국어 2~3문장>"}\n\n'
        f"{json.dumps(payload, ensure_ascii=False)}"
    )


def build_view_prompt(facts: ViewFacts) -> str:
    payload = {
        "qname": facts.qname, "base_tables": facts.base_tables,
        "join_pairs": facts.join_pairs, "output_columns": facts.output_columns,
        "definition_excerpt": facts.definition_excerpt,
    }
    return (
        "다음 뷰가 어떤 데이터를 어떻게 만드는지 설명하라. "
        "원천 테이블·조인 조건·출력 컬럼을 근거로 삼아라.\n"
        '출력 스키마: {"text": "<한국어 2~3문장>"}\n\n'
        f"{json.dumps(payload, ensure_ascii=False)}"
    )
```

`LlmAiClient`에 메서드 3개 추가:

```python
    def summarize_table(self, table: TableMeta, base_tables: list[str]) -> str:
        return _require_text(self._chat(build_summary_prompt(table, base_tables)))

    def explain_validation(self, facts: ValidationFacts) -> str:
        return _require_text(self._chat(build_validation_prompt(facts)))

    def explain_view(self, facts: ViewFacts) -> str:
        return _require_text(self._chat(build_view_prompt(facts)))
```

- [ ] **Step 4: 통과 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_llm_ai.py -q`
Expected: PASS — 이 시점에 `LlmAiClient`는 AiClient Protocol 5메서드를 모두 갖춘다.

- [ ] **Step 5: 커밋**

```bash
git add backend/app/adapters/llm_ai.py backend/tests/test_llm_ai.py PROGRESS.md
git commit -m "feat(ai): LLM narration for summary, validation, view — 요약·해석 3종 LLM 구현"
```

---

### Task 7: create_ai_client 스위치 + 502 핸들러

**Files:**
- Modify: `backend/app/adapters/ai.py` (`create_ai_client`)
- Modify: `backend/app/main.py` (예외 핸들러)
- Test: `backend/tests/test_llm_ai.py` (스위치), `backend/tests/test_ai.py` (502 엔드포인트)

**Interfaces:**
- Consumes: Task 1 Settings, Task 2 `AiUnavailableError`, Task 4~6 `LlmAiClient`.
- Produces: `create_ai_client() -> AiClient` — AI_BASE_URL 있으면 `LlmAiClient`, 없으면 `FakeAiClient`. 502 응답 `{"error": {"code": 502, "message", "context"}}`.

- [ ] **Step 1: 스위치 실패 테스트** — `backend/tests/test_llm_ai.py`에 추가:

```python
from app.adapters import ai as ai_module
from app.config import get_settings


def test_create_ai_client_switches_on_base_url(monkeypatch):
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
    monkeypatch.setenv("AI_BASE_URL", "")  # 개발자 로컬 .env 간섭 차단
    get_settings.cache_clear()
    try:
        assert isinstance(ai_module.create_ai_client(), ai_module.FakeAiClient)
    finally:
        monkeypatch.delenv("AI_BASE_URL", raising=False)
        get_settings.cache_clear()
```

- [ ] **Step 2: 502 실패 테스트** — `backend/tests/test_ai.py`에 추가:

```python
def test_ai_endpoint_maps_unavailable_to_502(client, load_fixture):
    from app.adapters.llm_ai import AiUnavailableError
    from app.api.ai import get_ai_client

    _seed(client, load_fixture)

    class _DownAi:
        def judge_relations(self, candidates):
            raise AiUnavailableError("llm request failed after retries",
                                     {"url": "http://llm:11434/v1/chat/completions"})

    client.app.dependency_overrides[get_ai_client] = lambda: _DownAi()
    try:
        res = client.post("/api/ai/suggest-relations")
    finally:
        client.app.dependency_overrides.pop(get_ai_client)

    assert res.status_code == 502
    body = res.json()["error"]
    assert body["code"] == 502
    assert "llm" in body["message"]
    assert body["context"]["url"].startswith("http://llm")
```

- [ ] **Step 3: 실패 확인**

Run: `cd backend && .venv/bin/python -m pytest tests/test_llm_ai.py tests/test_ai.py -q`
Expected: FAIL — 스위치 테스트는 Fake만 반환해 isinstance 실패, 502 테스트는 500 (핸들러 없음)

- [ ] **Step 4: create_ai_client 구현** — `backend/app/adapters/ai.py` 마지막의 `create_ai_client`를 교체. 파일 상단에 `from app.config import get_settings` 추가:

```python
def create_ai_client() -> AiClient:
    """AI_BASE_URL 설정 시 실 LLM, 아니면 Fake — 스위치 한 곳 (연결 단계 결정 이행)."""
    # llm_ai가 이 모듈의 타입을 쓰므로 순환 임포트 회피를 위해 지연 임포트
    from app.adapters.llm_ai import LlmAiClient

    settings = get_settings()
    if settings.ai_base_url:
        return LlmAiClient(base_url=settings.ai_base_url, model=settings.ai_model,
                           api_key=settings.ai_api_key, timeout=settings.ai_timeout)
    return FakeAiClient()
```

- [ ] **Step 5: 502 핸들러 구현** — `backend/app/main.py`. import에 `from app.adapters.llm_ai import AiUnavailableError` 추가, 기존 `handle_http_error` 핸들러 위 또는 아래에:

```python
    # AI 프로바이더 장애는 게이트웨이 오류로 — 조용한 폴백 없음 (스펙 §에러 처리)
    @app.exception_handler(AiUnavailableError)
    async def handle_ai_unavailable(request: Request, exc: AiUnavailableError) -> JSONResponse:
        return JSONResponse(
            status_code=502,
            content={"error": {"code": 502, "message": str(exc), "context": exc.context}},
        )
```

- [ ] **Step 6: 전체 테스트 + 린트**

Run: `cd backend && .venv/bin/python -m pytest tests -q && .venv/bin/ruff check app alembic tests`
Expected: 전체 PASS + 린트 클린

- [ ] **Step 7: 커밋**

```bash
git add backend/app/adapters/ai.py backend/app/main.py backend/tests/test_llm_ai.py backend/tests/test_ai.py PROGRESS.md
git commit -m "feat(ai): switch to the real LLM via AI_BASE_URL with 502 on failure — 실 LLM 스위치·502 변환"
```

---

### Task 8: 문서 + 최종 검증

**Files:**
- Modify: `docs/connect.md` ("남은 결정" 섹션 + 신규 §9)
- Modify: `docs/ui-review.md` (AI 제안 수 언급이 있으면 상한 40 반영 — 없으면 무변경)
- Modify: `PROGRESS.md` (진행 표기를 완료 요약 1건으로 압축)
- 확인만: `README.md` (env 변수를 개별 나열하지 않으므로 변경 없을 것으로 예상 — 확인 후 판단)

- [ ] **Step 1: connect.md 갱신** — "남은 결정 (연결 후)" 목록에서 `AI 실 프로바이더 교체 (현재 결정론적 목업 — create_ai_client 한 곳)` 라인을 제거하고, "8. live 전환 — 정지점 18" 섹션 뒤에 추가:

```markdown
## 9. AI 실 LLM 연결 (선택 — 언제든 가능, n8n과 무관)

서버 `.env`에 사내 LLM 정보를 채우고 backend만 재기동:

```
AI_BASE_URL=http://<사내LLM호스트>:<포트>/v1   # OpenAI 호환 (Ollama/vLLM/LiteLLM)
AI_MODEL=<서버에 로드된 모델명>
AI_API_KEY=            # 무인증 서버면 비워둔다
```

`docker compose up -d backend` (재기동).

- ✅ 통과 기준 (전부 화면):
  - 테이블 상세 → AI 요약 재생성 → 휴리스틱 문장("주요 컬럼: …")이 아닌 자연어 요약
  - 검색창 `?` 프리픽스 질의 → 관련도 순위 + 한국어 근거
  - 관리 → AI 관계 제안 → 후보에 판정 근거 문장이 붙음 (상한 `AI_SUGGEST_MAX_PAIRS`=40)
- 실패 시: 화면에 502와 원인(url·모델)이 그대로 표시된다 — `AI_BASE_URL` 오타,
  LLM 서버 다운, 모델명 불일치 순으로 확인. 응답이 느리면 `AI_TIMEOUT` 상향.
- `AI_BASE_URL`을 비우면 즉시 기존 목업으로 복귀한다 (재기동 필요).
```

- [ ] **Step 2: ui-review.md 확인·갱신**

Run: `grep -n "334\|제안" docs/ui-review.md`
AI 제안 개수를 언급하는 라인이 있으면 "상한 `AI_SUGGEST_MAX_PAIRS`(기본 40)까지"로 서술 갱신, 없으면 무변경.

- [ ] **Step 3: README 영향 확인**

Run: `grep -n "AI\|LLM" README.md`
README는 env 변수를 개별 나열하지 않으므로 변경 없음이 예상값. AI 기능 서술이 "목업" 전제로 적힌 곳이 있으면 그 문장만 갱신.

- [ ] **Step 4: PROGRESS.md 압축** — 2026-08-04의 "AI 실 LLM 프로바이더 전환 설계 확정" 항목과 태스크별 진행 표기를 완료 요약 1건으로 재작성 (구현 내용·결정·테스트 수 포함, 1~3줄).

- [ ] **Step 5: 최종 전체 검증**

Run: `cd backend && .venv/bin/python -m pytest tests -q && .venv/bin/ruff check app alembic tests && cd ../frontend && npm test`
Expected: 백엔드 전체 PASS + 린트 클린 + 프론트 vitest PASS (프론트 무변경 확인)

- [ ] **Step 6: 커밋**

```bash
git add docs/connect.md docs/ui-review.md PROGRESS.md
git commit -m "docs(connect): AI LLM hookup runbook section — AI 연결 절차·체크리스트"
```

(README 변경이 발생했다면 같은 커밋에 포함.)

---

## 남는 리스크 (실행자 참고)

- **실 LLM 품질은 테스트가 보증하지 않는다** — 스텁 기반 테스트는 배관만 검증. 실 품질은 connect.md §9 화면 체크리스트로 수동 확인 (서버의 실제 모델·규모에서만 가능).
- **동기 호출 지연** — CPU 추론 서버면 판정 40페어에 수십 초 가능. `AI_TIMEOUT` 상향으로 대응하고, 그래도 부족하면 잡 기반 비동기 전환(스펙 §비범위 — 별도 사이클).
- **seed_ui_states 결과 수 감소** — 기존 Fake 전량 탐색(로컬 리허설 334건)이 스코어러 상한 40건으로 줄어든다. UI 리허설 밀도가 부족하면 `AI_SUGGEST_MAX_PAIRS` 로컬 상향으로 해결.
