# 미리보기 어드밴스드 필터 — 복수 조건·제외·NULL, SQL 반영

2026-08-11. 대상: 홈 하단 테이블 미리보기(PreviewSection)의 값 필터.

## 목표

단일 (컬럼, 값, 부분/정확) 필터를 **조건 목록(AND 결합)**으로 확장한다. 각 조건은
제외(NOT)·NULL 검사까지 표현하고, 결과 행과 「SQL로 보기」 쿼리에 그대로 반영된다.
재검색 의미는 기존과 동일 — 조건은 항상 소스 쿼리 WHERE로 내려간다(클라이언트 필터 아님).

## 데이터 모델

```ts
type PreviewFilterOp =
  | "contains"      // LIKE N'%v%'
  | "eq"            // = N'v'        (기존 exact)
  | "not_contains"  // NOT LIKE N'%v%'
  | "neq"           // <> N'v'
  | "is_null"       // IS NULL       (value 없음)
  | "not_null";     // IS NOT NULL   (value 없음)

interface PreviewFilterCond { column: string; op: PreviewFilterOp; value: string | null }
```

- 결합은 **AND 고정**. OR·괄호 그룹은 이번 범위 밖(제안만).
- 조건 수 상한 5 (`MAX_PREVIEW_FILTERS`), 값 길이 상한 100(기존 유지).
- 같은 컬럼에 여러 조건 허용(예: `NM contains '김' AND NM not_contains '김치'`).
- 동일 (column, op, value) 중복 추가는 무시.

## 와이어·백엔드

- `GET /api/objects/{id}/preview?filters=<JSON 배열>&limit=` — 기존
  `filter_column/filter_value/filter_mode` 파라미터는 **교체**(프론트가 유일한 클라이언트,
  같은 저장소에서 함께 배포). 응답의 `filter` 필드도 `filters: PreviewFilterCond[]`
  (무필터 = 빈 배열)로 교체.
- 검증: JSON 파싱 → Pydantic(op Literal, value max 100) → 컬럼 실재 확인(400),
  null 계열 외 op의 value 필수(400), 개수 상한(400).
- 감사 로그: `filter A~'v' AND B!='x' AND C IS NULL` 식으로 조건 전부 기록
  (~ 부분, = 정확, !~ 부분 제외, != 정확 제외).
- FakeTablePreview: 조건 전부 평가(대소문자 무시 — MSSQL 기본 collation과 결).
  `is_null`은 `cell is None`만 — 빈 문자열은 NULL이 아니다(live 의미 보존).
- N8nTablePreview: body에 `filters` 배열을 보낸다. 조건이 정확히 1개이고
  contains/eq이면 구버전 W2 호환용 `filter_column/filter_value/filter_mode`도 병송.
  필터를 요청했는데 응답 query가 없거나 WHERE가 없으면 raise —
  구 W2가 필터를 무시한 무필터 행을 "필터된 결과"로 보여주는 사고를 차단
  (multi_join_preview의 "신 W2 전용" 가드와 같은 결).
- W2 빌더(`tools/build_n8n_workflow.py`): table_preview 분기가 `b.filters`를 읽어
  AND 결합 WHERE를 만들고, 없으면 구버전 필드로 폴백. 워크플로 JSON 재생성 —
  **운영 n8n엔 W2 재임포트 필요**.

## 프론트엔드

- **필터 바**: [컬럼 ▾] [연산자 ▾(6종)] [값 입력+datalist] [추가] — Enter=추가.
  추가/제거 즉시 재조회(칩은 항상 **적용된** 상태만 표시 — 화면과 데이터 불일치 방지).
  NULL 계열 op 선택 시 값 입력 비활성. 상한 도달 시 추가 버튼 비활성.
- **칩 줄**: 적용 조건을 `COL 포함 "v"` / `COL ≠ "v"` / `COL IS NULL` 칩으로,
  각각 ×로 개별 제거, 「필터 해제」는 전체 제거(기존 버튼 유지).
- **값 자동완성**: 로드된 행의 고유값(countUniqueValues) 상위 50개를 `<datalist>`로.
- **셀 더블클릭 = 그 값으로 eq 필터** (null 셀은 is_null) — PreviewTable에
  `onQuickFilter` prop 추가.
- **SQL 보기**: `buildPreviewSql`이 조건 목록을 `WHERE a\n  AND b` 로 렌더.
  토크나이저 키워드에 AND·NOT·IS·NULL 추가. 컬럼 칩 편집은 무변경.
- `RefetchOptions` → `{ filters?, limit? }`. PreviewTable 빈 상태 판정은
  `data.filters.length > 0`.

## 이번에 함께 구현하는 편의 기능

1. NULL/NOT NULL 연산자 (op 6종에 포함)
2. 셀 더블클릭 빠른 필터
3. 값 입력 자동완성(로드 행 고유값 datalist)

## 제안만 (이번 범위 밖)

- OR·괄호 그룹 결합, 숫자·날짜 범위 연산자(>, <, BETWEEN — 타입 인지 필요),
- 테이블별 필터 프리셋 저장(localStorage), WHERE 절만 복사 버튼.

## 검증

- vitest: buildPreviewSql 다중 조건·NOT LIKE·<>·IS NULL·토크나이저.
- pytest: filters 파싱·컬럼 검증·op 검증·상한·감사 문자열·Fake 평가·n8n body/가드.
- tsc·eslint 클린, 헤드리스 브라우저 실측(추가→칩→SQL→제거 왕복).
