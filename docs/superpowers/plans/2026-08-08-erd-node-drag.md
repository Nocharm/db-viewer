# ERD 노드 드래그 + 헤더 호버 + 위치 초기화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 읽기 전용 ERD에서 헤더를 잡아 노드를 옮기고(재레이아웃에도 유지), 호버로 그립을 알리고, 버튼 한 번으로 자동 배치로 되돌린다.

**Architecture:** ELK 레이아웃 파이프라인은 무변경. 수동 좌표는 `movedRef`(Map)에 기록하고 ELK 배치 결과 위에 순수 함수 `applyManualPositions`로 덮어쓴다. 초기화는 마지막 순수 ELK 배치(`elkPlacedRef`)를 그대로 복원 — ELK 재실행 없음. 드래그 그립은 헤더 한정(`dragHandle`), 호버 효과(배경 틴트 + grab 커서)가 그립 위치를 가리킨다.

**Tech Stack:** Next.js / TypeScript, @xyflow/react 12 (ReactFlow), elkjs, vitest.

**Spec:** `docs/superpowers/specs/2026-08-08-erd-node-drag-design.md`

**Branch:** `feature/erd-node-drag` (Task 1 Step 0에서 생성. 워크트리 실행이면 superpowers:using-git-worktrees가 담당)

## Global Constraints

- 드래그 그립은 **헤더만** — 컬럼 행 클릭·스크롤·조인 핸들과 간섭 금지.
- `onNodesChange`는 **`type === "position"` 변경만** 적용 — dimension 변경을 적용하면 기존 `measured` 수동 관리(엣지 1프레임 언마운트 방지, ErdViewer.tsx 주석 참조)와 충돌한다.
- 새로 만드는 모든 노드 객체에 `measured`를 실어 보낸다 (기존 원칙 유지).
- 드래그·초기화가 ELK 재실행을 유발하면 안 된다 (수동 좌표는 ref, 초기화는 캐시 복원).
- 수동 위치는 세션 한정 — localStorage 금지.
- 초기화 시 카메라(뷰포트)는 건드리지 않는다.
- i18n 키는 ko/en 둘 다. `data-testid`는 `ComponentName-role` 형식.
- TypeScript strict, `any` 금지, 2-space, named export.
- 커밋 형식: `type(scope): English summary — 한국어 요약`. 각 커밋 전 PROGRESS.md의 "ERD 노드 드래그 구현" 항목을 갱신(첫 커밋이 생성, 이후 커밋은 같은 항목을 확장 — 중간 단계 나열 대신 요약 유지).

---

### Task 1: `applyManualPositions` 순수 함수 (lib + vitest)

**Files:**
- Modify: `frontend/src/lib/erd-graph.ts` (PlacedNode 인터페이스 + 함수 추가)
- Test: `frontend/src/lib/erd-graph.test.ts`

**Interfaces:**
- Consumes: 없음 (독립 순수 함수)
- Produces:
  ```ts
  export interface PlacedNode { x: number; y: number; width: number; height: number }
  export function applyManualPositions(
    placed: Map<number, PlacedNode>,
    moved: Map<number, { x: number; y: number }>,
  ): Map<number, PlacedNode>
  ```
  Task 3의 ErdViewer가 둘 다 임포트한다 (ErdViewer의 로컬 `PlacedNode` 인터페이스는 Task 3에서 이 export로 대체).

- [ ] **Step 0: 브랜치 생성**

