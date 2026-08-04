# AI 후속 사이클(1~5) — 설계

2026-08-05. 실 LLM 전환(2026-08-04 스펙)의 후속 5파트를 한 사이클로 구현한다:
① 판정 근거(reason) 영속·표시, ② 기각 이력, ③ 임베딩 의미 검색(+폴백),
④ 스키마 Q&A 챗, ⑤ 잡 기반 비동기 전환.

## 확정 결정

| 항목 | 결정 |
|------|------|
| 진행 구조 | 통합 스펙·계획 1개, 마이그레이션 0009 1개, 1·2→5→3→4 순차 랜딩 |
| 기각 저장 | `relations`에 `status='rejected', origin='ai'` + reason (별도 테이블 없음) |
| 임베딩 | 같은 `AI_BASE_URL`의 OpenAI 호환 `/embeddings`. **모델 미설정·실패 시 키워드 프리필터 자동 폴백** — 검색은 임베딩 문제로 죽지 않는다 |
| 임베딩 부하 (사용자 제약) | **잡 1회 처리 상한 기본 1,000(2,000 초과 금지)** + 호출당 배치 + 호출 간 대기 — 서버 상태 나쁨 전제 |
| 챗 UI | 헤더 버튼 → 전역 플로팅 패널. 대화는 세션 메모리만(DB 영속 없음) |
| 비동기 범위 | suggest-relations·임베딩 인덱싱 → `ai_jobs` 202+폴링. **챗·검색은 동기 유지** |
| 원칙 유지 | 프롬프트는 메타데이터만, candidate/ai 적재·confirmed 금지, 동기 LLM 장애 502(폴백 없음 — 검색 프리필터 폴백은 예외로 명시) |

## 데이터 모델 — 마이그레이션 0009 (하나로 통합)

- `relations.reason: Text | None` — LLM 판정 근거(수용·기각 공용). 기존 행 NULL.
- `ai_embeddings`: `id`, `object_qname`(unique), `model`, `vector`(JSON 텍스트),
  `source_hash`, `updated_at`. pgvector 없이 순수 Python 코사인(2,342×~768차원
  ≈ 수십 ms) — 이미지·의존성 무변경.
- `ai_jobs`: `id`, `kind`('suggest'|'embed_index'), `status`(queued/running/done/failed),
  `progress_done`, `progress_total`, `result`(JSON 텍스트 — suggest의
  {suggested, created, items}), `error`, `triggered_by`, `created_at`,
  `started_at`, `finished_at`. `scan_jobs` 패턴(202 + BackgroundTasks +
  폴링, 세션 팩토리 DI) 준용.

## 설정 (config 룰 분류)

| 변수 | 분류 | 기본 | 설명 |
|------|------|------|------|
| `AI_EMBED_MODEL` | Environment | `""` | 임베딩 모델명 — **비우면 임베딩 전체 비활성(폴백 경로만)** |
| `AI_EMBED_BATCH` | Tuning | `32` | `/embeddings` 호출당 텍스트 수 |
| `AI_EMBED_JOB_CAP` | Tuning | `1000` | 인덱싱 잡 1회 처리 상한 — 2,000 초과 설정 금지(부하 관리) |
| `AI_EMBED_SLEEP_MS` | Tuning | `500` | 임베딩 호출 간 대기(ms) — 서버 부하 완화 |

`.env.example` + Settings + docker-compose(int형은 `:-기본값` 폴백 — 구 .env 부팅 안전 관행) 동기화.

## 파트 1 — 판정 근거 영속·표시

- judge 수용분 적재 시 `Relation.reason = 판정 근거`.
- 그래프 API의 `ai_suggested` 엣지 payload에 `reason` 추가 → ERD 엣지 툴팁 표시.
- TableDetail 추론 관계 행에 reason 표시(있을 때만).
- 검증 큐 직행·confirmed 금지 가드 불변. 응답 계약은 additive(키 추가)만.

## 파트 2 — 기각 이력

- 기각분도 `Relation(status='rejected', origin='ai', reason=사유, created_at)` 적재.
- 기존 dedupe(전 relations 양방향 키)가 rejected도 보므로 **추가 로직 없이**
  재실행에서 자동 제외 → 페이징이 항상 새 후보로 전진("전량 기각 정체" 소멸).
- 그래프·엣지·관계 목록에 rejected가 노출되지 않음을 확인하고, 노출되면
  상태 필터를 추가한다(rejected는 이력이지 관계선이 아니다).
- 수동 복구: 기존 재검증(T2) 흐름이 rejected 페어를 검증하면 기존 상태 전이
  규칙을 따른다 — 이번 사이클에서 새 UI는 만들지 않는다.

## 파트 5 — 잡 기반 비동기 (suggest·임베딩만)

- `POST /api/ai/suggest-relations` → **202 + `ai_jobs` 폴링**으로 전환.
  잡 본문이 기존 동기 로직(후보 선별→dedupe→judge→적재)을 그대로 실행,
  진행은 "판정 페어 n/N", 완료 시 `result`에 {suggested, created, items}.
- 폴링: `GET /api/ai/jobs/{id}` (scan의 `/api/jobs/{id}`와 동일 규약, ai_jobs 전용).
- 프론트 ERD 버튼: 시작 → 진행 표시(기존 T3 스캔 UI 문법) → 완료 시 기존
  "N건 판정, M건 생성" 안내 재사용. `suggestRelationsAi()` API 함수·테스트 갱신.
