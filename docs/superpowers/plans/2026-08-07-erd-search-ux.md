# ERD·검색 UX 개선 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ERD 엣지(꺾은선·호버 컬럼 내비·라벨)·오버레이 배치(범례/맵 검색)·테이블 노드(더블클릭·한 줄 컬럼)·조인 검증 콤보박스·4단계 검색 랭킹 통일 — 프론트 전용 9건.

**Architecture:** 공통 랭킹은 순수 lib(`search-rank.ts`) 하나로 만들고 3개 소비처(브라우저·verify 콤보박스·ERD 맵 검색)가 공유한다. ERD 개선은 ErdViewer/TableNode/layout.ts 국소 수정 — 백엔드 무변경.

**Tech Stack:** Next.js 15 + React Flow(@xyflow/react) + elkjs + vitest.

**Spec:** `docs/superpowers/specs/2026-08-07-erd-search-ux-design.md`

## Global Constraints

- 프론트 전용 — 백엔드·API 변경 금지.
- 랭킹 4단계: ① 정확 ② 접두어 ③ 부분 포함 ④ 순서 유사(문자 순서대로 등장). 대소문자 무시, 동단계 내 이름 오름차순, 비매칭 제외.
- ERD 색 토큰(`--rel-*`)·design-app.md 시각 언어 유지 — 새 색 발명 금지.
- 인터랙티브 요소 `data-testid="ComponentName-role"` (`rules/frontend/identifiers.md`).
- TS strict·`any` 금지·named export·함수명 동사 시작. i18n 신규 문구는 ko/en 쌍.
- 검증 게이트: `cd frontend && npx tsc --noEmit && npx next lint && npx vitest run && npm run build`.
- 커밋: `type(scope): English summary — 한국어 요약`, 커밋 직전 PROGRESS.md 브랜치 항목 이어 붙이기.

---

### Task 1: lib/search-rank.ts — 4단계 랭킹

**Files:**
- Create: `frontend/src/lib/search-rank.ts`
- Test: `frontend/src/lib/search-rank.test.ts`

**Interfaces:**
- Produces: `getMatchRank(query: string, text: string): number` — 0 정확 / 1 접두어 / 2 포함 / 3 순서 유사 / `Infinity` 비매칭 (대소문자 무시, query 공백 trim).
- Produces: `rankSearchResults<T>(query: string, items: T[], getText: (item: T) => string): T[]` — 비매칭 제외, `(rank, getText 오름차순)` 정렬. 빈 query면 items 그대로.

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
import { describe, expect, it } from "vitest";

import { getMatchRank, rankSearchResults } from "./search-rank";

describe("getMatchRank", () => {
  it("orders exact > prefix > contains > subsequence", () => {
    expect(getMatchRank("HR_EMP", "HR_EMP")).toBe(0);
    expect(getMatchRank("HR_", "HR_EMP")).toBe(1);
    expect(getMatchRank("EMP", "HR_EMP")).toBe(2);
    expect(getMatchRank("HREMP", "HR_EMP")).toBe(3); // 순서 유사 — 문자가 순서대로 등장
  });

  it("is case-insensitive and rejects out-of-order letters", () => {
    expect(getMatchRank("hr_emp", "HR_EMP")).toBe(0);
    expect(getMatchRank("PME", "HR_EMP")).toBe(Infinity); // 역순은 비매칭
    expect(getMatchRank("HREMPX", "HR_EMP")).toBe(Infinity);
  });
});

describe("rankSearchResults", () => {
  const items = ["ORD_SO_HDR", "HR_EMP", "HR_EMP_HIST", "EMP_NO_MAP", "HREMP_LEGACY"];

  it("sorts by tier then name, dropping non-matches", () => {
    // HR_EMP는 HREMP_LEGACY와 비매칭 — '_' 뒤에 M이 다시 안 나옴 (순서 유사의 경계)
    expect(rankSearchResults("HR_EMP", items, (s) => s)).toEqual([
      "HR_EMP",        // 0 정확
      "HR_EMP_HIST",   // 1 접두어
    ]);
    expect(rankSearchResults("HREMP", items, (s) => s)).toEqual([
      "HREMP_LEGACY",  // 1 접두어
      "HR_EMP",        // 3 순서 유사
      "HR_EMP_HIST",   // 3 순서 유사 — 동단계 이름순
    ]);
  });

  it("keeps everything on an empty query", () => {
    expect(rankSearchResults("  ", items, (s) => s)).toEqual(items);
  });
});
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/lib/search-rank.test.ts` → FAIL (모듈 없음)
- [ ] **Step 3: 구현**

```typescript
/** 서비스 공통 검색 랭킹 — 정확 > 접두어 > 포함 > 순서 유사 (스펙 §검색 랭킹). */