```bash
cd /Users/hyeonjin/Documents/db-viewer
git checkout -b feature/erd-node-drag
```

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/src/lib/erd-graph.test.ts` 하단에 추가 (기존 임포트 줄에 `applyManualPositions`, `PlacedNode` 추가):

```ts
import { applyManualPositions, groupConnectedComponents, type PlacedNode } from "./erd-graph";
```

```ts
describe("applyManualPositions", () => {
  const makePlaced = (): Map<number, PlacedNode> => new Map([
    [1, { x: 0, y: 0, width: 260, height: 40 }],
    [2, { x: 300, y: 0, width: 260, height: 40 }],
  ]);

  it("overrides coordinates for moved nodes but keeps ELK sizes", () => {
    const merged = applyManualPositions(makePlaced(), new Map([[1, { x: 50, y: 80 }]]));

    expect(merged.get(1)).toEqual({ x: 50, y: 80, width: 260, height: 40 });
    expect(merged.get(2)).toEqual({ x: 300, y: 0, width: 260, height: 40 }); // 미이동 노드 그대로
  });

  it("ignores moved ids that are absent from the placement", () => {
    const merged = applyManualPositions(makePlaced(), new Map([[999, { x: 1, y: 2 }]]));

    expect(merged.size).toBe(2);
    expect(merged.has(999)).toBe(false);
  });

  it("returns a new Map and leaves inputs untouched", () => {
    const placed = makePlaced();
    const merged = applyManualPositions(placed, new Map([[1, { x: 50, y: 80 }]]));

    expect(merged).not.toBe(placed);
    expect(placed.get(1)).toEqual({ x: 0, y: 0, width: 260, height: 40 });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/lib/erd-graph.test.ts`
Expected: FAIL — `applyManualPositions`/`PlacedNode` export 없음.

- [ ] **Step 3: 최소 구현**

`frontend/src/lib/erd-graph.ts` 하단에 추가 (모듈 docstring은 "연결요소 그룹핑 + 수동 배치 병합 — 클러스터 정렬·좌표 순수 로직"으로 갱신):

```ts
/** ELK 배치 좌표 + 추정 크기 — ErdViewer의 배치 기록 단위 */
export interface PlacedNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** ELK 배치 결과에 수동 이동 좌표를 덮어쓴다 — 크기는 ELK 측정값 유지.
 * 그래프에서 사라진 노드의 수동 좌표는 무시한다. */
export function applyManualPositions(
  placed: Map<number, PlacedNode>,
  moved: Map<number, { x: number; y: number }>,
): Map<number, PlacedNode> {
  const merged = new Map(placed);
  for (const [id, position] of moved) {
    const base = merged.get(id);
    if (!base) continue;
    merged.set(id, { ...base, x: position.x, y: position.y });
  }
  return merged;
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/lib/erd-graph.test.ts`
Expected: PASS (기존 groupConnectedComponents 3건 포함 전체 green)

- [ ] **Step 5: 커밋** (PROGRESS.md "ERD 노드 드래그 구현" 항목 생성 포함)

```bash
git add frontend/src/lib/erd-graph.ts frontend/src/lib/erd-graph.test.ts PROGRESS.md
git commit -m "feat(erd): add applyManualPositions merge helper — 수동 배치 병합 순수 함수"
```

---

### Task 2: 헤더 호버 효과 + grab 커서 (CSS)

**Files:**
- Modify: `frontend/src/app/globals.css` (`.react-flow .erd-node__header` 블록 — 600행 부근)

**Interfaces:**
- Consumes: 없음
- Produces: `.react-flow__node.dragging` 상태 커서 — Task 3이 드래그를 켜면 React Flow가 이 클래스를 자동 부여한다.

- [ ] **Step 1: CSS 수정**

현재 블록:

```css
.react-flow .erd-node__header {
  cursor: pointer;
}
```

다음으로 교체:

```css
/* 헤더 = 드래그 그립 — grab 커서·호버 틴트가 "여기를 잡으면 움직인다"를 알린다.
   틴트는 컬럼 행 호버(hover:bg-black/5)와 같은 계열 / grab affordance for the drag handle */
.react-flow .erd-node__header {
  cursor: grab;
  transition: background-color 0.15s ease-in-out;
}
.react-flow .erd-node__header:hover {
  background-color: rgba(0, 0, 0, 0.05);
}
.react-flow__node.dragging .erd-node__header {
  cursor: grabbing;
}
```

- [ ] **Step 2: 빌드 무결성 확인**

Run: `cd frontend && npx tsc --noEmit && npm run lint`
Expected: 통과 (CSS는 tsc 대상이 아니지만 리그레션 없음 확인). 시각 확인은 Task 5.

- [ ] **Step 3: 커밋** (PROGRESS.md 항목 확장 포함)

```bash
git add frontend/src/app/globals.css PROGRESS.md
git commit -m "feat(erd): add grab cursor and hover tint to node header — 헤더 그립 어포던스"
```

---

### Task 3: 헤더 드래그 이동 (ErdViewer 배선)

**Files:**
- Modify: `frontend/src/components/erd/ErdViewer.tsx`

**Interfaces:**
- Consumes: Task 1의 `applyManualPositions`, `PlacedNode` (from `@/lib/erd-graph`)
- Produces: `movedRef`, `movedCount`, `elkPlacedRef` — Task 4의 초기화 버튼이 사용. `handleNodeDragStop`이 `movedRef`·`placedRef`를 갱신한다.

- [ ] **Step 1: 임포트·타입 교체**

`@xyflow/react` 임포트에 `applyNodeChanges` 추가, `Edge` 타입 옆에 `NodeChange` 추가:

```ts
import {
  applyNodeChanges, Background, Controls, ReactFlow, ReactFlowProvider, useReactFlow,
} from "@xyflow/react";
import type { Edge, NodeChange } from "@xyflow/react";
```

`groupConnectedComponents` 임포트를 확장하고, ErdViewer.tsx의 **로컬 `PlacedNode` 인터페이스(52-57행)를 삭제**:

```ts
import { applyManualPositions, groupConnectedComponents, type PlacedNode } from "@/lib/erd-graph";
```

- [ ] **Step 2: state·ref 추가**

`ErdViewerInner`의 기존 `placedRef` 선언 아래에:

```ts
// 수동 이동 좌표 — ref인 이유: 레이아웃 이펙트 deps에 들어가면 드래그마다 ELK가 재실행된다
// (호버가 레이아웃을 안 흔드는 것과 같은 원칙) / manual positions live in a ref so
// dragging never re-triggers ELK
const movedRef = useRef<Map<number, { x: number; y: number }>>(new Map());
// 초기화 버튼 활성 판정 전용 — ELK와 무관한 가벼운 리렌더만 유발
const [movedCount, setMovedCount] = useState(0);
// 마지막 순수 ELK 배치 — 위치 초기화가 ELK 재실행 없이 이걸 그대로 복원한다
const elkPlacedRef = useRef<Map<number, PlacedNode>>(new Map());
```

- [ ] **Step 3: 드래그 핸들러 추가**

`handleEdgeMouseLeave` 아래에:

```ts
// 드래그 중 position 변경만 반영 — dimension 변경까지 적용하면 measured 수동 관리와
// 충돌한다(위 displayNodes 주석 참조) / apply position changes only; dimension changes
// would fight our manual `measured` bookkeeping
const handleNodesChange = useCallback((changes: NodeChange<TableFlowNode>[]) => {
  const positionChanges = changes.filter((c) => c.type === "position");
  if (positionChanges.length === 0) return;
  setFlowNodes((nodes) => applyNodeChanges(positionChanges, nodes));
}, []);

const handleNodeDragStop = useCallback((_event: unknown, node: TableFlowNode) => {
  const id = Number(node.id);
  movedRef.current.set(id, { x: node.position.x, y: node.position.y });
  setMovedCount(movedRef.current.size);
  // 검색 픽 센터링(placedRef 기반)이 옮긴 위치를 조준하도록 배치 기록도 갱신
  const placedEntry = placedRef.current.get(id);
  if (placedEntry) {
    placedRef.current.set(id, { ...placedEntry, x: node.position.x, y: node.position.y });
  }
}, []);
```

- [ ] **Step 4: 레이아웃 이펙트에 병합 적용**

레이아웃 이펙트의 `.then((placed) => {` 콜백 시작부를 다음으로 교체 (파라미터명을 `elkPlaced`로 바꾸고 병합 추가):

```ts
void layoutGroups(groups, graph.edges, expandedNodes).then((elkPlaced) => {
  if (cancelled) return;
  elkPlacedRef.current = elkPlaced;
  // 수동 이동 좌표를 ELK 결과 위에 덮어쓴다 — 재레이아웃(펼침/접힘)에도 배치가 유지된다
  const placed = applyManualPositions(elkPlaced, movedRef.current);
  placedRef.current = placed;
```

이후 콜백 본문의 `placed` 사용처(setFlowNodes의 `placed.get(...)`, post-layout 센터링의 `placed.get(...)`)는 병합본을 그대로 쓰므로 변경 없음. 이펙트 deps도 변경 없음.

- [ ] **Step 5: 노드 객체에 dragHandle 지정**

레이아웃 이펙트의 `setFlowNodes(graph.nodes.map((n) => {` 내부 반환 객체에서 `type: "tableNode" as const,` 다음 줄에 추가:

```ts
// 헤더만 드래그 그립 — 컬럼 행 클릭·스크롤·조인 핸들과 간섭하지 않는다
dragHandle: ".erd-node__header",
```

- [ ] **Step 6: ReactFlow prop 배선**

`<ReactFlow>`에서 `nodesDraggable={false}` 줄을 **삭제**(기본 true)하고, `nodesConnectable={false}` 아래에 추가:

```tsx
onNodesChange={handleNodesChange}
onNodeDragStop={handleNodeDragStop}
```

- [ ] **Step 7: 전체 검증**

Run: `cd frontend && npx tsc --noEmit && npm run lint && npm test -- --run`
Expected: tsc·lint 통과, vitest 전체 green (드래그 자체는 Task 5 브라우저 실측)

- [ ] **Step 8: 커밋** (PROGRESS.md 항목 확장 포함)

```bash
git add frontend/src/components/erd/ErdViewer.tsx PROGRESS.md
git commit -m "feat(erd): enable header-grip node dragging — 헤더 드래그로 노드 이동"
```

---

### Task 4: 위치 초기화 버튼 (아이콘 + i18n + ControlButton) + 문서 동기화

**Files:**
- Modify: `frontend/src/components/icons.tsx` (ResetIcon 추가)
- Modify: `frontend/src/lib/i18n.ts` (`erd.resetPositions` 키)
- Modify: `frontend/src/components/erd/ErdViewer.tsx` (ControlButton + 핸들러)
- Modify: `frontend/src/app/globals.css` (controls 버튼 disabled 상태)
- Modify: `README.md` (`/erd` 화면 설명 한 줄)
- Modify: `docs/superpowers/specs/2026-08-08-erd-node-drag-design.md` (초기화 메커니즘 한 줄 현행화)

**Interfaces:**
- Consumes: Task 3의 `movedRef`, `movedCount`, `setMovedCount`, `elkPlacedRef`, `placedRef`
- Produces: `data-testid="ErdViewer-resetPositionsButton"` (Task 5 실측·향후 테스트가 참조)

- [ ] **Step 1: ResetIcon 추가**

`frontend/src/components/icons.tsx`의 `CaretRightIcon` 아래에 (기존 24 뷰박스·stroke 규격):

```tsx
export function ResetIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </Svg>
  );
}
```

- [ ] **Step 2: i18n 키 추가**

`frontend/src/lib/i18n.ts`의 `"erd.expandNeighbors"` 줄 아래에:

```ts
"erd.resetPositions": { ko: "노드 위치 초기화", en: "Reset node positions" },
```

- [ ] **Step 3: 초기화 핸들러 + ControlButton**

`ErdViewer.tsx` — `@xyflow/react` 임포트에 `ControlButton` 추가, `@/components/icons` 임포트에 `ResetIcon` 추가.

`handleNodeDragStop` 아래에 핸들러:

```ts
// 마지막 순수 ELK 배치를 그대로 복원 — ELK 재실행 없이 즉시, 카메라는 건드리지 않는다
// restore the cached pure-ELK placement; no ELK rerun, viewport untouched
const handleResetPositions = useCallback(() => {
  if (movedRef.current.size === 0) return;
  movedRef.current.clear();
  setMovedCount(0);
  const elkPlaced = elkPlacedRef.current;
  placedRef.current = elkPlaced;
  setFlowNodes((nodes) => nodes.map((n) => {
    const base = elkPlaced.get(Number(n.id));
    return base ? { ...n, position: { x: base.x, y: base.y } } : n;
  }));
}, []);
```

`<Controls />`를 다음으로 교체:

```tsx
<Controls>
  <ControlButton
    onClick={handleResetPositions}
    disabled={movedCount === 0}
    title={t("erd.resetPositions")}
    aria-label={t("erd.resetPositions")}
    data-testid="ErdViewer-resetPositionsButton"
  >
    <ResetIcon size={12} />
  </ControlButton>
</Controls>
```

- [ ] **Step 4: disabled 상태 CSS**

`frontend/src/app/globals.css`의 `.react-flow .erd-node__header` 블록 아래에:

```css
/* 초기화 버튼 비활성 — 프로젝트 disabled 관례(0.35)와 동일 톤 */
.react-flow__controls-button:disabled {
  opacity: 0.35;
  cursor: default;
}
```

- [ ] **Step 5: README `/erd` 설명 갱신**

README.md의 `/erd` 항목에서 "테이블 검색과 호버 컬럼 내비게이션을 제공하며" 를 다음으로 확장:

```
테이블 검색과 호버 컬럼 내비게이션을 제공하고, 노드는 헤더를 잡아 옮길 수 있다(세션 한정 —
좌하단 컨트롤의 초기화 버튼이 자동 배치로 되돌림).
```

- [ ] **Step 6: 스펙 현행화**

`docs/superpowers/specs/2026-08-08-erd-node-drag-design.md`의 "### 3. 위치 초기화" 중 `layoutVersion` state 범프 문장을 다음으로 교체 (구현 중 단순화 — 결과 동일):

```
- 클릭 → `movedRef` 클리어 + `movedCount` 0 + 마지막 순수 ELK 배치 캐시(`elkPlacedRef`)를
  그대로 복원(`setFlowNodes` 좌표 재적용). ELK 재실행·이펙트 deps 변경 없이 즉시 복원되며,
  카메라는 건드리지 않는다.
```

- [ ] **Step 7: 전체 검증**

Run: `cd frontend && npx tsc --noEmit && npm run lint && npm test -- --run`
Expected: 전부 통과

- [ ] **Step 8: 커밋** (PROGRESS.md 항목 확장 포함)

```bash
git add frontend/src/components/icons.tsx frontend/src/lib/i18n.ts \
  frontend/src/components/erd/ErdViewer.tsx frontend/src/app/globals.css \
  README.md docs/superpowers/specs/2026-08-08-erd-node-drag-design.md PROGRESS.md
git commit -m "feat(erd): add reset-positions control button — 위치 초기화 버튼"
```

---

### Task 5: 브라우저 실측 검증

**Files:** 없음 (검증 전용 — 발견된 결함은 이 태스크 안에서 수정·커밋)

**Interfaces:**
- Consumes: Task 1–4 전체 결과물, `data-testid="ErdViewer-resetPositionsButton"`, `ErdNode-header-*`

- [ ] **Step 1: 로컬 서버 기동** (docs/ui-review.md 절차 — SQLite 픽스처)

```bash
cd backend
DATABASE_URL=sqlite:////tmp/dbviewer-ui.db .venv/bin/alembic upgrade head
DATABASE_URL=sqlite:////tmp/dbviewer-ui.db .venv/bin/uvicorn app.main:app --port 8000  # 백그라운드
cd frontend && npm run dev  # 백그라운드
# 픽스처가 비어 있으면: python3 tools/seed_ui_states.py --base http://localhost:8000
```

- [ ] **Step 2: 실측 체크리스트** (http://localhost:3000/erd — `HR_EMP` 검색으로 히어로 화면 진입)

1. 헤더 호버 → 배경 틴트 + `grab` 커서 (컬럼 행 호버와 구분되는지)
2. 헤더 드래그 → 노드 이동, 드래그 중 `grabbing` 커서, 엣지가 따라오는지
3. 펼친 노드의 컬럼 영역 드래그 → 노드가 **안 움직이고** 스크롤·클릭만 동작 (그립 격리)
4. 노드 옮긴 뒤 다른 노드 펼침/접힘 → 옮긴 위치 유지 (오버라이드 맵)
5. 검색으로 옮긴 노드 재선택 → 옮긴 위치로 센터링 (placedRef 갱신)
6. 초기화 버튼: 이동 전 disabled(0.35 톤) → 이동 후 활성 → 클릭 시 자동 배치 복원 + 카메라 유지 + 버튼 재비활성
7. 초기화 후 펼침/접힘 → 정상 재레이아웃 (잔존 수동 좌표 없음)

- [ ] **Step 3: 서버 정리 + 최종 스위트**

Run: `cd frontend && npx tsc --noEmit && npm run lint && npm test -- --run`
Expected: 전부 통과. 발견 결함이 있었으면 수정 커밋 후 재실측.

- [ ] **Step 4: 머지 결정**

superpowers:finishing-a-development-branch 스킬로 진행 (머지 시 PROGRESS.md 브랜치 항목을 요약 1건으로 압축 — `rules/common/git.md` On Branch Merge).
