# 조인 검증 분리 + 읽기 전용 ERD 설계

날짜: 2026-08-07
상태: 승인됨 (구현 전)

## 배경과 목표

지금 ERD 캔버스는 탐색·검증·확정이 한 화면에 얽혀 있다 — JoinBuilder 드래그 조인,
AI 제안, 후보 스캔, containment 실행이 전부 캔버스 위에서 일어나고, 그만큼 버그도
캔버스에 몰렸다(핸들 높이 CSS, connectionMode 등). 역할을 분리한다:

- **검증은 전용 1:1 페이지에서** — 좌/우 테이블을 골라 게이트 → containment →
  조인 프리뷰 → 키 확정의 단선 흐름으로.
- **ERD는 읽기 전용 결과 뷰로** — 검증된 관계(confirmed)와 실제 FK만 그린다.
  검증할수록 지도가 자라는 그림.

## 확정된 결정

| 결정 | 내용 |
|---|---|
| ERD 엣지 범위 | confirmed + FK만. lineage·inferred·ai_suggested 제외 |
| 뷰 처리 | ERD에서 완전 제외. 뷰→base 추적은 브라우저 TableDetail의 lineage 섹션이 담당 (기능 중복 없음) |
| ERD 렌더 모델 | 전체 그래프 한 번에. 앵커·검색·이웃 확장·depth 삭제. 연결요소(connected component)별 클러스터 정렬 |
| 게이트 기준 | ① 타입 패밀리 불일치 → 즉시 차단(카탈로그만, 쿼리 0회) ② TOP 200 샘플에서 양쪽 모두 distinct 비율 낮음(m:n 추정) → 차단. 값 겹침은 판정하지 않음 — TOP 200은 클러스터드 인덱스 순서라 오차단 위험 |
| 샘플 노출 | 기본 통계만(시인성 중심 디자인). 샘플 rows는 온디맨드 버튼 + preview allowlist 스키마 한정 |
| 컬럼 선택 | 자동 후보(타입 패밀리 + 이름 유사도 점수순) + 수동 양쪽 컬럼 직접 선택 병행 |
| 테이블 조합 | 모든 가시 테이블 조합 허용 — 숨은 키 발굴이 목적. HIDDEN_SCHEMAS·말이 안 되는 페어는 n8n 도달 전 차단 |
| 진입점 | 헤더 탭 2개 복구: "조인 검증" + "ERD" |
| 기존 검증 부속 | AI 제안 → 검증 페이지로 이사. JoinBuilder(N-way)·캔버스 스캔 UI 삭제, 백엔드 N-way 엔드포인트는 유지(미사용) |

## 화면 구성

### `/verify` — 조인 검증 (신규)

- 좌/우 테이블 피커 2개. 기존 `searchObjects` 재사용, HIDDEN_SCHEMAS 제외.
- 두 테이블 확정 시 후보 페어 리스트 자동 표시(점수순) + 수동 컬럼 선택.
- 단계 진행 상태머신: `idle → gate(pass/block) → containment 완료 → preview(선택) → confirmed`.
  - **① 게이트**: 타입 배지·distinct 비율 바·판정 색상(통과/차단)으로 통계 카드 표시.
    차단 사유는 명시 문구 — "타입 불일치 (int vs varchar)" / "양측 모두 중복 심함 (m:n 추정)".
  - **② containment**: 기존 `POST /api/validate/containment` 호출. containment %·
    cardinality·orphan 표시. 판정 로직은 기존 `join-verdict.ts` 재사용.
  - **③ 조인 프리뷰(선택)**: 기존 `POST /api/validate/preview` (TOP 20, allowlist +
    마스킹 + 감사) — 프론트 최초 연결.
  - **④ 키 확정**: 기존 `POST /api/relations/confirm`, 기존 보안 게이트 그대로.
- 사이드에 "검증 대기 후보" 리스트(`ai_suggested`·`inferred` 관계) — 클릭 시
  테이블·컬럼 프리필. AI 제안 실행 버튼도 이 페이지로 이사.
- Top 200 샘플 rows 미리보기는 버튼 클릭 시에만, allowlist 허용 스키마 한정
  (기존 테이블 미리보기 컴포넌트 재사용).

### `/erd` — 읽기 전용 (재작성)

- 마운트 시 `GET /api/erd` 한 번 — confirmed+FK 전체 그래프.
- 남는 인터랙션: 팬/줌, 노드 컬럼 접기/펴기, 엣지 클릭 → 검증 근거 읽기
  (containment %, cardinality, last_verified_at).
- 삭제: SearchPanel, JoinBuilder, AI 버튼, 스캔, 이웃 확장, 노드 숨김,
  40개 확인 모달, showViews 토글.
