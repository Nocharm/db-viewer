# ERD 조인 빌더 + 그래프 가독성 개선 — 설계

2026-08-05. T2/T3 검증 UI를 계층 용어 그대로 노출하는 현재 구조를 폐기하고,
**ERD 위에서 컬럼을 끌어 조인을 만들고 → 유효성 판정을 문장으로 받고 → 실행 SQL과
샘플 20행을 확인하는** 단일 흐름으로 대체한다. 함께 ERD 그래프 자체의 가독성
(카디널리티 표기·엣지 인코딩·뷰 폭주·조인 경로 강조)을 개선한다.

## 문제

사용자가 지목한 세 가지:

1. **용어** — `T2 검증`, `전수 탐색 (T3)`가 내부 계층 이름 그대로 버튼 라벨이다.
   처음 보는 사용자는 둘의 차이·비용·언제 쓰는지를 알 수 없다.
2. **흐름** — 같은 검증이 `ColumnPanel`(ERD 우측) · `ColumnCheckModal`(브라우저) ·
   `TableDetail` 조인검증 세 곳에 각각 다른 모습으로 흩어져 있다. `ColumnPanel`
   안에서도 T3 블록이 후보목록과 T2 액션 사이에 끼어 흐름을 끊는다.
3. **결과 해독** — `containment 88.2% · N:M · 고아 12 · confidence 0.7`이 나열될 뿐,
   "이 조인은 써도 되나"라는 판정이 없다. 확정 버튼을 누를 근거를 사용자가 조합해야 한다.

그리고 근본 요구: **두 개 또는 N개 테이블에서 컬럼을 골라 조인 쿼리가 유효한지와
그 결과를 ERD에서 미리 볼 수 있어야 한다.**

## 확정 결정

| 항목 | 결정 |
|------|------|
| 조인 입력 | **드래그로 연결** — 컬럼 행에서 다른 테이블 컬럼 행으로 끌면 스텝이 쌓인다 |
| 추천 | 드래그 시작 시 T1 후보를 **컬럼 하이라이트**로 표시 (`highlightColumns` 재사용) |
| 검증 실행 | 드롭 즉시 그 페어의 T2 **자동 실행** (단일 페어 — 현재와 동일 비용) |
| 미리보기 | **명시적 버튼 + 감사 로그** 유지 (원본 값이 나가는 유일한 지점) |
| 판정 표시 | **증상명 + 처방** 문장. 수치는 접힘 영역으로 이동(정보 손실 없음) |
| N테이블 판정 | 스텝 중 **최악값**을 전체 판정으로. "가장 약한 고리는 N번" 표기 |
| SQL 진실의 원천 | **W2가 만들고 실행문을 응답에 담아 되돌려준다.** 프론트는 조립하지 않는다 |
| 노드 컬럼 목록 | 24개 절단 폐기 → 전체 렌더 + **최대높이 상한 + 내부 스크롤(청크)** |
| 노드 기본 상태 | **접힘 유지** (드롭 시 자동 펼침으로 해결) |
| ERD 그래프 | 카디널리티 마커 · 엣지 3단계 압축 · 조인 경로 강조/디밍 · **뷰 기본 OFF** |
| 기존 진입점 | `ColumnPanel`·`ColumnCheckModal` 제거(빌더로 흡수). `TableDetail` 일괄검증은 유지 |
| 계층 용어 | UI에서 T1/T2/T3 제거. **백엔드 코드·문서의 계층 이름은 그대로 둔다** |

## 1. 조인 빌더

ERD 캔버스 하단 도크. 스텝이 없으면 접힌 한 줄, 첫 스텝이 생기면 펼쳐진다.

### 1.1 상태 모델

