# AI 실 LLM 프로바이더 전환 — 설계

2026-08-04. 기존 AI 5기능(관계 제안·자연어 탐색·테이블 요약·검증 해석·뷰 해석)을
`FakeAiClient`(결정론적 휴리스틱)에서 사내 셀프호스트 LLM으로 전환한다.
`docs/connect.md` "남은 결정"의 "AI 실 프로바이더 교체" 항목의 이행이다.

## 확정 결정

| 항목 | 결정 |
|------|------|
| 호출 경로 | 사내 셀프호스트 LLM 직접 호출 (n8n 무관 — 수집 확인 결과와 독립) |
| API 형식 | OpenAI 호환 `/v1/chat/completions` (Ollama·vLLM·LiteLLM 공통) |
| 규모 전략 | 스코어러가 뽑은 상위 후보 페어만 LLM이 재판정 (2,342 테이블 전량 프롬프트 불가) |
| 범위 | 기존 5기능의 실 LLM 전환만 — 새 기능 없음 |
| 구현 방식 | stdlib(`urllib`) 동기 클라이언트, 의존성 추가 없음 |

## 아키텍처

```
backend create_ai_client()          ← 스위치 한 곳 (adapters/ai.py)
   ├─ AI_BASE_URL 없음 → FakeAiClient (현행 유지 — 로컬·CI 오프라인)
   └─ AI_BASE_URL 있음 → LlmAiClient (신설 adapters/llm_ai.py)
          │  _post_chat(): urllib POST /v1/chat/completions
          │  재시도 1회 + 로깅 후 raise (n8n_query.py 패턴)
          │  temperature=0, JSON-only 응답 파싱 (코드펜스 관용)
          ▼
      사내 LLM 서버 (OpenAI 호환)
```

- 엔드포인트 5종의 요청·응답 계약은 불변 — **프론트엔드 무변경**.
- 인터페이스는 기존대로 메타데이터 타입만 받는다 — 원본 데이터 값이 프롬프트로
  샐 경로가 구조적으로 없음 (계획 §5.2 원칙 유지). DDL 발췌는 스키마 메타데이터.

## 설정 (config 룰 분류)

| 변수 | 분류 | 기본 | 설명 |
|------|------|------|------|
| `AI_BASE_URL` | Environment | `""` | 예: `http://<사내LLM>:11434/v1` — 비면 Fake |
| `AI_MODEL` | Environment | `""` | 서버에 로드된 모델명 |
| `AI_API_KEY` | Environment | `""` | 선택 — 비면 Authorization 헤더 생략 |
| `AI_TIMEOUT` | Tuning | `60` | LLM 응답 대기 상한(초) |
| `AI_SUGGEST_MAX_PAIRS` | Tuning | `40` | LLM 재판정에 넘길 후보 페어 상한 |

Environment 항목은 `.env` + Settings + docker-compose `${VAR}` 3곳 동기화
(Dockerfile ENV는 `SOURCE_MODE`만 폴백으로 두는 기존 관행 유지 — compose 주입이 소스 오브 트루스).

## 에러 처리

- LLM 불가·타임아웃·불량 JSON → 어댑터가 `AiUnavailableError`(원인 컨텍스트 포함) raise.
- `main.py` 예외 핸들러가 502로 변환 — 조용한 Fake 폴백 **없음**, 프론트 기존
  에러 표시에 원인이 그대로 노출된다.

## 기능별 설계

### 1. 관계 제안 — `POST /api/ai/suggest-relations`

- 엔드포인트가 기존 스코어링 도메인으로 스냅샷 전체 후보 페어 산출
  → 기존 FK·확정 관계 중복 제거 → 상위 `AI_SUGGEST_MAX_PAIRS`개만 LLM 전달.
- Protocol 메서드 교체: `suggest_relations(tables)` → `judge_relations(candidates)`.
  입력은 페어 + 양쪽 테이블·컬럼 메타(이름·타입·PK·행수), 출력은 판정(수용/기각) +
  한국어 근거 한 줄. 수용 페어만 기존 흐름대로 `candidate/ai` 적재
  (검증 큐 직행 — confirmed 금지 가드 그대로).
- `FakeAiClient`도 같은 인터페이스로 전환 — 기존 명명 유사도 휴리스틱으로 결정론적
  판정 (오프라인 테스트·픽스처 유지). 엔드포인트 응답 스키마 불변.

### 2. 자연어 탐색 — `GET /api/ai/search-tables`

- 2단계: **프리필터(코드) → LLM 재랭크**.
  1. 질의어를 테이블명 + 컬럼명에 정규화 매칭해 상위 50개 추림
     (기존 Fake 매칭 로직 확장 — 상한은 내부 상수, 비즈니스 상수라 .env 미등재).
     각주: 카테고리 매칭은 구현에서 제외 — 카테고리는 프론트 파생 분류(테이블 접두어
     규칙)라 백엔드 TableMeta에 없다.
  2. 추린 목록의 메타만 LLM에 넘겨 관련도 순위 + 한국어 근거.
- 한계(명시): 이름·컬럼에 흔적이 없는 순수 의미 질의는 프리필터 리콜에 걸리지
  않는다 — 임베딩 도입은 이번 범위 밖(별도 사이클).

### 3~5. 요약·검증 해석·뷰 해석 — 1:1 호출 교체

- `summarize/{object_id}`: 컬럼(이름·타입·PK)·행수·원천 테이블 → 한 줄 한국어 요약.
  `ai_summaries` 캐시 흐름 그대로 (`force` 재생성 포함).
- `explain-validation`: 포함률·카디널리티·고아 수·confidence 패턴·관측수 →
  진단 문장. 프롬프트에 "서버가 준 facts의 수치만 사용, 수치 창작 금지" 명시.
- `explain-view/{object_id}`: 원천 테이블·조인 페어·출력 컬럼·DDL 발췌 → 뷰 설명.

## 프롬프트 원칙

- system 프롬프트 고정: 역할(DB 스키마 분석 도우미)·한국어 응답·기능별 JSON 출력 스키마.
- 기능별 user 프롬프트 빌더는 순수 함수로 분리 — 단위 테스트 대상.
- `temperature=0` — 같은 입력이면 최대한 같은 출력.

## 테스트

- `_post_chat` 스텁 대체 (외부 의존성 mock 룰 — 실 LLM 호출은 테스트에 없음):
  - 프롬프트에 메타데이터 포함 검증, JSON 파싱(정상·코드펜스·불량→에러),
    재시도 후 raise, 판정→suggestion 매핑.
- 기존 `test_ai.py`: `judge_relations` 인터페이스 반영 갱신, Fake 경로 회귀 유지.
- `AiUnavailableError` → 502 변환 핸들러 테스트.
- 실 LLM 수동 검증 절차(연결 후 화면 체크리스트)는 `docs/connect.md`에 추가.

## 비범위

- 스키마 Q&A 채팅 패널 — 별도 사이클.
- 임베딩 기반 의미 검색 — 별도 사이클.
- 잡 기반 비동기(202+폴링) 전환 — 실측에서 동기+타임아웃이 부족할 때 재검토.