- ELK 레이아웃은 유지하되 연결요소별 클러스터 정렬.

### 헤더·딥링크 재편

- AppHeader에 "조인 검증"·"ERD" 탭 복구 (`nav.verify` 신규, `nav.erd` 부활).
- 브라우저 "ERD에서 보기" → `/erd?focus=<id>`: 그래프에 있으면 하이라이트+센터링,
  없으면 "미검증 — 검증하러 가기" 안내(→ `/verify` 프리필 링크).
- "빌더에 추가" 계열 딥링크(JoinKeyBar 등) → `/verify?src=...&tgt=...` 프리필로 교체.
- ChatPanel 테이블 칩 → `/erd?focus=` 동작.

## 백엔드

### 신규

- **`GET /api/erd`** — confirmed 관계 + FK에 참여하는 테이블·엣지 전체.
  앵커·depth 없음. 감춘 스키마 노드째 제외(기존 정책 재사용). 노드에 컬럼 포함.
- **`POST /api/validate/gate`** — `{src_column_id, tgt_column_id}`:
  1. 타입 패밀리 검사 — 카탈로그 데이터타입만으로, 불일치면 n8n 없이 즉시 차단.
  2. TOP 200 distinct 샘플 — n8n W2 신규 쿼리 kind `sample_distinct`
     (`SELECT COUNT(*), COUNT(DISTINCT col) FROM (SELECT TOP 200 col FROM t) s`).
     양쪽 모두 distinct/rows < 0.9면 차단(둘 다 중복투성이 = m:n 추정).
     임계값 0.9는 Settings 튜닝 값(`GATE_DISTINCT_RATIO`, `.env` 항목 포함 —
     `rules/backend/config.md`의 Tuning 분류).
  3. 결과는 컬럼 단위 캐시 — `CatalogColumn`에 `sample_rows`/`sample_distinct`/
     `sampled_at` 추가(마이그레이션 0014). 캐시 적중 시 재쿼리 없음.
  - 게이트는 원본 값을 내보내지 않으므로 allowlist 무관, 감사 대상 아님
    (실값 노출 지점은 기존대로 preview뿐).
- **`GET /api/validate/pair-candidates`** — 두 테이블 간 후보 컬럼 페어 점수순.
  기존 `join_check` 스코어링(타입 패밀리 + 이름 유사도) 재사용, 카탈로그만.

### 재사용 (변경 없음)

`POST /api/validate/containment`, `POST /api/validate/preview`,
`POST /api/relations/confirm`, AI 제안 잡, 후보 조회.

### 삭제·유지

- 삭제: `GET /api/objects/{id}/graph` (N-hop BFS) — 새 ERD가 대체해 고아가 됨.
  관련 테스트 함께 정리.
- 유지(미사용): `POST /api/join/preview` (N-way `multi_join_preview`) — UI만 제거.

### n8n

`tools/build_n8n_workflow.py`에 `sample_distinct` kind 추가 + `N8nJoinValidator`
어댑터 메서드 + `FakeValidator` 대응 구현(테스트용).

## 프론트 코드 이동

- `join-verdict.ts` — `/verify` 결과 카드에서 재사용 (이동 없음, 소비처 교체).
- 삭제: `JoinBuilder.tsx`, `join-draft.ts`(+테스트), ErdCanvas의 검증·확장·숨김
  관련 코드 — ErdCanvas 1,319줄이 대략 절반 이하로.
- i18n: `nav.erd` 부활, `nav.verify`·게이트 문구·단계 라벨 추가.

## 에러 처리

- 게이트 차단 → 차단 사유 문구 + 다음 행동 안내(다른 컬럼 선택).
- n8n 타임아웃·실패 → 기존 검증 플로우와 동일한 에러 표면화 패턴.
- `/erd?focus=` 대상이 그래프에 없음 → 안내 배너(에러 아님).

## 테스트

- 백엔드 (FakeValidator): gate 타입 차단·중복 차단·캐시 적중, pair-candidates
  스코어링, `/api/erd` 그래프 구성(confirmed+FK만·감춘 스키마 제외).
- 프론트: verify 단계 전이(게이트 통과/차단 분기), ERD 읽기 전용 렌더,
  딥링크 프리필(`?src/tgt`, `?focus`).
- 기존 anchor-graph·JoinBuilder 테스트는 삭제·교체.

## 구현 순서

1. 백엔드: 마이그레이션 0014 → gate → pair-candidates → `/api/erd` (+테스트)
2. `/verify` 페이지 (+테스트)
3. `/erd` 재작성 (+테스트)
4. 헤더 탭·딥링크·구 코드 삭제·i18n·README 정리

각 단계는 독립적으로 테스트 가능하며 이 순서로 커밋을 나눈다.