```ts
interface JoinColumnRef {
  objectId: number;
  qname: string;     // "ATM.T_ORDER"
  columnId: number;
  column: string;
}

interface JoinStep {
  left: JoinColumnRef;
  right: JoinColumnRef;
  joinType: "inner" | "left";   // 처방에 따라 사용자가 바꾼다
  status: "verifying" | "ready" | "no_data" | "failed";
  result: ContainmentResponse | null;
  verdict: JoinVerdict | null;
}

interface JoinDraft {
  steps: JoinStep[];
}
```

**연결성 규칙** — 첫 스텝의 `left` 테이블이 FROM이 된다. 두 번째 이후 스텝은
**이미 빌더에 들어온 테이블을 한쪽에 반드시 포함**해야 한다. 위반하는 드롭은
거부하고 이유를 띄운다(끊긴 조인은 곱집합이 되어 미리보기가 무의미해진다).

### 1.2 드래그 인터랙션

1. 컬럼 행에서 드래그 시작 → 즉시 `GET /api/columns/{id}/candidates` (T1, 기존 API)
2. 응답의 후보 컬럼을 캔버스 전체에서 **하이라이트**. `TableNode`의 `highlightColumns`
   prop과 `.erd-node__row--hl` 스타일이 이미 있으므로 데이터 소스만 바꾼다
3. **접힌 노드 위로 끌면 자동 펼침 + 첫 추천 컬럼으로 스크롤** — 노드 기본 접힘을
   유지하면서 드래그 조인을 성립시키는 장치
4. 드롭 → 스텝 추가 → `POST /api/validate/containment` 자동 실행 → 판정 렌더
5. **후보가 0개일 때만** 하이라이트 자리에 「숨은 짝 찾기」(T3 `POST /api/scan`,
   202+폴링) 노출. 완료되면 찾아낸 컬럼이 하이라이트로 합류한다

T3는 별도 블록이 아니라 *추천이 비었을 때의 보강 수단*으로만 등장한다.

### 1.3 노드 컬럼 목록

현재 `MAX_VISIBLE_COLUMNS = 24`에서 잘리고 "+N개 더"로 끝난다. 드래그 대상이 잘린
컬럼이면 조인 자체가 불가능하므로 절단을 폐기한다.

- 전체 컬럼 렌더 + **노드 최대높이 = 뷰포트 높이의 60%** + 내부 세로 스크롤
- 컬럼 수백 개 테이블은 `TableList`의 IntersectionObserver 청크 렌더 패턴을 재사용
- `layout.ts:estimateNodeSize`가 **같은 최대높이 상한을 적용**해 ELK에 넘긴다.
  적용하지 않으면 ELK가 실제보다 큰 노드를 가정해 배치가 벌어진다
- **엣지 앵커** — 스크롤로 뷰포트 밖에 나간 컬럼 행은 앵커 대상에서 제외하고
  헤더 핸들로 폴백한다. `resolveEdgeHandles`에 이미 폴백 경로가 있으므로
  `NodeAnchorInfo.visibleColumns`의 정의를 "표시 상한 이내"에서
  "스크롤 뷰포트 내 행"으로 바꾸면 로직 변경 없이 성립한다.
  노드 내부 스크롤 시 `updateNodeInternals(id)` 재호출

## 2. 판정 — 증상명 + 처방

`frontend/src/lib/join-verdict.ts` 순수 함수. T2 응답 + 후보 제외 사유를 받아
판정을 만든다. 단위 테스트 대상.

```ts
type VerdictLevel = "safe" | "caution" | "danger" | "unknown";
interface JoinVerdict { level: VerdictLevel; symptom: string; remedy: string | null; }
```

| 조건 | level | 증상 | 처방 |
|------|-------|------|------|
| 후보 `excluded` (저카디널리티 등) | danger | 값 종류가 너무 적어 우연히 맞을 수 있습니다 | 조인 키로 부적합 |
| `cardinality === "N:M"` | danger | 양쪽 다 중복 — 조인하면 행이 폭증합니다 | 중간 테이블이 필요합니다 |
| `containment === 1.0` (N:M 아님) | safe | 모든 행이 짝이 맞습니다 | — |
| `orphan_count > 0` | caution | 짝 없는 행 {n}건 — INNER로 묶으면 유실됩니다 | LEFT JOIN 권장 |
| `pattern === "small_sample_only"` | caution | 표본이 적어 우연일 수 있습니다 | 데이터가 쌓인 뒤 재검증 |
| 404 `no value data` | unknown | 값 데이터가 없어 검증할 수 없습니다 | — |