export function getMatchRank(query: string, text: string): number {
  const q = query.trim().toUpperCase();
  const t = text.toUpperCase();
  if (q === "") return Infinity;
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (t.includes(q)) return 2;
  // 순서 유사: 검색어 문자가 대상에 순서대로 등장 (HREMP → HR_EMP)
  let cursor = 0;
  for (const ch of q) {
    cursor = t.indexOf(ch, cursor);
    if (cursor < 0) return Infinity;
    cursor += 1;
  }
  return 3;
}

export function rankSearchResults<T>(
  query: string, items: T[], getText: (item: T) => string,
): T[] {
  if (query.trim() === "") return items;
  return items
    .map((item) => ({ item, rank: getMatchRank(query, getText(item)) }))
    .filter((entry) => entry.rank !== Infinity)
    .sort((a, b) => a.rank - b.rank
      || getText(a.item).localeCompare(getText(b.item)))
    .map((entry) => entry.item);
}
```

- [ ] **Step 4: 통과 확인 + tsc** — vitest PASS, `npx tsc --noEmit` 클린
- [ ] **Step 5: 커밋** — `feat(search): add the shared 4-tier search ranking — 공통 4단계 검색 랭킹`

---

### Task 2: 브라우저 검색 정렬 통합

**Files:**
- Modify: `frontend/src/lib/search.ts` (SearchMatch에 rank 추가)
- Modify: `frontend/src/lib/search.test.ts`
- Modify: TableList의 검색 결과 정렬부 (`frontend/src/components/browser/TableList.tsx` — matchTable 소비처를 grep으로 확정)

**Interfaces:**
- Consumes: `getMatchRank`(Task 1).
- Produces: `SearchMatch.rank: number` — 이름 매칭은 `getMatchRank` 값(0~3), 컬럼 매칭 4, 카테고리 매칭 5, 빈 검색어 0. `matchTable`이 이름 부분 포함 실패 시에도 **순서 유사(rank 3)를 이름에 추가 시도**(nameRange는 null — 불연속 하이라이트는 미지원, 주석 명시).

- [ ] **Step 1: search.test.ts에 실패하는 테스트 추가** — 이름 정확/접두/포함/순서유사 rank 값, 컬럼 매칭 rank 4, 카테고리 rank 5, 기존 테스트(하이라이트 범위·초성)는 그대로 통과해야 함.
- [ ] **Step 2: 실패 확인** → **Step 3: 구현** (matchTable 각 리턴에 rank 부여 + 이름 순서 유사 분기 추가) → **Step 4: 통과 확인**
- [ ] **Step 5: TableList 정렬 적용** — 필터 통과 목록을 `(match.rank, name)` 정렬. 기존 표시(하이라이트·매칭 컬럼 배지) 유지.
- [ ] **Step 6: 게이트** — tsc·lint·vitest 전체.
- [ ] **Step 7: 커밋** — `feat(search): rank browser results exact-first — 브라우저 검색 정확 우선 정렬`

---

### Task 3: 조인 검증 콤보박스

**Files:**
- Rewrite: `frontend/src/components/verify/TablePickerPanel.tsx`
- Modify(필요 시): `frontend/src/app/verify/page.tsx` (props 변화 반영 최소화 — `side/selected/onSelect` 계약은 유지)

**Interfaces:**
- Consumes: `rankSearchResults`(Task 1), `fetchAllObjects`(api.ts 기존), `ObjectSummary`.
- Produces: 동일 props 계약의 콤보박스 — 외부 소비처 수정 불요가 목표.

구현 요지: 인풋 포커스/타이핑 시 드롭다운(최대 30건, `rankSearchResults`로 `schema.name` 대상 랭킹). 데이터는 `fetchAllObjects()` 결과를 **모듈 레벨 캐시**(use-hidden-schemas 훅의 기존 캐싱 패턴 참고)로 1회 로드, `type === "table"`만. 선택 시 인풋에 `schema.name` 표시 + 지우기(×) 버튼 → `onSelect(null)`. 키보드 ↑↓·Enter·Esc, 외부 클릭 닫기(AppHeader UserMenu의 outside-click 패턴 복제). testid 유지: `TablePickerPanel-searchInput-${side}`, `TablePickerPanel-item-${side}-${id}`, 신규 `TablePickerPanel-clearButton-${side}`.

- [ ] **Step 1: 구현** → **Step 2: 게이트(tsc·lint·vitest·build)** → **Step 3: 커밋** — `feat(verify): turn the table picker into a combobox — 테이블 선택을 검색 콤보박스로`

---

### Task 4: ERD 맵 검색 + 범례 이동

**Files:**
- Create: `frontend/src/components/erd/ErdSearch.tsx`
- Modify: `frontend/src/components/erd/ErdViewer.tsx`, `frontend/src/components/erd/Legend.tsx`, `frontend/src/lib/i18n.ts`

**Interfaces:**
- Consumes: `rankSearchResults`(Task 1), ErdViewer의 `centerOn`(x, y) — duration 300→500ms로 변경.
- Produces: `ErdSearch` props `{ nodes: GraphNode[], onPick(nodeId: number): void }`.

구현 요지: ErdSearch는 좌상단(`absolute left-3 top-3 z-10`) 인풋 — 타이핑 시 로드된 그래프 노드를 `schema.name`으로 랭킹해 드롭다운(최대 20건, 빈 결과 문구 `erd.searchEmpty`). 클릭 시 `onPick(id)` → ErdViewer가 해당 노드 `centerOn`(애니메이션) + focus 하이라이트(기존 focusId 하이라이트 상태를 로컬 state로 일반화 — `?focus=` 초기값 + 검색 픽으로 갱신). Legend는 `bottom-3 left-3` → `bottom-3 right-3` (Controls 좌하 가림 해소). i18n: `erd.searchPlaceholder`·`erd.searchEmpty` ko/en. testid: `ErdSearch-input`, `ErdSearch-item-${id}`.

- [ ] **Step 1: 구현** → **Step 2: 게이트** → **Step 3: 커밋** — `feat(erd): add the map search and move the legend — ERD 맵 검색 추가·범례 우하 이동`

---

### Task 5: 엣지 개선 + 테이블 노드

**Files:**
- Modify: `frontend/src/components/erd/ErdViewer.tsx`, `frontend/src/components/erd/TableNode.tsx`, `frontend/src/lib/layout.ts`, `frontend/src/lib/edge-style.ts`(기본 톤 감쇠 필요 시), `frontend/src/lib/i18n.ts`(문구 생기면)

구현 요지 (스펙 §1·§3):
1. **꺾은선**: 엣지 객체에 `type: "smoothstep"`. `layout.ts` ELK 옵션 추가 — `"elk.edgeRouting": "ORTHOGONAL"`, `"elk.spacing.edgeNode": "24"`, `"elk.spacing.edgeEdge": "12"` (기존 옵션 유지).
2. **호버**: `onEdgeMouseEnter` — ① 양쪽 노드 접힘 시 `expandedNodes`에 추가(펼침 유지) ② `highlightColumns`로 해당 컬럼 하이라이트(TableNode의 기존 scrollIntoView 로직이 스크롤 담당 — `justExpanded` 조건이 hover 케이스에도 동작하는지 확인, 안 되면 highlightColumns 변경 시에도 스크롤하게 보강) ③ hover 엣지 강조: strokeWidth+1·opacity 1, 나머지 엣지 opacity 0.25 ④ `EdgeLabelRenderer`로 엣지 중앙에 컬럼 페어 필 라벨(`src_column → tgt_column`, 다중 컬럼이면 첫 페어 + `+N`) — surface 배경·hairline 테두리·text-xs. `onEdgeMouseLeave` — 하이라이트·강조·라벨 해제, 펼침은 유지.
3. **TableNode**: 헤더 div `onDoubleClick={() => onToggleNode(node.id)}` (더블클릭 텍스트 선택 방지 `select-none` 헤더에 추가). 컬럼 행의 데이터 타입 span에 `shrink-0 whitespace-nowrap` — 컬럼명 쪽 `truncate` 유지로 행 한 줄 고정.
4. **색 톤**: 비호버 기본 상태 엣지 opacity를 GRADE_STYLE 값에서 유지하되, hover 세션 중 감쇠(0.25)와의 대비가 시각적으로 성립하는지만 확인 — 새 색 추가 금지.

- [ ] **Step 1: 구현** → **Step 2: 게이트(tsc·lint·vitest·build)** → **Step 3: 커밋** — `feat(erd): orthogonal edges with hover column navigation — 꺾은선 엣지·호버 컬럼 내비`

---

### Task 6: 최종 검증·문서

- [ ] **Step 1: 전체 게이트** — `npx tsc --noEmit && npx next lint && npx vitest run && npm run build` + 백엔드 스위트 1회(`cd backend && .venv/bin/python -m pytest -q`, 무변경 확인용).
- [ ] **Step 2: README 영향 확인** — `## 화면` 절의 ERD 서술이 이번 변경(맵 검색·호버)을 무효화하면 해당 문장만 갱신.
- [ ] **Step 3: PROGRESS 브랜치 항목 정리 + 커밋** — `docs: note the ERD/search UX pass — ERD·검색 UX 개선 기록`

## 실행 메모

- 브랜치: `feature/erd-search-ux` — superpowers:using-git-worktrees로 격리.
- Task 1 → 2·3·4는 순차(랭킹 lib 의존), 5는 4 이후(같은 파일 충돌 방지), 6 마지막.
- 스모크: 브라우저 확장 연결 시 컨트롤러가 수행, 미연결이면 게이트+API로 대체하고 보고에 명시.