- 임베딩 인덱싱도 같은 테이블(kind='embed_index') — 관리 콘솔에 버튼+진행 바.
- **챗·검색은 동기 유지**(대화형 — 최악 지연 2×AI_TIMEOUT 문서화).
- 동시 실행 가드: kind별 running 1개 초과 금지(중복 시작 409).

## 파트 3 — 임베딩 의미 검색 + 폴백

- `llm_ai.py`에 `_post_embeddings(texts: list[str]) -> list[list[float]]` —
  OpenAI 호환 `/embeddings`(입력 배열), 재시도 1회 후 raise. 코사인은 순수 함수
  `rank_by_cosine(query_vec, rows, top_k)` (stdlib만).
- **인덱싱 잡**: 텍스트 = qname + 컬럼명 나열 + (있으면) `ai_summaries` 요약.
  `source_hash`(sha256)로 변경분만 재임베딩. 잡 1회 `AI_EMBED_JOB_CAP`개까지,
  호출당 `AI_EMBED_BATCH`개, 호출 간 `AI_EMBED_SLEEP_MS` 대기. 상한 도달 시
  잡은 done + 남은 개수를 result에 기록 — 재실행이 이어간다(제안 페이징과 동일 문법).
  부분 진행분은 실패 시에도 저장 유지.
- **검색 흐름** (`GET /api/ai/search-tables`): 임베딩 가용(모델 설정 + 인덱스
  비어있지 않음 + 질의 임베딩 성공) → 코사인 top-50을 프리필터 결과로 사용 →
  기존 LLM 재랭크. **어느 단계든 실패하면 키워드 프리필터로 자동 폴백** —
  검색이 임베딩 문제로 502가 되지 않는다(재랭크 LLM 실패만 기존대로 502).
- 응답에 `mode: "embedding" | "keyword"` 추가(additive — 프론트 무영향, 디버깅용).

## 파트 4 — 스키마 Q&A 챗

- **백엔드** `POST /api/ai/chat`: 입력 `{question: str, history: [{role, content}]}`
  (history는 프론트가 보내는 최근 6턴 이하 — DB 영속 없음).
  컨텍스트 빌더(순수 함수 지향): 파트 3 검색(임베딩→폴백 동일)으로 관련 테이블
  top-8 → 각 테이블의 컬럼(이름·타입·PK)·AI 요약·validated/confirmed 관계·
  lineage(뷰 원천)를 메타데이터로 프롬프트 구성. 응답 `{"answer": str,
  "tables": [qname]}` — tables는 컨텍스트에 실제 포함된 것만(환각 가드).
- **Protocol 확장**: `AiClient.answer_question(question, history, context) -> str`
  (6번째 메서드 — context는 `ChatContext` frozen dataclass: 테이블별 컬럼·요약·
  관계·lineage 메타데이터, 계획에서 필드 확정). `FakeAiClient`는 컨텍스트 테이블 나열형 결정론 응답 —
  오프라인 테스트·픽스처 유지.
- **프론트**: `AppHeader`에 챗 버튼 → 우하단 플로팅 패널(전역, 세션 메모리만).
  메시지 목록·입력·로딩 표시·답변의 테이블 칩(클릭 → 메인 브라우저 해당 테이블).
  AI 미연결(Fake)이면 패널 상단 "AI 미연결 — 목업 응답" 배지 — chat 응답의
  `"mock": true` 플래그(FakeAiClient 경로일 때만 부여, additive)로 판별.
- 동기 호출 — LLM 장애는 502가 패널 에러로 표시.

## 에러 처리

- 동기 경로(재랭크·요약·해석·챗): 기존 `AiUnavailableError` → 502 유지.
- 잡 경로(suggest·임베딩): 실패는 `ai_jobs.status='failed'` + `error` 기록 —
  502 규약 대상 아님. 폴링 응답이 error를 그대로 노출.
- 검색 임베딩 실패는 에러가 아니라 **폴백 신호** — warning 로그 + keyword 모드.

## 테스트 (전부 urlopen 목킹 — 실 LLM·임베딩 호출 없음)

- 코사인 순수 함수 단위(직교·동일·역방향 벡터).
- 폴백 3경로: 모델 미설정 / 임베딩 호출 실패 / 인덱스 빈 경우 → keyword 모드.
- 인덱싱 잡: 상한(JOB_CAP) 준수, source_hash 스킵, 배치 분할 호출 수, 부분 저장.
- rejected 적재·재실행 자동 제외(페이징 전진), reason 영속.
- suggest 202+폴링 계약(시작→진행→result), kind별 중복 시작 409.
- 챗: 컨텍스트 빌더 순수 함수, tables 환각 가드, Fake 결정론 응답, history 전달.
- 프론트 vitest: 챗 패널 순수 로직(테이블 칩 파싱 등)만.

## 문서

- `docs/connect.md` §9 확장: 임베딩 활성 절차(AI_EMBED_MODEL 채우기 → 관리
  콘솔 인덱싱 버튼(1회 최대 1,000개 — 2,342 테이블이면 3회 실행) → `?` 검색
  화면 확인), 챗 사용법, suggest 버튼의 잡 전환 안내.
- README 개발 섹션 영향 확인(변경 시 같은 커밋).

## 비범위

- 대화 이력 DB 영속·공유 — 세션 메모리만.
- rejected 수동 복구 전용 UI — 기존 재검증 흐름으로 충분.
- 임베딩 자동 재인덱싱(수집 후 훅) — 수동 버튼만, 자동화는 운영 후 판단.
- 챗 스트리밍 응답 — 동기 1회 응답부터.