우선순위는 표 순서대로 평가한다(N:M이 containment 100%보다 우선).

**전체 판정** = 스텝 중 최악 level. `danger > caution > unknown > safe`.
"가장 약한 고리는 N번"으로 어느 스텝인지 지목한다.

**수치 보존** — `containment %`, `cardinality`, `orphan_count`, `confidence`,
`observations`, `pattern` 라벨, 관측 이력은 스텝별 `⌄ 수치 보기` 접힘 영역으로
그대로 옮긴다. 현재 `ColumnPanel` 결과 카드가 보여주는 정보는 하나도 잃지 않는다.

**LEFT JOIN 처방 적용** — 처방 문구 옆 버튼으로 해당 스텝의 `joinType`을 바꾼다.
`joinType`은 SQL 생성 요청에 그대로 실린다.

## 3. SQL과 미리보기

### 3.1 W2 워크플로 — 새 kind

`n8n/workflows/w2_query_executor.json`의 `Build query` 코드 노드에 `multi_join_preview`
분기를 추가한다. 요청 바디:

```json
{
  "kind": "multi_join_preview",
  "limit": 20,
  "steps": [
    { "left_schema": "ATM", "left_table": "T_ORDER", "left_column": "ORDER_ID",
      "right_schema": "ATM", "right_table": "T_ORDER_LOG", "right_column": "ORDER_ID",
      "join_type": "left" }
  ]
}
```

FROM은 첫 스텝의 left 테이블, 이후 각 스텝이 JOIN 한 줄이 된다. 식별자는 기존
`esc()` 브래킷 이스케이프를 그대로 쓰고, `join_type`은 `inner|left` 화이트리스트로
매핑한다 — **프리폼 SQL 조립 금지 원칙을 유지한다.**

### 3.2 실행 SQL 반환

`Build query`가 만든 `query` 문자열을 응답에 포함시킨다(`Run query` 뒤 Set 노드로
`{ rows, query }` 병합). 백엔드는 그대로 전달하고 화면은 **실제 돌아간 문장**을
표시한다. 프론트가 표시용 SQL을 따로 조립하면 보이는 문장과 실행 문장이 어긋나므로
조립처는 W2 한 곳으로 유지한다.

기존 `containment` / `join_preview` / `table_preview` kind도 같은 방식으로 `query`를
실어 보낸다(단일 Set 노드이므로 kind별 분기 불필요).

### 3.3 백엔드 — `POST /api/join/preview`

`app/api/join_preview.py` 신설. 책임:

- 조인 스펙 검증 — 스텝 ≥ 1, 연결성 규칙(각 스텝이 기존 테이블과 이어짐),
  스텝 상한(**8** — `join_check.py`의 기존 타깃 상한과 같은 값으로 맞춘다)
- `column_id` → `ColumnRef` 해석 (`resolve_column_ref` 재사용)
- 어댑터 호출 → `{ rows, query }`
- **컬럼 단위 마스킹 정책** 적용 (기존 `run_preview`와 동일 규칙, 전 스텝 컬럼 대상)
- `AuditLog(action="join_preview")` 기록
- `PREVIEW_LIMIT = 20` 서버 고정 — 클라이언트가 늘릴 수 없다

어댑터 인터페이스에 `multi_join_preview(steps, limit) -> tuple[list[dict], str]` 추가.
`N8nJoinValidator`가 구현하고, `FakeJoinValidator`는 명시 실패
(`SyntheticDataRefused` 관례 — 합성 조인 결과를 실값처럼 내보내지 않는다).

**SQL 보기는 무료가 아니다** — `query`는 실행 응답에 실려 오므로, SQL만 보려면
미리보기를 실행해야 한다. 대안(질의 없이 SQL만 받는 별도 kind)은 W2 왕복이
한 번 더 필요해 이득이 없으므로 채택하지 않는다. 버튼은 「SQL과 20행 보기」 하나로
합치고, 결과 패널에서 SQL 탭 / 행 탭을 전환한다.

## 4. ERD 그래프 개선

### 4.1 뷰 렌더 필터 (기본 OFF)

실규모는 테이블 2,342 / 뷰 882다. 뷰까지 그리면 그래프가 폭발한다.

- 캔버스 상단에 `테이블 / 뷰` 토글. **뷰는 기본 체크 해제**
- 뷰가 꺼지면 `view_lineage` 엣지도 함께 숨긴다
- "뷰 N개 숨김" 칩으로 되살릴 수 있게 한다 — 뷰를 통해서만 이어지던 경로가
  끊겨 보이는 부작용을 화면에서 드러내기 위함
- **표시 계층에서만** 필터한다. 그래프 응답과 `depth` 확장 결과는 그대로 두어
  뷰를 다시 켰을 때 재조회가 필요 없게 한다

### 4.2 카디널리티를 선에 표시

현재는 엣지 라벨에 `[N:M]` 텍스트를 붙이고, 1:N 등은 T2 결과 패널을 열어야 안다.

- 텍스트 라벨 제거 → **까그발(crow's foot) SVG 마커**로 양 끝 표기
- 마커 4종: 단일(`|`), 다중(까그발) 조합으로 `1:1`·`1:N`·`N:1`·`N:M`
- **미검증 엣지는 마커 없음** = "아직 모름"이 시각적으로 구분된다
- React Flow의 커스텀 `<marker>` defs로 구현, `edge-style.ts`에 마커 선택 함수 추가

### 4.3 엣지 인코딩 3단계 압축

현재 5종 kind × 3단계 투명도 = 사실상 구분 불가.

| 등급 | 시각 | 포함 kind |
|------|------|-----------|
| 확정 | 실선, 진한 색 | `fk`, `confirmed` |
| 추정 | 파선 | `inferred`, `ai_suggested` |
| 미검증 | 옅은 점선 | `unresolved` |

- `view_lineage`는 관계가 아니라 **계보**라 별도 축 — 뷰 필터가 기본 OFF이므로
  대부분 보이지 않는다. 뷰를 켰을 때만 회색 옅은 점선
- 근거가 FK인지 AI인지는 선이 아니라 **엣지 클릭 시** 표시
  (`edgeReason` 상태가 이미 있다). `✓`·`AI` 라벨 접두는 제거
- `confidenceOpacity` 3단계는 유지하되 **추정 등급 안에서만** 적용
- 범례 5줄 → 3줄, 접기 가능

### 4.4 조인 경로 강조 / 디밍

빌더에 들어간 노드·엣지만 불투명, 나머지는 `opacity 0.15`. 기존 `emphasis` 상태
메커니즘(`buildNodeEmphasis` / `buildEdgeEmphasis` / `displayNodes` / `displayEdges`)의
소스를 조인 드래프트로 확장하면 되고, 새 렌더 경로는 필요 없다.

## 5. 기존 진입점 통합

| 대상 | 처리 |
|------|------|
| `ColumnPanel` | **제거** — 후보목록·T2·미리보기·확정이 모두 빌더로 흡수된다 |
| `ColumnCheckModal` | **제거** — 브라우저의 컬럼 칩 클릭은 ERD 빌더로 직행 |
| `TableDetail` 조인검증 | **유지** — "이 테이블은 뭐랑 조인되나"를 답하는 발견 기능이라 빌더로 대체되지 않는다. 결과 행에 「빌더에 추가」를 달아 ERD로 넘긴다 |
| `/api/join-check` | 무변경 |

**딥링크 호환** — `/erd?col=&colName=&label=`은 "그 컬럼에서 드래그 대기 상태로
빌더 열기"로 매핑한다(추천 하이라이트가 이미 켜진 상태). 챗 칩·브라우저 칩의
기존 링크가 깨지지 않는다.

**`PATTERN_LABELS`** — `ColumnPanel`에서 export되어 `ColumnCheckModal`이 쓰고 있다.
`lib/join-verdict.ts`로 옮긴다.

### 용어 매핑 (UI만)

| 현재 | 변경 |
|------|------|
| `T2 검증` 버튼 | 사라짐 — 드롭 시 자동 실행 |
| `전수 탐색 (T3)` | **숨은 짝 찾기** |
| `후보` | **추천** |
| `containment` 수치 단독 노출 | 증상 문장 + 접힌 수치 |

백엔드 모듈명·독스트링·`docs/`의 T1/T2/T3는 계층 이름으로 그대로 둔다.

## 6. 구현 순서

각 단계는 독립적으로 랜딩 가능하다.

1. **ERD 그래프 개선** — 뷰 필터 · 엣지 3단계 · 카디널리티 마커 · 범례 축소.
   백엔드 무관, 즉시 착수 가능
2. **노드 컬럼 전체 렌더** — 최대높이 상한 · 내부 청크 스크롤 · `estimateNodeSize`
   상한 반영 · 앵커 폴백
3. **조인 빌더 (2테이블)** — 드래그 · 추천 하이라이트 · 자동 T2 · 증상+처방 ·
   기존 `/api/validate/preview`로 미리보기 · 경로 강조/디밍
4. **N-웨이 확장** — W2 `multi_join_preview` kind + 실행 SQL 반환 +
   `POST /api/join/preview`. **n8n 재배포가 전제**
5. **기존 진입점 통합** — `ColumnPanel`·`ColumnCheckModal` 제거 · 딥링크 매핑 ·
   용어 정리 · T3 재배치 · `TableDetail`에 「빌더에 추가」

## 7. 검증

| 대상 | 방법 |
|------|------|
| `join-verdict.ts` | 판정 표 6행 전수 단위 테스트 (vitest) |
| 연결성 규칙 | 끊긴 스텝 드롭 거부 단위 테스트 |
| `estimateNodeSize` 상한 | 컬럼 500개 노드가 상한 높이를 넘지 않음 (기존 `layout.test.ts` 확장) |
| 앵커 폴백 | 스크롤 밖 컬럼 → 헤더 핸들 (기존 `edge-anchors.test.ts` 확장) |
| 엣지 3단계 | `edge-style.test.ts` 확장 — kind → 등급 매핑 |
| `POST /api/join/preview` | 스펙 검증(스텝 0·끊김·상한 초과) · 마스킹 · 감사 로그 · Fake 명시 실패 (pytest) |
| W2 `multi_join_preview` | `Build query` 코드 노드 단위 — 스텝 N개 → SQL 문자열 스냅샷 |
| 전체 흐름 | 실서버 스모크 — 드래그 → 판정 → SQL/20행. n8n 재배포 후 |

## 8. 구현 시 주의

- **까그발 마커의 방향** — React Flow 엣지의 source→target 방향은 그래프 데이터에서
  오고 조인 스텝의 left/right와 항상 일치하지는 않는다. `edge-style.ts`에서
  카디널리티를 `{ sourceEnd, targetEnd }` 쌍으로 **정규화한 뒤** 마커를 고른다.
  엣지 방향이 뒤집힌 케이스를 단위 테스트에 넣는다
- **뷰 토글도 40노드 임계 모달을 탄다** — 뷰를 켜면 노드가 급증하므로 이웃 확장과
  같은 확인 절차를 적용한다(이미 초과 상태에선 재확인하지 않는 기존 규칙 유지)
