# ERD 조인 빌더 + 그래프 가독성 개선 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ERD 캔버스에서 컬럼을 드래그해 2~N 테이블 조인을 만들고, 유효성 판정을 문장으로 받고, 실행 SQL과 샘플 20행을 확인하는 흐름으로 기존 T2/T3 검증 UI를 대체한다.

**Architecture:** 프론트는 순수 로직(판정·드래프트 상태·엣지 시각)을 `lib/`의 테스트 가능한 모듈로 분리하고 컴포넌트는 렌더만 맡는다. SQL은 n8n W2 워크플로에서만 조립되며 실행 결과에 실행문을 실어 되돌려준다 — 백엔드·프론트 어디에서도 SQL을 만들지 않는다. W2 JSON은 `tools/build_n8n_workflow.py`가 생성하므로 **JSON을 직접 편집하지 않는다**(테스트가 커밋본 == 재생성본을 강제한다).

**Tech Stack:** Next.js 15 / React 19 / @xyflow/react / elkjs / Tailwind v4 / vitest — FastAPI / SQLAlchemy 2.0 / pytest — n8n (W2 webhook)

## Global Constraints

- **스펙:** `docs/superpowers/specs/2026-08-05-erd-join-builder-design.md`
- **SQL 조립처는 W2 한 곳.** 프론트·백엔드에서 SQL 문자열을 만들지 않는다. W2 안에서도 식별자는 `esc()` 브래킷 이스케이프, 리터럴은 `lit()` — 프리폼 SQL 금지.
- **W2 JSON은 생성물.** `tools/build_n8n_workflow.py`를 고치고 `python3 tools/build_n8n_workflow.py`로 재생성한다. `backend/tests/test_n8n_workflow.py`가 드리프트를 막는다.
- **`PREVIEW_LIMIT = 20` 서버 고정.** 클라이언트가 늘릴 수 없다.
- **조인 스텝 상한 8** — `backend/app/api/join_check.py:21`의 `BATCH_TARGET_LIMIT = 8`과 같은 값.
- **미리보기는 원본 값이 나가는 유일한 지점** — 컬럼 단위 마스킹(`●●●`) + `AuditLog` 필수, 무캐시.
- **합성 데이터 금지** — `FakeJoinValidator`의 신규 메서드는 명시 실패(`NotImplementedError`). 합성 조인 결과를 실값처럼 내보내지 않는다.
- **백엔드 T1/T2/T3 계층 이름은 유지.** UI 문구에서만 제거한다.
- **UI 문자열은 `lib/i18n.ts` 사전 경유** — ko/en 양쪽 필수.
- **`data-testid`는 `ComponentName-role`** (`rules/frontend/identifiers.md`).
- **커밋 메시지:** `type(scope): English summary — 한국어 요약`. 커밋 직전 `PROGRESS.md` 갱신(`rules/common/git.md`).
- **검증 명령 (경로는 저장소 루트 기준, 반드시 이대로):**
  - 프론트: `cd frontend && npx vitest run` · `npx tsc --noEmit` · `npx eslint src`
  - 백엔드: `cd backend && .venv/bin/python -m pytest` · `.venv/bin/python -m ruff check .`
  - **`python3 -m pytest`는 동작하지 않는다** — 의존성이 `backend/.venv`에만 있다.
    계획 본문의 `python3 -m pytest`·`ruff check`는 모두 위 형태로 읽는다.
- **Baseline (2026-08-05, feat/erd-join-builder 분기 시점):** 프론트 37 passed / 9 files,
  백엔드 266 passed. 태스크가 끝날 때 이 수보다 줄면 회귀다.

---

# Phase 1 — ERD 그래프 가독성 (백엔드 무관)

## Task 1: 엣지 인코딩 3단계 압축

**Files:**
- Modify: `frontend/src/lib/edge-style.ts`
- Test: `frontend/src/lib/edge-style.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `EdgeGrade`, `getEdgeGrade(kind: EdgeKind): EdgeGrade`, `getEdgeVisual(kind, confidence?)` (시그니처 유지, 반환값 변경)

현재는 5종 kind마다 색·대시가 달라 사실상 구분이 안 된다. **확정 / 추정 / 미검증** 3등급으로 압축하고, 근거(FK인지 AI인지)는 엣지 클릭 시 표시하는 `edgeReason`에 맡긴다.

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/src/lib/edge-style.test.ts`의 기존 `describe("getEdgeVisual")` 블록 전체를 아래로 교체한다.

```ts
import { describe, expect, it } from "vitest";

import { confidenceOpacity, getEdgeGrade, getEdgeVisual } from "./edge-style";

describe("getEdgeGrade", () => {
  it("collapses five kinds into three grades", () => {
    expect(getEdgeGrade("fk")).toBe("confirmed");
    expect(getEdgeGrade("confirmed")).toBe("confirmed");
    expect(getEdgeGrade("inferred")).toBe("inferred");
    expect(getEdgeGrade("ai_suggested")).toBe("inferred");
    expect(getEdgeGrade("unresolved")).toBe("unresolved");
  });

  it("keeps view_lineage on its own axis — it is provenance, not a relation", () => {
    expect(getEdgeGrade("view_lineage")).toBe("lineage");
  });
});

describe("getEdgeVisual", () => {
  it("draws confirmed grades solid and inferred grades dashed", () => {
    expect(getEdgeVisual("fk")).toMatchObject({
      stroke: "var(--rel-confirmed)", strokeDasharray: undefined, opacity: 1,
    });
    expect(getEdgeVisual("confirmed").strokeDasharray).toBeUndefined();
    expect(getEdgeVisual("inferred").strokeDasharray).toBe("8 4");
    // AI 제안도 추정 등급 — 같은 파선으로 합류 / ai_suggested joins the inferred grade
    expect(getEdgeVisual("ai_suggested").strokeDasharray).toBe("8 4");
    expect(getEdgeVisual("ai_suggested").stroke).toBe("var(--rel-inferred)");
  });

  it("draws unresolved faint and dotted", () => {
    expect(getEdgeVisual("unresolved")).toMatchObject({
      stroke: "var(--rel-unresolved)", strokeDasharray: "2 4",
    });
    expect(getEdgeVisual("unresolved").opacity).toBeLessThan(1);
  });

  it("keeps view_lineage grey and faint", () => {
    expect(getEdgeVisual("view_lineage").stroke).toBe("var(--rel-lineage)");
    expect(getEdgeVisual("view_lineage").strokeDasharray).toBe("1.5 4");
  });

  it("uses 2px strokes everywhere", () => {
    for (const kind of
      ["fk", "confirmed", "inferred", "ai_suggested", "view_lineage", "unresolved"] as const) {
      expect(getEdgeVisual(kind).strokeWidth).toBe(2);
    }
  });

  it("applies stepped confidence opacity only inside the inferred grade", () => {
    expect(getEdgeVisual("inferred", 0.999).opacity).toBe(1.0);
    expect(getEdgeVisual("inferred", 0.96).opacity).toBe(0.7);
    expect(getEdgeVisual("inferred", 0.5).opacity).toBe(0.45);
    expect(getEdgeVisual("ai_suggested", 0.5).opacity).toBe(0.45);
    // 확정 등급은 confidence로 흐려지지 않는다 / confirmed never fades
    expect(getEdgeVisual("fk", 0.5).opacity).toBe(1.0);
    expect(getEdgeVisual("confirmed", 0.5).opacity).toBe(1.0);
  });
});

describe("confidenceOpacity", () => {
  it("steps at 0.99 and 0.95", () => {
    expect(confidenceOpacity(1.0)).toBe(1.0);
    expect(confidenceOpacity(0.95)).toBe(0.7);
    expect(confidenceOpacity(0.94)).toBe(0.45);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/lib/edge-style.test.ts`
Expected: FAIL — `getEdgeGrade is not a function`

- [ ] **Step 3: 구현**

`frontend/src/lib/edge-style.ts` 전체를 교체한다.

```ts
/** 엣지 시각 언어 — 3등급 압축(확정/추정/미검증) + 계보 별도 축.
 * Five kinds collapse into three grades; provenance keeps its own axis. */

export type EdgeKind =
  | "fk"
  | "confirmed"
  | "inferred"
  | "ai_suggested"
  | "view_lineage"
  | "unresolved";

/** 사용자가 구분해야 하는 축은 "얼마나 믿을 수 있나" 하나뿐 — 근거는 클릭 시 표시.
 * The only axis a reader needs is trust level; provenance shows on click. */
export type EdgeGrade = "confirmed" | "inferred" | "unresolved" | "lineage";

export interface EdgeVisual {
  stroke: string;
  strokeWidth: number;
  strokeDasharray?: string;
  opacity: number;
}

const GRADE: Record<EdgeKind, EdgeGrade> = {
  fk: "confirmed",
  confirmed: "confirmed",
  inferred: "inferred",
  ai_suggested: "inferred",
  unresolved: "unresolved",
  view_lineage: "lineage",
};

export function getEdgeGrade(kind: EdgeKind): EdgeGrade {
  return GRADE[kind];
}

/** confidence 3단계 스텝 — 연속 투명도는 비교 불가 (design-app.md) */
export function confidenceOpacity(confidence: number): number {
  if (confidence >= 0.99) return 1.0;
  if (confidence >= 0.95) return 0.7;
  return 0.45;
}

const GRADE_STYLE: Record<EdgeGrade, { stroke: string; dash?: string; opacity: number }> = {
  confirmed: { stroke: "var(--rel-confirmed)", opacity: 1.0 },
  inferred: { stroke: "var(--rel-inferred)", dash: "8 4", opacity: 1.0 },
  unresolved: { stroke: "var(--rel-unresolved)", dash: "2 4", opacity: 0.5 },
  lineage: { stroke: "var(--rel-lineage)", dash: "1.5 4", opacity: 0.5 },
};

export function getEdgeVisual(kind: EdgeKind, confidence?: number): EdgeVisual {
  const grade = getEdgeGrade(kind);
  const style = GRADE_STYLE[grade];
  return {
    stroke: style.stroke,
    strokeWidth: 2,
    strokeDasharray: style.dash,
    // 추정 등급 안에서만 confidence로 단계 구분 / confidence steps within the inferred grade
    opacity: grade === "inferred" && confidence !== undefined
      ? confidenceOpacity(confidence)
      : style.opacity,
  };
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/lib/edge-style.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/lib/edge-style.ts frontend/src/lib/edge-style.test.ts
git commit -m "refactor(erd): collapse edge kinds into three trust grades — 엣지 인코딩 3단계 압축"
```

---

## Task 2: 카디널리티 까그발 마커

**Files:**
- Modify: `frontend/src/lib/edge-style.ts`
- Create: `frontend/src/components/erd/CardinalityMarkers.tsx`
- Test: `frontend/src/lib/edge-style.test.ts`

**Interfaces:**
- Consumes: Task 1의 `getEdgeGrade`
- Produces: `CardinalityEnds`, `getCardinalityEnds(cardinality: string | null | undefined): CardinalityEnds`, `MARKER_ID`, `<CardinalityMarkerDefs />`

현재는 엣지 라벨에 `[N:M]` 텍스트를 붙이고 1:N 등은 검증 패널을 열어야 안다. 까그발 마커로 선 자체에 그린다. **미검증(cardinality 없음)은 마커 없음** = "아직 모름"이 시각적으로 구분된다.

**방향 불변식:** `ErdCanvas`는 항상 `source = String(e.src_object_id)`, `target = String(e.tgt_object_id)`로 엣지를 만들고(`ErdCanvas.tsx:349-350`), 백엔드 `cardinality`도 `src:tgt` 순서다. 따라서 별도 정규화 계층은 불필요하다 — 대신 이 불변식을 Step 1 테스트로 잠근다.

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/src/lib/edge-style.test.ts` 파일 끝에 추가한다.

```ts
import { getCardinalityEnds } from "./edge-style";

describe("getCardinalityEnds", () => {
  it("maps cardinality strings to crow's-foot ends in src:tgt order", () => {
    // 문자열은 항상 src:tgt 순서 — ErdCanvas가 source=src_object_id로 엣지를 만든다
    expect(getCardinalityEnds("1:N")).toEqual({ source: "one", target: "many" });
    expect(getCardinalityEnds("N:1")).toEqual({ source: "many", target: "one" });
    expect(getCardinalityEnds("N:M")).toEqual({ source: "many", target: "many" });
    expect(getCardinalityEnds("1:1")).toEqual({ source: "one", target: "one" });
  });

  it("draws nothing when cardinality is unknown — absence means unverified", () => {
    expect(getCardinalityEnds(null)).toEqual({ source: null, target: null });
    expect(getCardinalityEnds(undefined)).toEqual({ source: null, target: null });
    expect(getCardinalityEnds("")).toEqual({ source: null, target: null });
    expect(getCardinalityEnds("garbage")).toEqual({ source: null, target: null });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/lib/edge-style.test.ts`
Expected: FAIL — `getCardinalityEnds is not a function`

- [ ] **Step 3: 구현 — 순수 함수**

`frontend/src/lib/edge-style.ts` 끝에 추가한다.

```ts
/** 까그발 표기 한쪽 끝 / one end of a crow's-foot notation. */
export type CardinalityEnd = "one" | "many" | null;

export interface CardinalityEnds {
  source: CardinalityEnd;
  target: CardinalityEnd;
}

/** React Flow 마커 element id — CardinalityMarkerDefs가 defs로 심는다. */
export const MARKER_ID: Record<"one" | "many", string> = {
  one: "dbv-card-one",
  many: "dbv-card-many",
};

function parseEnd(token: string): CardinalityEnd {
  if (token === "1") return "one";
  if (token === "N" || token === "M") return "many";
  return null;
}

/** "1:N" → {source:"one", target:"many"}. 미검증(null·미인식)은 양끝 null.
 * The string is always src:tgt, matching how ErdCanvas orders edge endpoints. */
export function getCardinalityEnds(
  cardinality: string | null | undefined,
): CardinalityEnds {
  const parts = (cardinality ?? "").split(":");
  if (parts.length !== 2) return { source: null, target: null };
  const source = parseEnd(parts[0]);
  const target = parseEnd(parts[1]);
  if (source === null || target === null) return { source: null, target: null };
  return { source, target };
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/lib/edge-style.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: 마커 defs 컴포넌트 생성**

`frontend/src/components/erd/CardinalityMarkers.tsx` 신규 생성.

```tsx
/** 까그발 마커 defs — 캔버스에 한 번만 심고 엣지가 url(#id)로 참조한다.
 * Crow's-foot marker defs, mounted once and referenced by edges. */

import { MARKER_ID } from "@/lib/edge-style";

/** 마커 좌표계: refX=10이 선 끝, 표기는 선 끝에서 안쪽으로 그린다. */
export function CardinalityMarkerDefs() {
  return (
    <svg
      className="pointer-events-none absolute h-0 w-0"
      aria-hidden="true"
      data-testid="ErdCanvas-cardinalityMarkers"
    >
      <defs>
        {/* 단일 — 선에 수직인 막대 하나 / "one": a single perpendicular bar */}
        <marker
          id={MARKER_ID.one}
          viewBox="0 0 12 12"
          refX="10" refY="6"
          markerWidth="12" markerHeight="12"
          orient="auto-start-reverse"
          markerUnits="userSpaceOnUse"
        >
          <path d="M 4 1 L 4 11" stroke="currentColor" strokeWidth="1.6" fill="none" />
        </marker>
        {/* 다중 — 세 갈래 까그발 / "many": the three-pronged crow's foot */}
        <marker
          id={MARKER_ID.many}
          viewBox="0 0 12 12"
          refX="10" refY="6"
          markerWidth="12" markerHeight="12"
          orient="auto-start-reverse"
          markerUnits="userSpaceOnUse"
        >
          <path
            d="M 11 6 L 2 1 M 11 6 L 2 6 M 11 6 L 2 11"
            stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round"
          />
        </marker>
      </defs>
    </svg>
  );
}
```

- [ ] **Step 6: ErdCanvas에 마커 연결**

`frontend/src/components/erd/ErdCanvas.tsx`를 3곳 수정한다.

(a) import에 추가:

```tsx
import { CardinalityMarkerDefs } from "@/components/erd/CardinalityMarkers";
import { getCardinalityEnds, getEdgeVisual, MARKER_ID } from "@/lib/edge-style";
```

(b) `setFlowEdges(...)` 안(`ErdCanvas.tsx:334-360`)의 라벨 조립을 교체한다. 기존의 `let label = ...` 부터 `if (e.kind === "ai_suggested") label = ...` 까지 4줄을 지우고 아래로 바꾼다.

```tsx
        visibleEdges.map((e) => {
          const visual = getEdgeVisual(e.kind, e.confidence ?? undefined);
          // 라벨은 컬럼명만 — 카디널리티는 마커, 근거(✓·AI)는 엣지 클릭 시 표시
          // label carries columns only; cardinality goes to markers, provenance to click
          const label =
            PAIR_KINDS.has(e.kind) && Array.isArray(e.columns) && e.columns.length > 0
              ? (e.columns as { src_column: string }[]).map((c) => c.src_column).join(", ")
              : undefined;
          const ends = getCardinalityEnds(e.cardinality);
          return {
            id: e.id,
            source: String(e.src_object_id),
            target: String(e.tgt_object_id),
            ...resolveEdgeHandles(
              e, anchorInfo.get(e.src_object_id), anchorInfo.get(e.tgt_object_id)),
            style: visual,
            markerStart: ends.source ? `url(#${MARKER_ID[ends.source]})` : undefined,
            markerEnd: ends.target ? `url(#${MARKER_ID[ends.target]})` : undefined,
            label,
            labelStyle: { fontSize: 10, fill: "var(--slate)" },
            "data-testid": `ErdCanvas-edge-${e.id}`,
          } as Edge;
        }),
```

(c) 반환 JSX의 최상위 `<div ref={wrapperRef} ...>` 바로 안, `<ReactFlow>` 앞에 마커 defs를 심는다.

```tsx
    <div ref={wrapperRef} className="relative h-full w-full" data-testid="ErdCanvas-root">
      <CardinalityMarkerDefs />
      <ReactFlow
```

- [ ] **Step 7: 타입·린트 확인**

Run: `cd frontend && npx tsc --noEmit && npx eslint src/components/erd src/lib/edge-style.ts`
Expected: 오류 없음

- [ ] **Step 8: 커밋**

```bash
git add frontend/src/lib/edge-style.ts frontend/src/lib/edge-style.test.ts \
        frontend/src/components/erd/CardinalityMarkers.tsx \
        frontend/src/components/erd/ErdCanvas.tsx
git commit -m "feat(erd): draw cardinality as crow's-foot markers on edges — 카디널리티를 선에 표기"
```

---

## Task 3: 뷰 렌더 필터 (기본 OFF)

**Files:**
- Modify: `frontend/src/components/erd/ErdCanvas.tsx`
- Modify: `frontend/src/lib/i18n.ts`

**Interfaces:**
- Consumes: 기존 `hiddenNodes`, `NODE_CONFIRM_THRESHOLD`
- Produces: 없음 (컴포넌트 내부 상태)

실규모는 테이블 2,342 / 뷰 882다. 뷰까지 그리면 그래프가 폭발한다. **표시 계층에서만** 필터해 `depth` 확장 결과는 보존한다(뷰를 다시 켤 때 재조회 불필요).

- [ ] **Step 1: i18n 키 추가**

`frontend/src/lib/i18n.ts`의 `MESSAGES`에 추가한다(`"erd."` 접두 키들 근처).

```ts
  "erd.showViews": { ko: "뷰 표시", en: "Show views" },
  "erd.viewsHidden": { ko: "뷰 {n}개 숨김", en: "{n} views hidden" },
  "erd.viewsHiddenTip": {
    ko: "뷰를 통해서만 이어지던 경로는 끊겨 보입니다 — 켜면 복원됩니다.",
    en: "Paths that only ran through views appear broken — turn views on to restore them.",
  },
```

- [ ] **Step 2: 상태와 필터 추가**

`ErdCanvas.tsx`의 `ErdCanvasInner` 안, `const [hiddenNodes, setHiddenNodes] = useState<Set<number>>(new Set());` 바로 아래에 추가한다.

```tsx
  // 뷰 882개가 그래프를 폭발시킨다 — 기본 꺼짐, 표시 계층에서만 필터
  // views explode the graph at real scale; filtered at the display layer only
  const [showViews, setShowViews] = useState(false);
```

- [ ] **Step 3: 레이아웃 이펙트에 필터 적용**

`ErdCanvas.tsx:293`의 `visibleGraphNodes` 계산을 교체한다.

```tsx
    const visibleGraphNodes = graph.nodes.filter(
      (n) => !hiddenNodes.has(n.id) && (showViews || n.type !== "view"),
    );
    const renderedIds = new Set(visibleGraphNodes.map((n) => n.id));
```

이어서 `ErdCanvas.tsx:299`의 `visibleEdges` 계산도 교체한다.

```tsx
    // 렌더되지 않는 노드에 닿는 엣지 제외 + 접힌 뷰의 lineage 엣지 숨김
    const visibleEdges = graph.edges.filter(
      (e) => renderedIds.has(e.src_object_id) && renderedIds.has(e.tgt_object_id)
        && (e.kind !== "view_lineage" || expandedNodes.has(e.src_object_id)),
    );
```

이펙트 의존성 배열(`ErdCanvas.tsx:379`)에 `showViews`를 추가한다.

```tsx
  }, [graph, expandedNodes, hiddenNodes, showViews,
      expandNeighbors, toggleNode, onSelectColumn, centerOn]);
```

- [ ] **Step 4: 숨긴 뷰 개수 계산**

`hiddenList` useMemo(`ErdCanvas.tsx:227`) 아래에 추가한다.

```tsx
  // 필터로 안 그려진 뷰 수 — 목록이 왜 짧은지 화면에서 드러나게 한다
  const filteredViewCount = useMemo(
    () => (showViews ? 0 : (graph?.nodes ?? []).filter((n) => n.type === "view").length),
    [graph, showViews],
  );
```

- [ ] **Step 5: 토글 UI 추가**

`ErdCanvas.tsx` 반환 JSX에서 `<CardinalityMarkerDefs />` 바로 아래에 삽입한다.

```tsx
      <div
        className="absolute left-3 top-3 z-10 flex items-center gap-2 rounded-lg border px-3 py-1.5"
        style={{ borderColor: "var(--hairline)", background: "var(--surface-card)" }}
        data-testid="ErdCanvas-viewFilter"
      >
        <label className="flex cursor-pointer items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={showViews}
            onChange={(event) => setShowViews(event.target.checked)}
            data-testid="ErdCanvas-showViewsToggle"
          />
          {t("erd.showViews")}
        </label>
        {filteredViewCount > 0 && (
          <span
            className="badge badge--muted"
            title={t("erd.viewsHiddenTip")}
            data-testid="ErdCanvas-viewsHiddenBadge"
          >
            {t("erd.viewsHidden").replace("{n}", String(filteredViewCount))}
          </span>
        )}
      </div>
```

`t`가 이 컴포넌트에 없으면 `const { t } = useI18n();`을 `ErdCanvasInner` 상단에 추가하고 `import { useI18n } from "@/components/i18n";`을 넣는다(이미 있으면 생략).

- [ ] **Step 6: 40노드 임계 모달을 뷰 토글에도 적용**

뷰를 켜면 노드가 급증하므로 이웃 확장과 같은 확인 절차를 태운다. Step 5의 `onChange`를 교체한다.

```tsx
            onChange={(event) => {
              const next = event.target.checked;
              // 뷰를 켜면 노드가 급증한다 — 이웃 확장과 같은 임계 확인을 태운다
              const wouldRender = (graph?.nodes ?? []).filter((n) => !hiddenNodes.has(n.id)).length;
              const rendered = (graph?.nodes ?? []).filter(
                (n) => !hiddenNodes.has(n.id) && n.type !== "view").length;
              if (next && wouldRender > NODE_CONFIRM_THRESHOLD
                  && rendered <= NODE_CONFIRM_THRESHOLD) {
                setPendingViews(wouldRender);
                return;
              }
              setShowViews(next);
            }}
```

상태와 확인 모달을 추가한다. `showViews` 선언 아래:

```tsx
  // 임계 초과 확인 대기 — 값은 켰을 때 그려질 노드 수 / node count awaiting confirmation
  const [pendingViews, setPendingViews] = useState<number | null>(null);
```

반환 JSX의 뷰 필터 블록 뒤에 모달을 추가한다.

```tsx
      {pendingViews !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
             data-testid="ErdCanvas-viewConfirmModal">
          <div className="w-80 rounded-xl border p-5"
               style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-card)" }}>
            <p className="mb-4 text-sm">
              {t("erd.viewConfirm").replace("{n}", String(pendingViews))}
            </p>
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => setPendingViews(null)}
                      data-testid="ErdCanvas-viewConfirmCancel">
                {t("common.cancel")}
              </button>
              <button
                className="btn-primary"
                onClick={() => { setShowViews(true); setPendingViews(null); }}
                data-testid="ErdCanvas-viewConfirmOk"
              >
                {t("common.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
```

`NODE_CONFIRM_THRESHOLD` import를 확인한다(`@/lib/graph-merge`에서 이미 `planMerge`를 쓰고 있으면 같은 줄에 추가).

- [ ] **Step 7: i18n 키 보강**

`frontend/src/lib/i18n.ts`에 추가한다. `common.cancel` / `common.confirm`이 이미 있으면 중복 추가하지 않는다(`grep -n '"common.cancel"' frontend/src/lib/i18n.ts`로 확인).

```ts
  "erd.viewConfirm": {
    ko: "뷰를 포함하면 {n}개 노드를 그립니다. 계속할까요?",
    en: "Including views renders {n} nodes. Continue?",
  },
```

- [ ] **Step 8: 검증**

Run: `cd frontend && npx tsc --noEmit && npx eslint src/components/erd src/lib/i18n.ts && npx vitest run`
Expected: 전부 통과

- [ ] **Step 9: 커밋**

```bash
git add frontend/src/components/erd/ErdCanvas.tsx frontend/src/lib/i18n.ts
git commit -m "feat(erd): filter views out of the canvas by default — 뷰 렌더 기본 OFF"
```

---

## Task 4: 범례 3줄 축소 + 접기

**Files:**
- Modify: `frontend/src/components/erd/Legend.tsx`
- Modify: `frontend/src/lib/i18n.ts`

**Interfaces:**
- Consumes: Task 1의 `getEdgeGrade`, `getEdgeVisual`
- Produces: 없음

5줄 상시 점유를 3줄 + 접기로 줄인다. 등급이 3개(+계보)로 압축됐으므로 범례도 따라간다.

- [ ] **Step 1: i18n 키 추가**

`frontend/src/lib/i18n.ts`에 추가한다.

```ts
  "erd.legendConfirmed": { ko: "확정 (FK·사용자 확정)", en: "Confirmed (FK / user)" },
  "erd.legendInferredGrade": { ko: "추정 (검증·AI 제안)", en: "Inferred (validated / AI)" },
  "erd.legendUnresolvedGrade": { ko: "미검증", en: "Unverified" },
  "erd.legendLineageGrade": { ko: "뷰 계보", en: "View lineage" },
  "erd.legendToggle": { ko: "범례", en: "Legend" },
```

기존 `erd.legendFk` / `erd.legendInferred` / `erd.legendAi` / `erd.legendLineage` / `erd.legendUnresolved` 키는 다른 참조가 없으면 지운다. 확인: `grep -rn "legendFk\|legendAi" frontend/src`

- [ ] **Step 2: Legend 교체**

`frontend/src/components/erd/Legend.tsx` 전체를 교체한다.

```tsx
"use client";

/** 엣지 시각 언어 범례 — 3등급 + 계보, 접을 수 있다 / collapsible three-grade legend. */

import { useState } from "react";

import { CaretDownIcon, CaretRightIcon } from "@/components/icons";
import { useI18n } from "@/components/i18n";
import { getEdgeVisual, type EdgeKind } from "@/lib/edge-style";
import type { MessageKey } from "@/lib/i18n";

// 등급 대표 kind 하나씩 — 같은 등급은 시각이 동일하므로 하나만 그린다
const ITEMS: { kind: EdgeKind; labelKey: MessageKey }[] = [
  { kind: "fk", labelKey: "erd.legendConfirmed" },
  { kind: "inferred", labelKey: "erd.legendInferredGrade" },
  { kind: "unresolved", labelKey: "erd.legendUnresolvedGrade" },
  { kind: "view_lineage", labelKey: "erd.legendLineageGrade" },
];

export function Legend() {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);

  return (
    <div
      className="absolute bottom-3 left-3 z-10 rounded-lg border px-3 py-2"
      style={{ borderColor: "var(--hairline)", background: "var(--surface-card)" }}
      data-testid="ErdCanvas-legend"
    >
      <button
        className="flex items-center gap-1 text-xs"
        onClick={() => setOpen((current) => !current)}
        data-testid="ErdCanvas-legendToggle"
      >
        {open ? <CaretDownIcon size={11} /> : <CaretRightIcon size={11} />}
        {t("erd.legendToggle")}
      </button>
      {open && ITEMS.map(({ kind, labelKey }) => {
        const v = getEdgeVisual(kind);
        return (
          <div key={kind} className="flex items-center gap-2 py-0.5 text-xs">
            <svg width="32" height="6">
              <line
                x1="0" y1="3" x2="32" y2="3"
                stroke={v.stroke}
                strokeWidth={v.strokeWidth}
                strokeDasharray={v.strokeDasharray}
                opacity={v.opacity}
              />
            </svg>
            <span>{t(labelKey)}</span>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: 검증**

Run: `cd frontend && npx tsc --noEmit && npx eslint src/components/erd && npx vitest run`
Expected: 전부 통과

- [ ] **Step 4: PROGRESS 갱신 후 커밋**

`PROGRESS.md`의 `## 2026-08-05` 섹션 맨 위에 한 항목을 추가한다 — Phase 1 전체(Task 1~4)를 한 줄로 요약한다.

```bash
git add frontend/src/components/erd/Legend.tsx frontend/src/lib/i18n.ts PROGRESS.md
git commit -m "feat(erd): collapse the legend to three grades — 범례 3등급 축소"
```

---

# Phase 2 — 노드 컬럼 전체 렌더

## Task 5: 노드 높이 상한 (layout)

**Files:**
- Modify: `frontend/src/lib/layout.ts`
- Test: `frontend/src/lib/layout.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `MAX_NODE_HEIGHT`, `estimateNodeSize(node, expanded)` (시그니처 유지)

`MAX_VISIBLE_COLUMNS = 24` 절단을 폐기하고 최대높이 상한으로 대체한다. **`estimateNodeSize`에 같은 상한을 반영하지 않으면 ELK가 실제보다 큰 노드를 가정해 배치가 벌어진다.**

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/src/lib/layout.test.ts`의 `describe("estimateNodeSize")` 블록에 추가한다.

```ts
import { MAX_NODE_HEIGHT } from "./layout";

  it("caps expanded node height so ELK does not reserve unbounded space", () => {
    // 컬럼 500개 테이블도 상한을 넘지 않는다 — 넘으면 배치가 화면 밖으로 벌어진다
    const huge = estimateNodeSize(makeNode("table", 500), true);
    expect(huge.height).toBe(MAX_NODE_HEIGHT);
    expect(huge.width).toBe(NODE_WIDTH);
  });

  it("still grows with column count below the cap", () => {
    const small = estimateNodeSize(makeNode("table", 5), true);
    const larger = estimateNodeSize(makeNode("table", 15), true);
    expect(larger.height).toBeGreaterThan(small.height);
    expect(larger.height).toBeLessThanOrEqual(MAX_NODE_HEIGHT);
  });
```

기존 테스트 중 `MAX_VISIBLE_COLUMNS`를 참조하는 것이 있으면 함께 지운다. 확인: `grep -n "MAX_VISIBLE_COLUMNS" frontend/src/lib/layout.test.ts`

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/lib/layout.test.ts`
Expected: FAIL — `MAX_NODE_HEIGHT` 미정의

- [ ] **Step 3: 구현**

`frontend/src/lib/layout.ts:9-27`을 교체한다.

```ts
export const NODE_WIDTH = 260;
/** 노드 카드 최대 높이(px) — 넘는 컬럼은 노드 내부 스크롤로 본다.
 * ELK 입력과 실제 렌더가 같은 상한을 써야 배치가 어긋나지 않는다. */
export const MAX_NODE_HEIGHT = 520;
const HEADER_H = 36;
const ROW_H = 22;
const META_H = 26;

/** 노드 픽셀 크기 추정 — ELK 입력 / estimated pixel size fed to ELK. */
export function estimateNodeSize(
  node: GraphNode,
  expanded: boolean,
): { width: number; height: number } {
  // 모든 노드 기본 접힘(헤더만) — 원하는 것만 선택적으로 펼친다 / every node folds to its header
  if (!expanded) {
    return { width: NODE_WIDTH, height: HEADER_H };
  }
  const natural = HEADER_H + node.columns.length * ROW_H + META_H;
  return { width: NODE_WIDTH, height: Math.min(natural, MAX_NODE_HEIGHT) };
}
```

`MAX_VISIBLE_COLUMNS` export를 제거한다.

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/lib/layout.test.ts`
Expected: PASS

- [ ] **Step 5: 남은 참조 확인 (커밋하지 않는다)**

Run: `cd frontend && grep -rn "MAX_VISIBLE_COLUMNS" src`
`TableNode.tsx`와 `ErdCanvas.tsx`가 걸린다 — 여기서 커밋하면 타입 검사가 깨진 상태가 커밋된다.

> **Task 5와 Task 6은 한 번에 구현하고 한 번에 커밋한다.** `MAX_VISIBLE_COLUMNS`
> 제거가 두 파일을 동시에 깨뜨려 중간 커밋이 성립하지 않는다. Task 6 Step 9의
> 커밋 하나가 두 태스크를 함께 담는다.

---

## Task 6: 노드 내부 스크롤 + 청크 렌더 + 앵커 폴백

**Files:**
- Modify: `frontend/src/components/erd/TableNode.tsx`
- Modify: `frontend/src/components/erd/ErdCanvas.tsx`
- Modify: `frontend/src/lib/edge-anchors.ts`
- Modify: `frontend/src/app/globals.css`
- Test: `frontend/src/lib/edge-anchors.test.ts`

**Interfaces:**
- Consumes: Task 5의 `MAX_NODE_HEIGHT`
- Produces: `TableNodeData.onVisibleColumnsChange(nodeId: number, columns: string[]): void`

컬럼 절단을 없애되, 스크롤로 뷰포트 밖에 나간 행은 엣지 앵커 대상에서 제외하고 헤더로 폴백한다. `resolveEdgeHandles`에 이미 폴백 경로가 있으므로 **`visibleColumns`의 의미만 바꾸면 로직 변경이 없다.**

- [ ] **Step 1: 앵커 의미 변경 테스트 작성**

`frontend/src/lib/edge-anchors.test.ts` 끝에 추가한다.

```ts
  it("falls back to the header handle when the column scrolled out of the viewport", () => {
    // visibleColumns는 '렌더된 컬럼'이 아니라 '스크롤 뷰포트 안의 컬럼'을 뜻한다
    const edge = {
      id: "e1", kind: "fk", src_object_id: 1, tgt_object_id: 2,
      columns: [{ src_column: "ORDER_ID", tgt_column: "ORDER_ID" }],
    } as GraphEdge;
    const scrolledAway = { expanded: true, visibleColumns: new Set<string>(["OTHER"]) };
    const inView = { expanded: true, visibleColumns: new Set<string>(["ORDER_ID"]) };

    expect(resolveEdgeHandles(edge, scrolledAway, inView)).toEqual({
      targetHandle: "t-ORDER_ID",
    });
    expect(resolveEdgeHandles(edge, inView, scrolledAway)).toEqual({
      sourceHandle: "s-ORDER_ID",
    });
  });
```

파일 상단 import에 `GraphEdge` 타입이 없으면 추가한다.

- [ ] **Step 2: 실패 여부 확인**

Run: `cd frontend && npx vitest run src/lib/edge-anchors.test.ts`
Expected: PASS — 기존 로직이 이미 이 동작을 만족한다. **통과가 정상**이며, 이 테스트는 앞으로 의미가 바뀌지 않도록 잠그는 역할이다.

- [ ] **Step 3: 주석으로 의미 갱신**

`frontend/src/lib/edge-anchors.ts:8-12`를 교체한다.

```ts
export interface NodeAnchorInfo {
  expanded: boolean;
  /** 스크롤 뷰포트 안에 실제로 보이는 컬럼 — 밖으로 나간 행은 헤더로 폴백한다.
   * columns currently inside the node's scroll viewport */
  visibleColumns: Set<string>;
}
```

- [ ] **Step 4: TableNode 스크롤·청크 구현**

`frontend/src/components/erd/TableNode.tsx`를 교체한다(전체 파일).

```tsx
"use client";

/** ERD 커스텀 노드 — 기본 접힘, 펼치면 전체 컬럼을 내부 스크롤로 본다.
 * node card with column handles; expanded nodes scroll internally. */

import { useEffect, useRef, useState } from "react";
import { Handle, Position, useUpdateNodeInternals } from "@xyflow/react";
import type { NodeProps, Node } from "@xyflow/react";

import { CaretDownIcon, CaretRightIcon } from "@/components/icons";
import { useI18n } from "@/components/i18n";
import type { GraphNode } from "@/lib/types";

export interface TableNodeData extends Record<string, unknown> {
  node: GraphNode;
  expanded: boolean;
  isAnchor: boolean;
  /** 호버 강조·조인 추천으로 강조된 컬럼명 / columns to highlight */
  highlightColumns: string[] | null;
  onExpandNeighbors: (id: number) => void;
  onToggleNode: (id: number) => void;
  onSelectColumn: (columnId: number, columnName: string, objectQname: string) => void;
  /** 스크롤 뷰포트 안의 컬럼 보고 — 엣지 앵커 해석에 쓰인다 */
  onVisibleColumnsChange: (nodeId: number, columns: string[]) => void;
}

export type TableFlowNode = Node<TableNodeData, "tableNode">;

// 핸들은 지름 1px 투명 — 선 정렬용 좌표만 제공 / invisible coordinate-only handles
const HANDLE_STYLE = { opacity: 0, width: 1, height: 1, minWidth: 1, minHeight: 1 } as const;

// 한 번에 그리는 컬럼 수 — 수백 컬럼 테이블을 통째로 그리면 프레임이 끊긴다
// (TableList·AdUserList와 같은 청크 패턴) / rows rendered per chunk
const RENDER_CHUNK = 60;

export function TableNode({ id, data }: NodeProps<TableFlowNode>) {
  const { t } = useI18n();
  const updateNodeInternals = useUpdateNodeInternals();
  const { node, expanded, isAnchor, highlightColumns } = data;
  const isView = node.type === "view";
  const collapsed = !expanded;
  const highlight = highlightColumns ? new Set(highlightColumns) : null;

  const [visibleCount, setVisibleCount] = useState(RENDER_CHUNK);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // 접었다 펴면 처음 청크부터 / restart chunking when re-expanded
  useEffect(() => {
    if (collapsed) setVisibleCount(RENDER_CHUNK);
  }, [collapsed]);

  // 바닥 도달 → 다음 청크 / append the next chunk at the bottom
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || visibleCount >= node.columns.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((current) => current + RENDER_CHUNK);
        }
      },
      { root: scrollRef.current },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [visibleCount, node.columns.length]);

  // 접기/펼치기·청크 증가로 핸들 구성이 바뀌면 React Flow에 재측정 통지
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, expanded, visibleCount, updateNodeInternals]);

  // 스크롤 뷰포트 안의 컬럼을 보고 — 밖으로 나간 행은 엣지가 헤더로 폴백한다
  // report which rows are inside the viewport so edges can fall back to the header
  const reportVisible = () => {
    const container = scrollRef.current;
    if (!container) return;
    const top = container.scrollTop;
    const bottom = top + container.clientHeight;
    const inView: string[] = [];
    for (const row of Array.from(container.querySelectorAll<HTMLElement>("[data-column-name]"))) {
      if (row.offsetTop + row.offsetHeight > top && row.offsetTop < bottom) {
        inView.push(row.dataset.columnName ?? "");
      }
    }
    data.onVisibleColumnsChange(node.id, inView);
  };

  useEffect(() => {
    if (collapsed) {
      data.onVisibleColumnsChange(node.id, []);
      return;
    }
    reportVisible();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 렌더된 행이 바뀔 때만 재보고
  }, [collapsed, visibleCount, node.id]);

  const shown = node.columns.slice(0, visibleCount);

  return (
    <div
      className={[
        "erd-node",
        isView ? "erd-node--view" : "",
        isAnchor ? "erd-node--selected" : "",
      ].join(" ")}
      onDoubleClick={() => data.onToggleNode(node.id)}
      data-testid={`ErdCanvas-node-${node.id}`}
    >
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />

      <div className="erd-node__header" title={node.ai_summary ?? undefined}>
        <span className="erd-node__type">{isView ? "VIEW" : "TBL"}</span>
        <span className="flex-1 truncate">{node.schema}.{node.name}</span>
        {/* 접힘 상태에서도 규모가 보이게 / column count visible while folded */}
        {collapsed && (
          <span className="erd-node__type">{node.columns.length}c</span>
        )}
        {node.ai_summary && <span className="badge badge--ai">AI</span>}
        <button
          className="icon-button"
          data-testid={`ErdNode-toggleButton-${node.id}`}
          onClick={() => data.onToggleNode(node.id)}
          title={collapsed ? t("erd.expandColumns") : t("erd.collapseColumns")}
        >
          {collapsed ? <CaretRightIcon size={11} /> : <CaretDownIcon size={11} />}
        </button>
        <button
          className="icon-button"
          data-testid={`ErdNode-expandButton-${node.id}`}
          onClick={() => data.onExpandNeighbors(node.id)}
          title={t("erd.expandNeighbors")}
        >
          +
        </button>
      </div>

      {!collapsed && (
        <div>
          <div
            ref={scrollRef}
            className="erd-node__scroll scroll-area"
            onScroll={reportVisible}
            data-testid={`ErdNode-columnScroll-${node.id}`}
          >
            {shown.map((col) => (
              <div
                key={col.id}
                data-column-name={col.name}
                className={[
                  "erd-node__row relative cursor-pointer hover:bg-black/5",
                  col.is_pk ? "erd-node__row--pk" : "",
                  highlight?.has(col.name) ? "erd-node__row--hl" : "",
                ].join(" ")}
                onClick={() =>
                  data.onSelectColumn(col.id, col.name, `${node.schema}.${node.name}`)}
                data-testid={`ErdNode-columnRow-${col.id}`}
              >
                {/* 매칭 컬럼 행에 선이 직접 붙는다 / edges dock at the matching row */}
                <Handle type="target" position={Position.Left} id={`t-${col.name}`}
                        style={HANDLE_STYLE} />
                <Handle type="source" position={Position.Right} id={`s-${col.name}`}
                        style={HANDLE_STYLE} />
                <span className="truncate">
                  {col.is_pk && <span className="pk-mark">PK</span>}
                  {col.name}
                  {col.is_computed ? " ƒ" : ""}
                </span>
                <span className="erd-node__type">
                  {col.data_type}
                  {col.is_nullable ? "" : " *"}
                </span>
              </div>
            ))}
            {visibleCount < node.columns.length && (
              <div ref={sentinelRef} className="erd-node__meta"
                   data-testid={`ErdNode-columnSentinel-${node.id}`}>
                {t("erd.moreColumns")
                  .replace("{n}", String(node.columns.length - visibleCount))}
              </div>
            )}
          </div>
          <div className="erd-node__meta flex gap-1 flex-wrap items-center">
            {node.row_count !== null && <span>{node.row_count.toLocaleString()} rows</span>}
            {node.dmv_unresolved && <span className="badge badge--unresolved">DMV</span>}
            {node.lineage_flag && (
              <span className="badge badge--unresolved">{node.lineage_flag}</span>
            )}
            {node.unresolved_dep_count > 0 && (
              <span className="badge badge--unresolved">
                {t("erd.unresolved")} {node.unresolved_dep_count}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: 스크롤 컨테이너 CSS 추가**

`frontend/src/app/globals.css`의 `.erd-node__meta` 규칙 바로 앞에 추가한다.

```css
/* 펼친 노드의 컬럼 영역 — layout.ts:MAX_NODE_HEIGHT(520) 안에서 스크롤한다.
   ELK 입력과 같은 상한을 써야 배치가 어긋나지 않는다. */
.erd-node__scroll {
  max-height: 458px; /* 520 - 헤더 36 - 메타 26 */
  overflow-y: auto;
  overscroll-behavior: contain;
}
```

- [ ] **Step 6: ErdCanvas 연결 — 핸들 해석을 레이아웃에서 분리**

**핵심:** 스크롤할 때마다 ELK를 다시 돌리면 안 된다. 뷰포트 컬럼은 **엣지 핸들에만** 영향을 주고 노드 좌표에는 영향이 없으므로, 핸들 해석을 레이아웃 이펙트 밖의 `useMemo`로 옮긴다.

(a) `MAX_VISIBLE_COLUMNS` import를 제거한다.

(b) `ErdCanvasInner` 안에 뷰포트 컬럼 상태와 핸들러를 추가한다(`showViews` 선언 아래).

```tsx
  // 노드별 '스크롤 뷰포트 안 컬럼' — 엣지 앵커 해석 입력 / per-node in-viewport columns
  const [viewportColumns, setViewportColumns] =
    useState<Map<number, Set<string>>>(new Map());
  const handleVisibleColumnsChange = useCallback((nodeId: number, columns: string[]) => {
    setViewportColumns((current) => {
      const previous = current.get(nodeId);
      const next = new Set(columns);
      // 같은 집합이면 그대로 — 무한 렌더 방지 / bail out on no-op to avoid a render loop
      if (previous && previous.size === next.size
          && [...next].every((c) => previous.has(c))) {
        return current;
      }
      const merged = new Map(current);
      merged.set(nodeId, next);
      return merged;
    });
  }, []);
```

(c) 레이아웃 이펙트에서 `anchorInfo`와 핸들 해석을 **제거**한다. `ErdCanvas.tsx:303-311`의 `anchorInfo` 블록을 지우고, `setFlowEdges` 안의 `...resolveEdgeHandles(...)` 스프레드 줄도 지운다. 대신 원본 `GraphEdge`를 들고 다닐 수 있게 `data`에 실어둔다.

```tsx
          return {
            id: e.id,
            source: String(e.src_object_id),
            target: String(e.tgt_object_id),
            style: visual,
            markerStart: ends.source ? `url(#${MARKER_ID[ends.source]})` : undefined,
            markerEnd: ends.target ? `url(#${MARKER_ID[ends.target]})` : undefined,
            label,
            labelStyle: { fontSize: 10, fill: "var(--slate)" },
            // 핸들 해석은 스크롤에 따라 바뀐다 — 레이아웃 밖에서 매 렌더 계산한다
            data: { graphEdge: e },
            "data-testid": `ErdCanvas-edge-${e.id}`,
          } as Edge;
```

(d) 노드 `data`에 콜백을 추가한다(`ErdCanvas.tsx:323-331`의 `data` 객체).

```tsx
          data: {
            node: n,
            expanded: expandedNodes.has(n.id),
            isAnchor: n.id === graph.anchor_id,
            highlightColumns: null,
            onExpandNeighbors: expandNeighbors,
            onToggleNode: toggleNode,
            onSelectColumn,
            onVisibleColumnsChange: handleVisibleColumnsChange,
          },
```

(e) 이펙트 의존성 배열에 `handleVisibleColumnsChange`를 추가한다. **`viewportColumns`는 넣지 않는다** — 넣으면 스크롤이 ELK를 다시 돌린다.

```tsx
  }, [graph, expandedNodes, hiddenNodes, showViews,
      expandNeighbors, toggleNode, onSelectColumn, handleVisibleColumnsChange, centerOn]);
```

(f) `displayEdges` useMemo 앞에 핸들 해석 단계를 넣는다.

```tsx
  // 엣지 핸들은 스크롤에 따라 바뀐다 — ELK 재배치 없이 렌더 단계에서만 해석한다
  // handles depend on scroll position; resolved at render, never triggering a relayout
  const anchoredEdges = useMemo(() => {
    const anchorInfo = new Map<number, NodeAnchorInfo>(
      flowNodes.map((n) => [
        Number(n.id),
        {
          expanded: n.data.expanded,
          visibleColumns: viewportColumns.get(Number(n.id)) ?? new Set<string>(),
        },
      ]),
    );
    return flowEdges.map((e) => {
      const graphEdge = (e.data as { graphEdge?: GraphEdge } | undefined)?.graphEdge;
      if (!graphEdge) return e;
      return {
        ...e,
        ...resolveEdgeHandles(
          graphEdge,
          anchorInfo.get(graphEdge.src_object_id),
          anchorInfo.get(graphEdge.tgt_object_id),
        ),
      } as Edge;
    });
  }, [flowEdges, flowNodes, viewportColumns]);
```

(g) `displayEdges` useMemo의 입력을 `flowEdges` → `anchoredEdges`로 바꾼다(두 곳: `if (!emphasis ...) return anchoredEdges;`, `return anchoredEdges.map(...)`, 의존성 배열도).

(h) `GraphEdge` 타입 import를 확인한다(`@/lib/types`).

- [ ] **Step 7: i18n 문구 조정**

`erd.moreColumns`의 의미가 "표시 상한 초과"에서 "아직 안 그린 청크"로 바뀐다. `frontend/src/lib/i18n.ts`에서 값을 교체한다.

```ts
  "erd.moreColumns": { ko: "… {n}개 더 불러오는 중", en: "… loading {n} more" },
```

- [ ] **Step 8: 검증**

Run: `cd frontend && npx vitest run && npx tsc --noEmit && npx eslint src`
Expected: 전부 통과

- [ ] **Step 9: PROGRESS 갱신 후 커밋**

```bash
git add frontend/src/lib/layout.ts frontend/src/lib/layout.test.ts \
        frontend/src/lib/edge-anchors.ts frontend/src/lib/edge-anchors.test.ts \
        frontend/src/components/erd/TableNode.tsx frontend/src/components/erd/ErdCanvas.tsx \
        frontend/src/app/globals.css frontend/src/lib/i18n.ts PROGRESS.md
git commit -m "feat(erd): render every column with an in-node scroll instead of truncating at 24 — 컬럼 절단 폐기"
```

---

# Phase 3 — 조인 빌더 (2테이블)

## Task 7: 판정 순수 함수

**Files:**
- Create: `frontend/src/lib/join-verdict.ts`
- Create: `frontend/src/lib/join-verdict.test.ts`

**Interfaces:**
- Consumes: `ContainmentResponse` (`lib/types.ts`)
- Produces: `VerdictLevel`, `JoinVerdict`, `getJoinVerdict(result, excludedReason)`, `getWorstVerdictIndex(verdicts)`, `PATTERN_LABELS`

수치 나열을 증상명 + 처방 문장으로 바꾼다. 스펙 §2의 판정 표를 그대로 구현한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/src/lib/join-verdict.test.ts` 신규 생성.

```ts
import { describe, expect, it } from "vitest";

import { getJoinVerdict, getWorstVerdictIndex, type JoinVerdict } from "./join-verdict";
import type { ContainmentResponse } from "./types";

function makeResult(overrides: Partial<ContainmentResponse> = {}): ContainmentResponse {
  return {
    src: "ATM.T_ORDER.ORDER_ID", tgt: "ATM.T_ORDER_LOG.ORDER_ID",
    containment: 1.0, matched: 100, src_distinct: 100, orphan_count: 0,
    cardinality: "1:N", confidence: 1.0, pattern: "stable_confirmed",
    observations: 3, observed_at: "2026-08-05T00:00:00Z",
    ...overrides,
  };
}

describe("getJoinVerdict", () => {
  it("rejects low-cardinality columns before looking at anything else", () => {
    const verdict = getJoinVerdict(makeResult(), "low_distinct");
    expect(verdict.level).toBe("danger");
    expect(verdict.symptom).toContain("값 종류");
  });

  it("flags N:M as row explosion even at full containment", () => {
    // N:M이 containment 100%보다 우선 — 짝은 맞아도 행이 폭증한다
    const verdict = getJoinVerdict(makeResult({ cardinality: "N:M" }), null);
    expect(verdict.level).toBe("danger");
    expect(verdict.symptom).toContain("폭증");
  });

  it("calls a full-containment join safe", () => {
    const verdict = getJoinVerdict(makeResult(), null);
    expect(verdict.level).toBe("safe");
    expect(verdict.remedy).toBeNull();
  });

  it("prescribes LEFT JOIN when orphans exist and names the count", () => {
    const verdict = getJoinVerdict(
      makeResult({ containment: 0.88, orphan_count: 12, pattern: "stable_with_orphans" }),
      null,
    );
    expect(verdict.level).toBe("caution");
    expect(verdict.symptom).toContain("12");
    expect(verdict.remedy).toContain("LEFT JOIN");
  });

  it("warns about small samples", () => {
    const verdict = getJoinVerdict(
      makeResult({ pattern: "small_sample_only", src_distinct: 4 }), null);
    expect(verdict.level).toBe("caution");
    expect(verdict.symptom).toContain("표본");
  });

  it("returns unknown when there is no value data", () => {
    const verdict = getJoinVerdict(null, null);
    expect(verdict.level).toBe("unknown");
    expect(verdict.remedy).toBeNull();
  });
});

describe("getWorstVerdictIndex", () => {
  it("ranks danger over caution over unknown over safe", () => {
    const verdicts: JoinVerdict[] = [
      { level: "safe", symptom: "a", remedy: null },
      { level: "caution", symptom: "b", remedy: null },
      { level: "danger", symptom: "c", remedy: null },
      { level: "unknown", symptom: "d", remedy: null },
    ];
    expect(getWorstVerdictIndex(verdicts)).toBe(2);
  });

  it("returns the first occurrence when levels tie", () => {
    const verdicts: JoinVerdict[] = [
      { level: "safe", symptom: "a", remedy: null },
      { level: "caution", symptom: "b", remedy: null },
      { level: "caution", symptom: "c", remedy: null },
    ];
    expect(getWorstVerdictIndex(verdicts)).toBe(1);
  });

  it("returns -1 for an empty draft", () => {
    expect(getWorstVerdictIndex([])).toBe(-1);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/lib/join-verdict.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`frontend/src/lib/join-verdict.ts` 신규 생성.

```ts
/** 조인 판정 — 수치가 아니라 증상명과 처방을 낸다.
 * Turns a containment observation into a symptom and a remedy. */

import type { ContainmentResponse } from "./types";

export type VerdictLevel = "safe" | "caution" | "danger" | "unknown";

export interface JoinVerdict {
  level: VerdictLevel;
  symptom: string;
  /** 사용자가 취할 조치 — 없으면 null / actionable fix, null when none applies */
  remedy: string | null;
}

/** 관측 패턴 라벨 — 접힌 수치 영역에서 쓴다 / pattern labels for the numbers panel. */
export const PATTERN_LABELS: Record<string, string> = {
  stable_confirmed: "지속 1.0 — 사실상 확정 FK",
  stable_with_orphans: "관계 유효 · 고아 데이터 존재",
  drop_alert: "급락 — 스키마·데이터 변경 의심",
  small_sample_only: "소량 데이터 — 우연 가능",
  unstable: "불안정",
};

/** 나쁠수록 큰 값 — 전체 판정은 최악값이 된다 / higher is worse. */
const SEVERITY: Record<VerdictLevel, number> = {
  safe: 0,
  unknown: 1,
  caution: 2,
  danger: 3,
};

/**
 * 표 순서대로 평가한다 — N:M이 containment 100%보다 우선이다.
 * `result`가 null이면 값 데이터가 없어 검증 불가(404)를 뜻한다.
 */
export function getJoinVerdict(
  result: ContainmentResponse | null,
  excludedReason: string | null,
): JoinVerdict {
  if (excludedReason) {
    return {
      level: "danger",
      symptom: "값 종류가 너무 적어 우연히 맞을 수 있습니다",
      remedy: "조인 키로 부적합합니다",
    };
  }
  if (result === null) {
    return {
      level: "unknown",
      symptom: "값 데이터가 없어 검증할 수 없습니다",
      remedy: null,
    };
  }
  if (result.cardinality === "N:M") {
    return {
      level: "danger",
      symptom: "양쪽 다 중복 — 조인하면 행이 폭증합니다",
      remedy: "중간 테이블이 필요합니다",
    };
  }
  if (result.orphan_count > 0) {
    return {
      level: "caution",
      symptom: `짝 없는 행 ${result.orphan_count.toLocaleString()}건 — `
        + "INNER로 묶으면 유실됩니다",
      remedy: "LEFT JOIN 권장",
    };
  }
  if (result.pattern === "small_sample_only") {
    return {
      level: "caution",
      symptom: "표본이 적어 우연일 수 있습니다",
      remedy: "데이터가 쌓인 뒤 재검증하세요",
    };
  }
  if (result.containment >= 1.0) {
    return {
      level: "safe",
      symptom: "모든 행이 짝이 맞습니다",
      remedy: null,
    };
  }
  return {
    level: "caution",
    symptom: `짝이 맞는 행이 ${(result.containment * 100).toFixed(1)}%뿐입니다`,
    remedy: "LEFT JOIN 권장",
  };
}

/** 가장 약한 고리의 인덱스 — 동률이면 앞선 것 / index of the worst step, -1 if empty. */
export function getWorstVerdictIndex(verdicts: JoinVerdict[]): number {
  let worst = -1;
  let severity = -1;
  verdicts.forEach((verdict, index) => {
    if (SEVERITY[verdict.level] > severity) {
      severity = SEVERITY[verdict.level];
      worst = index;
    }
  });
  return worst;
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/lib/join-verdict.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/lib/join-verdict.ts frontend/src/lib/join-verdict.test.ts
git commit -m "feat(join): turn containment numbers into a symptom and a remedy — 검증 결과를 증상+처방으로"
```

---

## Task 8: 조인 드래프트 상태 + 연결성 규칙

**Files:**
- Create: `frontend/src/lib/join-draft.ts`
- Create: `frontend/src/lib/join-draft.test.ts`

**Interfaces:**
- Consumes: Task 7의 `JoinVerdict`, `ContainmentResponse`
- Produces: `JoinColumnRef`, `JoinStep`, `JoinDraft`, `EMPTY_DRAFT`, `canAddStep(draft, left, right)`, `addStep`, `removeStep`, `setStepJoinType`, `setStepResult`, `getDraftTables`, `MAX_JOIN_STEPS`

끊긴 조인은 곱집합이 되어 미리보기가 무의미하다. 새 스텝은 이미 들어온 테이블을 한쪽에 반드시 포함해야 한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/src/lib/join-draft.test.ts` 신규 생성.

```ts
import { describe, expect, it } from "vitest";

import {
  addStep, canAddStep, EMPTY_DRAFT, getDraftTables, MAX_JOIN_STEPS,
  removeStep, setStepJoinType, type JoinColumnRef,
} from "./join-draft";

function ref(qname: string, column: string, columnId: number): JoinColumnRef {
  return { objectId: qname.length, qname, columnId, column };
}

const ORDER = ref("ATM.T_ORDER", "ORDER_ID", 1);
const LOG = ref("ATM.T_ORDER_LOG", "ORDER_ID", 2);
const LOG_USER = ref("ATM.T_ORDER_LOG", "USER_ID", 3);
const USER = ref("ATM.T_USER", "USER_ID", 4);
const DEPT = ref("ATM.T_DEPT", "DEPT_CD", 5);
const OTHER = ref("ATM.T_SHIP", "SHIP_NO", 6);

describe("canAddStep", () => {
  it("accepts any pair as the first step", () => {
    expect(canAddStep(EMPTY_DRAFT, ORDER, LOG)).toEqual({ ok: true });
  });

  it("rejects a pair that joins a table to itself", () => {
    const result = canAddStep(EMPTY_DRAFT, ORDER, ref("ATM.T_ORDER", "CUST_ID", 9));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("같은 테이블");
  });

  it("requires later steps to touch a table already in the draft", () => {
    const draft = addStep(EMPTY_DRAFT, ORDER, LOG);
    expect(canAddStep(draft, LOG_USER, USER)).toEqual({ ok: true });
    const disconnected = canAddStep(draft, DEPT, OTHER);
    expect(disconnected.ok).toBe(false);
    expect(disconnected.ok === false && disconnected.reason).toContain("이어지지");
  });

  it("rejects a duplicate pair", () => {
    const draft = addStep(EMPTY_DRAFT, ORDER, LOG);
    const again = canAddStep(draft, ORDER, LOG);
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.reason).toContain("이미");
  });

  it("caps the draft at MAX_JOIN_STEPS", () => {
    let draft = addStep(EMPTY_DRAFT, ORDER, LOG);
    for (let i = 0; i < MAX_JOIN_STEPS - 1; i += 1) {
      draft = addStep(draft, LOG, ref(`ATM.T_${i}`, "X", 100 + i));
    }
    expect(draft.steps).toHaveLength(MAX_JOIN_STEPS);
    const overflow = canAddStep(draft, LOG, ref("ATM.T_LAST", "X", 999));
    expect(overflow.ok).toBe(false);
    expect(overflow.ok === false && overflow.reason).toContain(String(MAX_JOIN_STEPS));
  });
});

describe("addStep", () => {
  it("starts a step in the verifying state with inner as the default join", () => {
    const draft = addStep(EMPTY_DRAFT, ORDER, LOG);
    expect(draft.steps[0]).toMatchObject({
      status: "verifying", joinType: "inner", result: null, verdict: null,
    });
  });

  it("does not mutate the input draft", () => {
    const before = addStep(EMPTY_DRAFT, ORDER, LOG);
    addStep(before, LOG_USER, USER);
    expect(before.steps).toHaveLength(1);
  });
});

describe("getDraftTables", () => {
  it("lists every table in draft order, first step's left first", () => {
    let draft = addStep(EMPTY_DRAFT, ORDER, LOG);
    draft = addStep(draft, LOG_USER, USER);
    expect(getDraftTables(draft)).toEqual([
      "ATM.T_ORDER", "ATM.T_ORDER_LOG", "ATM.T_USER",
    ]);
  });
});

describe("removeStep and setStepJoinType", () => {
  it("removes by index without touching neighbours", () => {
    let draft = addStep(EMPTY_DRAFT, ORDER, LOG);
    draft = addStep(draft, LOG_USER, USER);
    expect(removeStep(draft, 0).steps).toHaveLength(1);
    expect(removeStep(draft, 0).steps[0].right.qname).toBe("ATM.T_USER");
  });

  it("switches a step to left join", () => {
    const draft = setStepJoinType(addStep(EMPTY_DRAFT, ORDER, LOG), 0, "left");
    expect(draft.steps[0].joinType).toBe("left");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/lib/join-draft.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`frontend/src/lib/join-draft.ts` 신규 생성.

```ts
/** 조인 드래프트 — 스텝 누적과 연결성 규칙. 순수 함수만 둔다.
 * Join draft state: step accumulation and the connectivity rule. */

import type { JoinVerdict } from "./join-verdict";
import type { ContainmentResponse } from "./types";

/** 조인 스텝 상한 — backend/app/api/join_check.py:BATCH_TARGET_LIMIT과 같은 값 */
export const MAX_JOIN_STEPS = 8;

export interface JoinColumnRef {
  objectId: number;
  /** "ATM.T_ORDER" */
  qname: string;
  columnId: number;
  column: string;
}

export type JoinType = "inner" | "left";
export type StepStatus = "verifying" | "ready" | "no_data" | "failed";

export interface JoinStep {
  left: JoinColumnRef;
  right: JoinColumnRef;
  joinType: JoinType;
  status: StepStatus;
  result: ContainmentResponse | null;
  verdict: JoinVerdict | null;
}

export interface JoinDraft {
  steps: JoinStep[];
}

export const EMPTY_DRAFT: JoinDraft = { steps: [] };

export type CanAddResult = { ok: true } | { ok: false; reason: string };

/** 드래프트에 들어온 테이블 — 첫 스텝의 left가 FROM이 된다 / tables in draft order. */
export function getDraftTables(draft: JoinDraft): string[] {
  const tables: string[] = [];
  for (const step of draft.steps) {
    for (const qname of [step.left.qname, step.right.qname]) {
      if (!tables.includes(qname)) tables.push(qname);
    }
  }
  return tables;
}

function isSamePair(step: JoinStep, left: JoinColumnRef, right: JoinColumnRef): boolean {
  const a = [step.left.columnId, step.right.columnId].sort().join("-");
  const b = [left.columnId, right.columnId].sort().join("-");
  return a === b;
}

/**
 * 새 스텝을 받을 수 있는지 — 끊긴 조인은 곱집합이 되어 미리보기가 무의미하다.
 * The connectivity rule: every step after the first must touch an existing table.
 */
export function canAddStep(
  draft: JoinDraft,
  left: JoinColumnRef,
  right: JoinColumnRef,
): CanAddResult {
  if (left.qname === right.qname) {
    return { ok: false, reason: "같은 테이블끼리는 연결할 수 없습니다" };
  }
  if (draft.steps.length >= MAX_JOIN_STEPS) {
    return { ok: false, reason: `조인은 최대 ${MAX_JOIN_STEPS}단계까지입니다` };
  }
  if (draft.steps.some((step) => isSamePair(step, left, right))) {
    return { ok: false, reason: "이미 추가된 조인입니다" };
  }
  if (draft.steps.length === 0) return { ok: true };

  const tables = getDraftTables(draft);
  if (!tables.includes(left.qname) && !tables.includes(right.qname)) {
    return { ok: false, reason: "기존 조인과 이어지지 않습니다 — 한쪽은 이미 들어온 테이블이어야 합니다" };
  }
  return { ok: true };
}

/** 검증 대기 상태로 스텝 추가 — 호출자가 T2를 실행하고 setStepResult로 채운다. */
export function addStep(
  draft: JoinDraft,
  left: JoinColumnRef,
  right: JoinColumnRef,
): JoinDraft {
  const step: JoinStep = {
    left, right, joinType: "inner", status: "verifying", result: null, verdict: null,
  };
  return { steps: [...draft.steps, step] };
}

export function removeStep(draft: JoinDraft, index: number): JoinDraft {
  return { steps: draft.steps.filter((_, i) => i !== index) };
}

function replaceStep(
  draft: JoinDraft, index: number, patch: Partial<JoinStep>,
): JoinDraft {
  return {
    steps: draft.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
  };
}

export function setStepJoinType(
  draft: JoinDraft, index: number, joinType: JoinType,
): JoinDraft {
  return replaceStep(draft, index, { joinType });
}

export function setStepResult(
  draft: JoinDraft,
  index: number,
  status: StepStatus,
  result: ContainmentResponse | null,
  verdict: JoinVerdict,
): JoinDraft {
  return replaceStep(draft, index, { status, result, verdict });
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/lib/join-draft.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/lib/join-draft.ts frontend/src/lib/join-draft.test.ts
git commit -m "feat(join): model the join draft with a connectivity rule — 조인 드래프트 상태 + 연결성 규칙"
```

---

## Task 9: 조인 빌더 도크 UI

**Files:**
- Create: `frontend/src/components/erd/JoinBuilder.tsx`
- Modify: `frontend/src/lib/i18n.ts`

**Interfaces:**
- Consumes: Task 7·8의 `JoinDraft`, `JoinStep`, `JoinVerdict`, `getWorstVerdictIndex`, `PATTERN_LABELS`
- Produces: `<JoinBuilder draft onRemoveStep onSetJoinType onClear onPreview previewBusy />`

스텝이 없으면 안내 한 줄, 있으면 펼쳐진다. 수치는 `⌄ 수치 보기`로 접어둔다.

- [ ] **Step 1: i18n 키 추가**

`frontend/src/lib/i18n.ts`에 추가한다.

```ts
  "join.title": { ko: "조인 빌더", en: "Join builder" },
  "join.empty": {
    ko: "컬럼을 끌어 다른 테이블 컬럼에 놓으면 조인이 시작됩니다",
    en: "Drag a column onto another table's column to start a join",
  },
  "join.overall": { ko: "전체", en: "Overall" },
  "join.weakestLink": { ko: "가장 약한 고리는 {n}번", en: "Weakest link: step {n}" },
  "join.showNumbers": { ko: "수치 보기", en: "Show numbers" },
  "join.hideNumbers": { ko: "수치 숨기기", en: "Hide numbers" },
  "join.applyLeftJoin": { ko: "LEFT JOIN 적용", en: "Apply LEFT JOIN" },
  "join.removeStep": { ko: "이 조인 지우기", en: "Remove this join" },
  "join.clear": { ko: "전부 지우기", en: "Clear all" },
  "join.preview": { ko: "SQL과 20행 보기", en: "Show SQL and 20 rows" },
  "join.verifying": { ko: "검증 중…", en: "Verifying…" },
  "join.stepFailed": { ko: "검증 실패", en: "Verification failed" },
  "join.levelSafe": { ko: "안전", en: "Safe" },
  "join.levelCaution": { ko: "주의", en: "Caution" },
  "join.levelDanger": { ko: "위험", en: "Danger" },
  "join.levelUnknown": { ko: "미정", en: "Unknown" },
```

- [ ] **Step 2: 컴포넌트 생성**

`frontend/src/components/erd/JoinBuilder.tsx` 신규 생성.

```tsx
"use client";

/** 조인 빌더 도크 — 스텝 목록 + 증상/처방 + 미리보기 진입.
 * The join draft dock: steps, verdicts and the preview entry point. */

import { useState } from "react";

import { CloseIcon } from "@/components/icons";
import { useI18n } from "@/components/i18n";
import {
  getWorstVerdictIndex, PATTERN_LABELS,
  type JoinVerdict, type VerdictLevel,
} from "@/lib/join-verdict";
import type { JoinDraft, JoinStep, JoinType } from "@/lib/join-draft";
import type { MessageKey } from "@/lib/i18n";

interface Props {
  draft: JoinDraft;
  onRemoveStep: (index: number) => void;
  onSetJoinType: (index: number, joinType: JoinType) => void;
  onClear: () => void;
  onPreview: () => void;
  previewBusy: boolean;
}

const LEVEL_LABEL: Record<VerdictLevel, MessageKey> = {
  safe: "join.levelSafe",
  caution: "join.levelCaution",
  danger: "join.levelDanger",
  unknown: "join.levelUnknown",
};

const LEVEL_COLOR: Record<VerdictLevel, string> = {
  safe: "var(--rel-confirmed)",
  caution: "var(--stat-ink)",
  danger: "var(--error)",
  unknown: "var(--muted)",
};

function StepRow({
  step, index, onRemoveStep, onSetJoinType,
}: {
  step: JoinStep;
  index: number;
  onRemoveStep: (index: number) => void;
  onSetJoinType: (index: number, joinType: JoinType) => void;
}) {
  const { t } = useI18n();
  const [showNumbers, setShowNumbers] = useState(false);
  const level = step.verdict?.level ?? "unknown";

  return (
    <li className="py-1.5" data-testid={`JoinBuilder-step-${index}`}>
      <div className="flex items-center gap-2 font-mono text-xs">
        <span className="truncate">
          {step.left.qname}.{step.left.column}
        </span>
        <span style={{ color: "var(--muted)" }}>=</span>
        <span className="truncate">
          {step.right.qname}.{step.right.column}
        </span>
        <span className="badge badge--muted">{step.joinType.toUpperCase()}</span>
        <button
          className="icon-button ml-auto"
          title={t("join.removeStep")}
          onClick={() => onRemoveStep(index)}
          data-testid={`JoinBuilder-removeStep-${index}`}
        >
          <CloseIcon />
        </button>
      </div>

      {step.status === "verifying" && (
        <p className="mt-0.5 text-xs" style={{ color: "var(--muted)" }}
           data-testid={`JoinBuilder-stepVerifying-${index}`}>
          {t("join.verifying")}
        </p>
      )}

      {step.verdict && (
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold" style={{ color: LEVEL_COLOR[level] }}
                data-testid={`JoinBuilder-stepLevel-${index}`}>
            {t(LEVEL_LABEL[level])}
          </span>
          <span style={{ color: "var(--body-text)" }}>{step.verdict.symptom}</span>
          {step.verdict.remedy && (
            <span style={{ color: "var(--slate)" }}>→ {step.verdict.remedy}</span>
          )}
          {/* 처방을 한 번에 적용 / apply the prescription in one click */}
          {step.verdict.remedy?.includes("LEFT JOIN") && step.joinType !== "left" && (
            <button
              className="btn-secondary !py-0.5 text-xs"
              onClick={() => onSetJoinType(index, "left")}
              data-testid={`JoinBuilder-applyLeftJoin-${index}`}
            >
              {t("join.applyLeftJoin")}
            </button>
          )}
          {step.result && (
            <button
              className="icon-button"
              onClick={() => setShowNumbers((current) => !current)}
              data-testid={`JoinBuilder-toggleNumbers-${index}`}
            >
              {showNumbers ? t("join.hideNumbers") : t("join.showNumbers")}
            </button>
          )}
        </div>
      )}

      {showNumbers && step.result && (
        <div className="mt-1 text-xs" style={{ color: "var(--slate)" }}
             data-testid={`JoinBuilder-numbers-${index}`}>
          <div>
            containment <b>{(step.result.containment * 100).toFixed(2)}%</b>
            {" · "}{step.result.cardinality}
            {" · "}고아 {step.result.orphan_count.toLocaleString()}
            {" · "}distinct {step.result.src_distinct.toLocaleString()}
          </div>
          <div>
            confidence {step.result.confidence ?? "—"} · 관측 {step.result.observations}회 ·{" "}
            {PATTERN_LABELS[step.result.pattern] ?? step.result.pattern}
          </div>
          <div style={{ color: "var(--muted)" }}>
            last verified {new Date(step.result.observed_at).toLocaleString()}
          </div>
        </div>
      )}
    </li>
  );
}

export function JoinBuilder({
  draft, onRemoveStep, onSetJoinType, onClear, onPreview, previewBusy,
}: Props) {
  const { t } = useI18n();
  // 타입 가드 없이 filter하면 (JoinVerdict|null)[]로 남는다 / narrow with a type predicate
  const verdicts = draft.steps
    .map((s) => s.verdict)
    .filter((v): v is JoinVerdict => v !== null);
  const worst = getWorstVerdictIndex(verdicts);
  const overall = worst >= 0 ? verdicts[worst] : null;

  return (
    <div
      className="scroll-area absolute bottom-3 left-1/2 z-20 max-h-[38%] w-[46rem] max-w-[92vw]
                 -translate-x-1/2 overflow-y-auto rounded-xl border p-3"
      style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-card)" }}
      data-testid="JoinBuilder-root"
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
          {t("join.title")}
        </span>
        {draft.steps.length > 0 && (
          <button className="icon-button ml-auto" onClick={onClear}
                  data-testid="JoinBuilder-clearButton">
            {t("join.clear")}
          </button>
        )}
      </div>

      {draft.steps.length === 0 && (
        <p className="text-xs" style={{ color: "var(--muted)" }}
           data-testid="JoinBuilder-emptyHint">
          {t("join.empty")}
        </p>
      )}

      {draft.steps.length > 0 && (
        <>
          <ul data-testid="JoinBuilder-stepList">
            {draft.steps.map((step, index) => (
              <StepRow
                key={`${step.left.columnId}-${step.right.columnId}`}
                step={step}
                index={index}
                onRemoveStep={onRemoveStep}
                onSetJoinType={onSetJoinType}
              />
            ))}
          </ul>

          <div className="mt-2 flex items-center gap-2 border-t pt-2"
               style={{ borderColor: "var(--hairline)" }}>
            {overall && (
              <span className="text-xs" data-testid="JoinBuilder-overallVerdict">
                <span className="font-semibold" style={{ color: LEVEL_COLOR[overall.level] }}>
                  {t("join.overall")} {t(LEVEL_LABEL[overall.level])}
                </span>
                {draft.steps.length > 1 && overall.level !== "safe" && (
                  <span style={{ color: "var(--slate)" }}>
                    {" · "}{t("join.weakestLink").replace("{n}", String(worst + 1))}
                  </span>
                )}
              </span>
            )}
            <button
              className="btn-primary ml-auto"
              disabled={previewBusy}
              onClick={onPreview}
              data-testid="JoinBuilder-previewButton"
            >
              {t("join.preview")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: 검증**

Run: `cd frontend && npx tsc --noEmit && npx eslint src/components/erd/JoinBuilder.tsx`
Expected: 오류 없음

- [ ] **Step 4: 커밋**

```bash
git add frontend/src/components/erd/JoinBuilder.tsx frontend/src/lib/i18n.ts
git commit -m "feat(join): add the join builder dock — 조인 빌더 도크 UI"
```

---

## Task 10: 드래그 연결 + 추천 하이라이트 + 자동 T2

**Files:**
- Modify: `frontend/src/components/erd/ErdCanvas.tsx`
- Modify: `frontend/src/components/erd/TableNode.tsx`
- Modify: `frontend/src/lib/i18n.ts`

**Interfaces:**
- Consumes: Task 7·8·9 전부, 기존 `fetchCandidates` / `runContainment` (`lib/api.ts`)
- Produces: 없음 (ErdCanvas 내부 배선)

React Flow의 `onConnectStart` / `onConnect`로 컬럼 핸들 드래그를 받는다. 드래그 시작에 T1 후보를 받아 하이라이트하고, 드롭 즉시 T2를 자동 실행한다.

- [ ] **Step 1: i18n 키 추가**

```ts
  "join.dropRejected": { ko: "연결할 수 없습니다 — {reason}", en: "Cannot connect — {reason}" },
  "join.findHidden": { ko: "숨은 짝 찾기", en: "Find hidden matches" },
  "join.findHiddenHint": {
    ko: "이름이 달라도 값이 겹치는 컬럼을 전수 조사합니다 (백그라운드)",
    en: "Scans every column for value overlap regardless of name (background)",
  },
  "join.scanRunning": { ko: "찾는 중 ({done}/{total})", en: "Scanning ({done}/{total})" },
  "join.scanNone": { ko: "짝이 될 만한 컬럼을 찾지 못했습니다", en: "No matching columns found" },
```

- [ ] **Step 2: 핸들을 연결 가능하게 만들기**

`TableNode.tsx`의 컬럼 행 `Handle` 두 개에 `isConnectable`을 명시한다(기본 true지만 의도를 남긴다). 기존 두 줄을 교체한다.

```tsx
                {/* 컬럼 행이 조인 드래그의 출발·도착점 / column rows are join endpoints */}
                <Handle type="target" position={Position.Left} id={`t-${col.name}`}
                        isConnectable style={HANDLE_STYLE} />
                <Handle type="source" position={Position.Right} id={`s-${col.name}`}
                        isConnectable style={HANDLE_STYLE} />
```

- [ ] **Step 3: ErdCanvas에 드래프트 상태와 드래그 핸들러 추가**

`ErdCanvas.tsx`의 import에 추가한다.

```tsx
import { JoinBuilder } from "@/components/erd/JoinBuilder";
import { fetchCandidates, runContainment } from "@/lib/api";
import {
  addStep, canAddStep, EMPTY_DRAFT, removeStep, setStepJoinType, setStepResult,
  type JoinColumnRef, type JoinDraft, type JoinType,
} from "@/lib/join-draft";
import { getJoinVerdict } from "@/lib/join-verdict";
```

`ErdCanvasInner` 안, `pendingViews` 선언 아래에 추가한다.

```tsx
  const [draft, setDraft] = useState<JoinDraft>(EMPTY_DRAFT);
  // 드래그 중 추천 컬럼 — T1 후보를 노드별로 묶어 하이라이트 / T1 candidates while dragging
  const [dragHint, setDragHint] = useState<Map<number, string[]> | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  const dragOriginRef = useRef<JoinColumnRef | null>(null);

  /** 핸들 id("s-COL"/"t-COL")와 노드 id로 컬럼 참조를 만든다 / resolve a handle to a column ref. */
  const resolveHandle = useCallback(
    (nodeId: string | null, handleId: string | null): JoinColumnRef | null => {
      if (!nodeId || !handleId || !graph) return null;
      const objectId = Number(nodeId);
      const node = graph.nodes.find((n) => n.id === objectId);
      if (!node) return null;
      const columnName = handleId.slice(2); // "s-" / "t-" 접두 제거
      const column = node.columns.find((c) => c.name === columnName);
      if (!column) return null;
      return {
        objectId,
        qname: `${node.schema}.${node.name}`,
        columnId: column.id,
        column: column.name,
      };
    },
    [graph],
  );
```

- [ ] **Step 4: onConnectStart — 추천 하이라이트**

같은 위치에 이어서 추가한다.

```tsx
  const handleConnectStart = useCallback(
    (_event: unknown, params: { nodeId: string | null; handleId: string | null }) => {
      setDropError(null);
      const origin = resolveHandle(params.nodeId, params.handleId);
      dragOriginRef.current = origin;
      if (!origin || !graph) return;
      // 드래그 시작 즉시 T1 후보 → 노드별 컬럼명으로 접어 하이라이트
      void fetchCandidates(origin.columnId)
        .then((res) => {
          const byNode = new Map<number, string[]>();
          for (const candidate of res.candidates) {
            const node = graph.nodes.find(
              (n) => `${n.schema}.${n.name}` === candidate.object);
            if (!node) continue;
            byNode.set(node.id, [...(byNode.get(node.id) ?? []), candidate.column]);
          }
          setDragHint(byNode);
        })
        .catch(() => setDragHint(new Map()));
    },
    [graph, resolveHandle],
  );

  const handleConnectEnd = useCallback(() => {
    dragOriginRef.current = null;
    setDragHint(null);
  }, []);
```

- [ ] **Step 5: onConnect — 스텝 추가 + 자동 T2**

이어서 추가한다.

```tsx
  const handleConnect = useCallback(
    (connection: { source: string | null; sourceHandle: string | null;
                   target: string | null; targetHandle: string | null }) => {
      const left = resolveHandle(connection.source, connection.sourceHandle);
      const right = resolveHandle(connection.target, connection.targetHandle);
      if (!left || !right) return;

      setDraft((current) => {
        const check = canAddStep(current, left, right);
        if (!check.ok) {
          setDropError(t("join.dropRejected").replace("{reason}", check.reason));
          return current;
        }
        setDropError(null);
        const next = addStep(current, left, right);
        const index = next.steps.length - 1;
        // 드롭 즉시 T2 자동 실행 — 단일 페어라 기존 검증과 같은 비용
        void runContainment(left.columnId, right.columnId)
          .then((result) => {
            setDraft((latest) => setStepResult(
              latest, index, "ready", result, getJoinVerdict(result, null)));
          })
          .catch((e: Error) => {
            const noData = e.message.includes("no value data");
            setDraft((latest) => setStepResult(
              latest, index, noData ? "no_data" : "failed", null,
              getJoinVerdict(null, null)));
          });
        return next;
      });
    },
    [resolveHandle, t],
  );
```

- [ ] **Step 6: 하이라이트를 노드에 입히기**

`displayNodes` useMemo(`ErdCanvas.tsx:382`)를 교체한다.

```tsx
  // 강조 상태를 렌더에만 입힌다 — ELK 재배치 없이 / emphasis decorates render only
  const displayNodes = useMemo(() => {
    if (!emphasis && !dragHint) return flowNodes;
    return flowNodes.map((n) => {
      // 드래그 중에는 조인 추천이 호버 강조를 덮는다 / drag hints win over hover emphasis
      const columns = dragHint
        ? (dragHint.get(Number(n.id)) ?? null)
        : (emphasis?.columnsByNode.get(Number(n.id)) ?? null);
      if (columns === null && n.data.highlightColumns === null) return n;
      return { ...n, data: { ...n.data, highlightColumns: columns } };
    });
  }, [flowNodes, emphasis, dragHint]);
```

- [ ] **Step 7: ReactFlow에 배선 + 빌더 렌더**

`<ReactFlow ...>` props에 추가한다.

```tsx
        onConnectStart={handleConnectStart}
        onConnect={handleConnect}
        onConnectEnd={handleConnectEnd}
```

`<ReactFlow>` 닫는 태그 뒤, `<Legend />` 근처에 빌더와 드롭 오류를 추가한다.

```tsx
      {dropError && (
        <div
          className="absolute left-1/2 top-16 z-30 -translate-x-1/2 rounded-lg border px-3 py-1.5 text-xs"
          style={{ borderColor: "var(--error)", background: "var(--surface-card)",
                   color: "var(--error)" }}
          data-testid="ErdCanvas-dropError"
        >
          {dropError}
        </div>
      )}
      <JoinBuilder
        draft={draft}
        onRemoveStep={(index) => setDraft((current) => removeStep(current, index))}
        onSetJoinType={(index: number, joinType: JoinType) =>
          setDraft((current) => setStepJoinType(current, index, joinType))}
        onClear={() => setDraft(EMPTY_DRAFT)}
        onPreview={() => undefined}
        previewBusy={false}
      />
```

`onPreview`는 의도적으로 비워둔다 — 미리보기 API(`POST /api/join/preview`)는 Phase 4에서 생기고 Task 15가 여기에 배선한다. Phase 3까지만 랜딩해도 검증·판정은 완전히 동작하며, 미리보기 버튼만 반응하지 않는다.

- [ ] **Step 8: 접힌 노드에 드롭하면 자동 펼침**

React Flow는 접힌 노드에 컬럼 핸들이 없어 드롭이 불가능하다. 드래그가 노드 위에 들어오면 펼친다. `ErdCanvas.tsx`의 `<ReactFlow>` props에 추가한다.

```tsx
        onNodeMouseEnter={(_event, node) => {
          // 드래그 중 접힌 노드에 들어오면 자동으로 펼쳐 컬럼 행을 드롭 대상으로 만든다
          if (!dragOriginRef.current) return;
          const id = Number(node.id);
          if (!expandedNodes.has(id)) toggleNode(id);
        }}
```

- [ ] **Step 9: 검증**

Run: `cd frontend && npx tsc --noEmit && npx eslint src && npx vitest run`
Expected: 전부 통과

- [ ] **Step 10: 실제 앱에서 확인**

Run: `cd frontend && npm run dev` 후 브라우저에서 `/erd?anchor=<id>&label=<schema.table>` 열기
확인 항목: ① 노드를 펼치고 컬럼 우측에서 드래그 시작 → 다른 노드의 추천 컬럼이 강조되는가 ② 접힌 노드 위로 끌면 펼쳐지는가 ③ 드롭하면 빌더에 스텝이 생기고 검증 중 → 증상+처방으로 바뀌는가 ④ 끊긴 조인을 드롭하면 거부 문구가 뜨는가

- [ ] **Step 11: 커밋**

```bash
git add frontend/src/components/erd/ErdCanvas.tsx frontend/src/components/erd/TableNode.tsx \
        frontend/src/lib/i18n.ts
git commit -m "feat(join): build joins by dragging column handles on the canvas — 드래그 조인 + 추천 하이라이트"
```

---

## Task 11: 조인 경로 강조/디밍 + 숨은 짝 찾기

**Files:**
- Modify: `frontend/src/components/erd/ErdCanvas.tsx`

**Interfaces:**
- Consumes: Task 10의 `draft`, `dragHint`, 기존 `startScan` / `fetchScanJob` (`lib/api.ts`)
- Produces: 없음

빌더에 든 테이블만 살리고 나머지는 낮춘다. 추천이 0개일 때만 「숨은 짝 찾기」를 띄운다.

- [ ] **Step 1: 드래프트 강조 계산**

`ErdCanvas.tsx`의 `displayEdges` useMemo 앞에 추가한다.

```tsx
  // 빌더에 든 테이블 — 경로 강조의 기준 / tables currently in the draft
  const draftObjectIds = useMemo(() => {
    const ids = new Set<number>();
    for (const step of draft.steps) {
      ids.add(step.left.objectId);
      ids.add(step.right.objectId);
    }
    return ids;
  }, [draft]);
```

- [ ] **Step 2: 노드 디밍 적용**

`displayNodes` useMemo를 교체한다.

```tsx
  const displayNodes = useMemo(() => {
    const dimming = draftObjectIds.size > 0;
    if (!emphasis && !dragHint && !dimming) return flowNodes;
    return flowNodes.map((n) => {
      const id = Number(n.id);
      const columns = dragHint
        ? (dragHint.get(id) ?? null)
        : (emphasis?.columnsByNode.get(id) ?? null);
      // 조인 경로 밖은 낮춘다 — 드래그 중에는 대상 탐색을 방해하지 않도록 끈다
      const dimmed = dimming && !dragHint && !draftObjectIds.has(id);
      if (columns === null && n.data.highlightColumns === null && !dimmed) return n;
      return {
        ...n,
        style: dimmed ? { ...n.style, opacity: 0.15 } : { ...n.style, opacity: 1 },
        data: { ...n.data, highlightColumns: columns },
      };
    });
  }, [flowNodes, emphasis, dragHint, draftObjectIds]);
```

- [ ] **Step 3: 엣지 디밍 적용**

`displayEdges` useMemo를 교체한다.

```tsx
  const displayEdges = useMemo(() => {
    const dimming = draftObjectIds.size > 0;
    if (!emphasis && !dimming) return anchoredEdges;
    return anchoredEdges.map((e) => {
      const inDraft = dimming
        && draftObjectIds.has(Number(e.source))
        && draftObjectIds.has(Number(e.target));
      const hit = emphasis ? emphasis.edgeIds.has(e.id) : inDraft;
      const baseWidth = Number((e.style as { strokeWidth?: number })?.strokeWidth ?? 1.4);
      return {
        ...e,
        style: hit
          ? { ...e.style, opacity: 1, strokeWidth: baseWidth + 1 }
          : { ...e.style, opacity: 0.12 },
        labelStyle: hit ? e.labelStyle : { ...e.labelStyle, opacity: 0.15 },
        zIndex: hit ? 10 : 0,
      } as Edge;
    });
  }, [anchoredEdges, emphasis, draftObjectIds]);
```

(Task 6 (g)에서 `flowEdges` → `anchoredEdges`로 이미 바꿨다면 이 교체는 디밍 로직만 더하는 것이다.)

- [ ] **Step 4: 숨은 짝 찾기 상태 추가**

`dropError` 선언 아래에 추가한다.

```tsx
  // 추천이 0개일 때만 뜨는 전수 탐색 — 별도 블록이 아니라 추천의 보강 수단
  const [scanJobId, setScanJobId] = useState<number | null>(null);
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null);
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  // ref가 아니라 state — 버튼 노출 여부가 렌더에 걸린다 / state, because it gates the render
  const [scanOrigin, setScanOrigin] = useState<JoinColumnRef | null>(null);
```

`import`에 `fetchScanJob`, `startScan`을 추가한다. `startScan`은 `{ job_id: number; status: string }`를, `fetchScanJob`은 `ScanJobStatus`(`job_id: number`, `progress: {done,total}`, `results: {tgt_object, tgt_column, ...}[]`)를 돌려준다 — `scanJobId`는 `number | null`이 맞다.

- [ ] **Step 5: 스캔 폴링**

`ErdCanvasInner` 안에 이펙트를 추가한다(다른 useEffect 근처).

```tsx
  // 스캔 폴링 — 완료·실패까지 1.5초 간격 (ColumnPanel과 같은 관용)
  useEffect(() => {
    if (scanJobId === null) return;
    const timer = setInterval(() => {
      void fetchScanJob(scanJobId)
        .then((job) => {
          setScanProgress(job.progress);
          if (job.status !== "done" && job.status !== "failed") return;
          setScanJobId(null);
          setScanProgress(null);
          if (job.status === "failed") {
            setScanNotice(job.error ?? t("ai.failed"));
            return;
          }
          if (job.results.length === 0) {
            setScanNotice(t("join.scanNone"));
            return;
          }
          // 찾아낸 컬럼을 추천 하이라이트로 합류시킨다 / merge hits into the drag hints
          const byNode = new Map<number, string[]>();
          for (const hit of job.results) {
            const node = (graph?.nodes ?? []).find(
              (n) => `${n.schema}.${n.name}` === hit.tgt_object);
            if (!node) continue;
            byNode.set(node.id, [...(byNode.get(node.id) ?? []), hit.tgt_column]);
          }
          setDragHint(byNode);
          setScanNotice(null);
        })
        .catch((e: Error) => {
          setScanJobId(null);
          setScanProgress(null);
          setScanNotice(e.message);
        });
    }, 1500);
    return () => clearInterval(timer);
  }, [scanJobId, graph, t]);
```

- [ ] **Step 6: 추천 0개일 때 버튼 노출**

`handleConnectStart`의 `.then(...)` 안에서 후보가 비면 원점을 기억한다. `setDragHint(byNode);` 다음 줄에 추가한다.

```tsx
          // 추천이 없을 때만 전수 탐색을 제안한다 / offer the scan only when nothing was found
          setScanOrigin(res.candidates.length === 0 ? origin : null);
```

`handleConnectEnd`에서 원점을 지우지 않도록 수정한다(버튼이 드래그 종료 후에도 남아야 한다).

```tsx
  const handleConnectEnd = useCallback(() => {
    dragOriginRef.current = null;
    // dragHint·scanOrigin은 유지 — 드래그를 놓은 뒤에도 추천·제안이 남는다
  }, []);
```

Task 10 Step 4의 `handleConnectEnd`가 `setDragHint(null)`을 호출하고 있으므로 그 줄을 지운다. 대신 스텝이 추가될 때(`handleConnect` 성공 경로)와 빌더를 비울 때 하이라이트를 끈다 — `handleConnect`의 `setDropError(null);` 다음 줄에 `setDragHint(null); setScanOrigin(null);`을 넣는다.

버튼 UI를 `dropError` 블록 아래에 추가한다.

```tsx
      {scanOrigin && (
        <div
          className="absolute left-1/2 top-16 z-30 flex -translate-x-1/2 items-center gap-2
                     rounded-lg border px-3 py-1.5 text-xs"
          style={{ borderColor: "var(--hairline)", background: "var(--surface-card)" }}
          data-testid="ErdCanvas-findHidden"
        >
          <button
            className="btn-secondary !py-0.5 text-xs"
            disabled={scanJobId !== null}
            onClick={() => {
              setScanNotice(null);
              void startScan(scanOrigin.columnId)
                .then((res) => setScanJobId(res.job_id))
                .catch((e: Error) => setScanNotice(e.message));
            }}
            data-testid="ErdCanvas-findHiddenButton"
          >
            {t("join.findHidden")}
          </button>
          <span style={{ color: "var(--muted)" }}>
            {scanProgress
              ? t("join.scanRunning")
                  .replace("{done}", String(scanProgress.done))
                  .replace("{total}", String(scanProgress.total))
              : (scanNotice ?? t("join.findHiddenHint"))}
          </span>
        </div>
      )}
```

- [ ] **Step 7: 검증**

Run: `cd frontend && npx tsc --noEmit && npx eslint src && npx vitest run`
Expected: 전부 통과

- [ ] **Step 8: PROGRESS 갱신 후 커밋**

```bash
git add frontend/src/components/erd/ErdCanvas.tsx PROGRESS.md
git commit -m "feat(join): dim everything outside the join path and offer a scan when no candidate exists — 경로 강조 + 숨은 짝 찾기"
```

---

# Phase 4 — N-웨이 조인 (n8n 재배포 전제)

## Task 12: W2 `multi_join_preview` kind + 실행 SQL 반환

**Files:**
- Modify: `tools/build_n8n_workflow.py`
- Modify: `backend/tests/test_n8n_workflow.py`
- Generated: `n8n/workflows/w2_query_executor.json`

**Interfaces:**
- Consumes: 없음
- Produces: W2 응답 계약 `{ query: str, rows: list[dict] }`

**W2 JSON을 직접 편집하지 않는다.** 생성기를 고치고 재생성한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_n8n_workflow.py`의 W2 계약 테스트(`def test_...` 중 `"""W2 계약 ..."""` 독스트링을 가진 것) 아래에 추가한다.

```python
def test_w2_builds_a_multi_join_preview_from_steps() -> None:
    """N-웨이 조인 — 첫 스텝의 left가 FROM, 이후 각 스텝이 JOIN 한 줄."""
    wf = _load(W2_PATH)
    js = next(n for n in wf["nodes"] if n["name"] == "Build query")["parameters"]["jsCode"]
    assert "multi_join_preview" in js
    # join_type은 화이트리스트 매핑 — 임의 문자열이 SQL에 들어가면 안 된다
    assert "INNER JOIN" in js and "LEFT JOIN" in js
    assert "b.join_type" not in js.replace("b.join_type === 'left'", "")


def test_w2_returns_the_executed_sql_with_the_rows() -> None:
    """실행문을 응답에 실어 보낸다 — 화면이 진짜 돌아간 SQL을 보여줄 수 있게."""
    wf = _load(W2_PATH)
    names = [n["name"] for n in wf["nodes"]]
    assert names == ["Webhook", "Build query", "Run query", "Attach query"]
    attach = next(n for n in wf["nodes"] if n["name"] == "Attach query")
    js = attach["parameters"]["jsCode"]
    assert "$('Build query')" in js
    assert "rows" in js and "query" in js
```

- [ ] **Step 2: 실패 확인**

Run: `cd backend && python3 -m pytest tests/test_n8n_workflow.py -v`
Expected: FAIL — `multi_join_preview` 없음, 노드가 3개

- [ ] **Step 3: BUILD_QUERY_JS에 kind 추가**

`tools/build_n8n_workflow.py`의 `BUILD_QUERY_JS`에서 `} else if (b.kind === 'table_preview') {` 앞에 분기를 삽입한다.

```python
} else if (b.kind === 'multi_join_preview') {
  // 첫 스텝의 left가 FROM, 이후 각 스텝이 JOIN 한 줄 — 별칭은 t0..tN
  // first step's left table is FROM; each step adds one JOIN. aliases are t0..tN
  const steps = Array.isArray(b.steps) ? b.steps : [];
  if (steps.length === 0) throw new Error('multi_join_preview needs at least one step');
  if (steps.length > 8) throw new Error('too many join steps');
  const alias = {};           // qname -> t0..tN
  const select = [];
  const from = [];
  const qn = (s, t) => esc(s) + '.' + esc(t);
  const key = (s, t) => s + '.' + t;
  const bind = (schema, table) => {
    const k = key(schema, table);
    if (alias[k] === undefined) alias[k] = 't' + Object.keys(alias).length;
    return alias[k];
  };
  const first = steps[0];
  const a0 = bind(first.left_schema, first.left_table);
  from.push(qn(first.left_schema, first.left_table) + ' ' + a0);
  for (const st of steps) {
    const la = alias[key(st.left_schema, st.left_table)];
    const ra = alias[key(st.right_schema, st.right_table)];
    // 왼쪽이 이미 바인딩돼 있어야 한다 — 백엔드가 연결성을 검증하고 보낸다
    if (la === undefined && ra === undefined) throw new Error('disconnected join step');
    const joiner = (st.join_type === 'left') ? 'LEFT JOIN' : 'INNER JOIN';
    if (ra === undefined) {
      const na = bind(st.right_schema, st.right_table);
      from.push(joiner + ' ' + qn(st.right_schema, st.right_table) + ' ' + na +
        ' ON ' + la + '.' + esc(st.left_column) + ' = ' + na + '.' + esc(st.right_column));
    } else if (la === undefined) {
      const na = bind(st.left_schema, st.left_table);
      from.push(joiner + ' ' + qn(st.left_schema, st.left_table) + ' ' + na +
        ' ON ' + na + '.' + esc(st.left_column) + ' = ' + ra + '.' + esc(st.right_column));
    } else {
      // 양쪽 다 이미 들어와 있다 — 새 JOIN이 아니라 마지막 JOIN에 조건을 더한다
      // both sides already joined: add a condition instead of duplicating the alias
      from[from.length - 1] += ' AND ' + la + '.' + esc(st.left_column) +
        ' = ' + ra + '.' + esc(st.right_column);
    }
    const lq = alias[key(st.left_schema, st.left_table)];
    const rq = alias[key(st.right_schema, st.right_table)];
    select.push(lq + '.' + esc(st.left_column) + ' AS ' +
      esc(st.left_table + '.' + st.left_column));
    select.push(rq + '.' + esc(st.right_column) + ' AS ' +
      esc(st.right_table + '.' + st.right_column));
  }
  query = 'SELECT TOP ' + limit + ' ' + select.join(', ') + ' FROM ' + from.join(' ');
```

세 분기의 의미: ① 오른쪽이 처음 등장 → 오른쪽을 JOIN ② 왼쪽이 처음 등장 → 왼쪽을 JOIN ③ 양쪽 다 이미 들어옴 → 새 JOIN이 아니라 직전 JOIN에 `AND` 조건 추가(중복 별칭 방지). 백엔드가 연결성을 강제하지만 여기서도 방어한다.

- [ ] **Step 4: Attach query 노드 추가**

`tools/build_n8n_workflow.py`의 `BUILD_QUERY_JS` 아래에 새 상수를 추가한다.

```python
# 실행문을 결과와 함께 돌려준다 — 화면이 진짜 돌아간 SQL을 보여줄 수 있게 한다.
# 0행 결과에서도 query가 남도록 단일 아이템 {query, rows}로 감싼다.
ATTACH_QUERY_JS = """\
const query = $('Build query').first().json.query;
// alwaysOutputData가 0건을 빈 아이템 하나로 보낸다 → 빈 객체 제거
const rows = $input.all().map(i => i.json).filter(r => Object.keys(r).length > 0);
return [{ json: { query, rows } }];
"""
```

`build_query_executor_workflow()`의 `nodes` 리스트 끝에 노드를 추가한다.

```python
        _node("Attach query", "n8n-nodes-base.code", [660, 0],
              {"jsCode": ATTACH_QUERY_JS}, type_version=2),
```

`meta.notes`를 갱신한다.

```python
            "notes": "T2 검증·미리보기의 live 실행기 — FastAPI가 kind(containment/join_preview/"
                     "multi_join_preview/table_preview)와 식별자 파라미터를 보내면 고정 템플릿 "
                     "쿼리만 실행한다. 동적 SQL 문자열은 받지 않는다. 응답은 "
                     "{query, rows} 단일 객체 — 실행문을 화면에 그대로 보여주기 위함. "
                     "credentials는 읽기 전용 계정 권장. "
                     "N8N_WEBHOOK_BASE(백엔드)와 webhook 경로(dbv-query)가 일치해야 한다.",
```

- [ ] **Step 5: 재생성**

Run: `python3 tools/build_n8n_workflow.py`
Expected: `wrote .../w2_query_executor.json` 포함 3줄 출력

- [ ] **Step 6: 통과 확인**

Run: `cd backend && python3 -m pytest tests/test_n8n_workflow.py -v`
Expected: PASS (커밋본 == 재생성본 테스트 포함)

- [ ] **Step 7: 커밋**

```bash
git add tools/build_n8n_workflow.py n8n/workflows/w2_query_executor.json \
        backend/tests/test_n8n_workflow.py
git commit -m "feat(n8n): add an N-way join preview kind and return the executed SQL — N-웨이 조인 kind + 실행문 반환"
```

---

## Task 13: 어댑터 — 응답 계약 변경 + `multi_join_preview`

**Files:**
- Modify: `backend/app/adapters/n8n_query.py`
- Modify: `backend/app/domain/validation.py`
- Modify: `backend/app/adapters/fake_validator.py`
- Test: `backend/tests/test_n8n_query.py`

**Interfaces:**
- Consumes: Task 12의 W2 응답 계약
- Produces: `JoinStepRef` dataclass, `JoinValidator.multi_join_preview(steps, limit) -> tuple[list[dict], str]`

`_post_query`가 새 `{query, rows}` 형태와 기존 리스트 형태를 **둘 다 받는다** — 신 백엔드를 구 W2에 배포해도 기존 kind가 죽지 않게 한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_n8n_query.py` 끝에 추가한다.

```python
def test_post_query_accepts_both_legacy_and_wrapped_shapes(monkeypatch) -> None:
    """구 W2(행 리스트)와 신 W2({query, rows})를 모두 받는다 — 배포 순서 결합 제거."""
    from app.adapters import n8n_query

    legacy = [{"a": 1}, {"a": 2}]
    wrapped = {"query": "SELECT 1", "rows": [{"a": 1}]}

    payloads = iter([legacy, wrapped])
    monkeypatch.setattr(n8n_query, "_read_payload", lambda *a, **k: next(payloads))

    rows, query = n8n_query._post_query("http://x", {"kind": "containment"}, 5)
    assert rows == legacy and query is None

    rows, query = n8n_query._post_query("http://x", {"kind": "containment"}, 5)
    assert rows == [{"a": 1}] and query == "SELECT 1"


def test_multi_join_preview_sends_steps_and_returns_the_query(monkeypatch) -> None:
    """N-웨이 미리보기는 스텝 배열을 그대로 보내고 실행문을 함께 받는다."""
    from app.adapters import n8n_query
    from app.domain.validation import JoinStepRef

    captured: dict = {}

    def fake_read(url, body, timeout):  # noqa: ARG001
        captured.update(body)
        return {"query": "SELECT TOP 20 ...", "rows": [{"x": 1}]}

    monkeypatch.setattr(n8n_query, "_read_payload", fake_read)
    validator = n8n_query.N8nJoinValidator("http://x", 5)
    steps = [JoinStepRef(
        left_schema="ATM", left_table="T_ORDER", left_column="ORDER_ID",
        right_schema="ATM", right_table="T_LOG", right_column="ORDER_ID",
        join_type="left",
    )]

    rows, query = validator.multi_join_preview(steps, 20)

    assert captured["kind"] == "multi_join_preview"
    assert captured["limit"] == 20
    assert captured["steps"][0]["join_type"] == "left"
    assert captured["steps"][0]["left_table"] == "T_ORDER"
    assert rows == [{"x": 1}]
    assert query == "SELECT TOP 20 ..."
```

기존 테스트가 `_post_query`의 반환을 리스트로 기대한다면 튜플 언패킹으로 함께 고친다. 확인: `cd backend && grep -n "_post_query" tests/test_n8n_query.py`

- [ ] **Step 2: 실패 확인**

Run: `cd backend && python3 -m pytest tests/test_n8n_query.py -v`
Expected: FAIL — `_read_payload` 없음, `JoinStepRef` 없음

- [ ] **Step 3: 도메인 타입 추가**

`backend/app/domain/validation.py`의 `JoinValidator` Protocol 위에 추가한다.

```python
@dataclass(frozen=True)
class JoinStepRef:
    """N-웨이 조인 한 단계 — 스냅샷 독립 텍스트 식별자 / one join step, snapshot-free."""

    left_schema: str
    left_table: str
    left_column: str
    right_schema: str
    right_table: str
    right_column: str
    join_type: str  # "inner" | "left"
```

`JoinValidator` Protocol에 메서드를 추가한다.

```python
    def multi_join_preview(
        self, steps: list[JoinStepRef], limit: int
    ) -> tuple[list[dict], str]: ...
```

`dataclass` import가 없으면 추가한다.

- [ ] **Step 4: `_post_query` 분리·확장**

`backend/app/adapters/n8n_query.py`의 `_post_query`를 교체한다.

```python
def _read_payload(url: str, body: dict, timeout: int) -> list | dict:
    """단일 HTTP 왕복 — 테스트가 이 경계를 대체한다 / one round trip; tests patch here."""
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode())


def _post_query(
    webhook_base: str, body: dict, timeout: int
) -> tuple[list[dict], str | None]:
    """행과 실행 SQL을 함께 돌려준다.

    신 W2는 {query, rows}, 구 W2는 행 리스트를 보낸다 — 둘 다 받아 배포 순서 결합을
    없앤다. 구 W2에서는 query가 None이다.
    Accepts both the wrapped and the legacy shape so backend and n8n can deploy
    independently.
    """
    url = f"{webhook_base.rstrip('/')}/dbv-query"
    last_error: Exception | None = None
    for attempt in range(RETRY_COUNT + 1):
        try:
            payload = _read_payload(url, body, timeout)
        except URLError as e:
            last_error = e
            logger.warning("n8n query attempt failed",
                           extra={"url": url, "kind": body.get("kind"), "attempt": attempt})
            continue
        if isinstance(payload, dict) and "rows" in payload:
            rows = payload["rows"] or []
            return [r for r in rows if r], payload.get("query")
        rows = payload if isinstance(payload, list) else [payload]
        # W2의 alwaysOutputData가 0건 결과를 빈 아이템({}) 1개로 보낸다 → 빈 리스트로 정규화
        return [r for r in rows if r], None
    raise RuntimeError(
        f"n8n query failed after retries: kind={body.get('kind')} url={url}"
    ) from last_error
```

- [ ] **Step 5: 기존 호출부 언패킹**

같은 파일의 `containment`·`preview`·`N8nTablePreview.rows`를 고친다.

```python
    def containment(self, src: ColumnRef, tgt: ColumnRef) -> ContainmentResult:
        rows, _ = _post_query(self._base, {
            "kind": "containment",
            "src_schema": src.schema, "src_table": src.table, "src_column": src.column,
            "tgt_schema": tgt.schema, "tgt_table": tgt.table, "tgt_column": tgt.column,
        }, self._timeout)
        row = rows[0]
```

```python
    def preview(self, src: ColumnRef, tgt: ColumnRef, limit: int) -> list[dict]:
        rows, _ = _post_query(self._base, {
            "kind": "join_preview", "limit": limit,
            "src_schema": src.schema, "src_table": src.table, "src_column": src.column,
            "tgt_schema": tgt.schema, "tgt_table": tgt.table, "tgt_column": tgt.column,
        }, self._timeout)
        return rows
```

`N8nTablePreview.rows`의 마지막 줄도 `rows, _ = _post_query(...)` / `return rows`로 바꾼다.

- [ ] **Step 6: `multi_join_preview` 구현**

`N8nJoinValidator`에 메서드를 추가한다.

```python
    def multi_join_preview(
        self, steps: list[JoinStepRef], limit: int
    ) -> tuple[list[dict], str]:
        """N-웨이 조인 미리보기 — 실행문을 함께 받는다 / rows plus the executed SQL."""
        rows, query = _post_query(self._base, {
            "kind": "multi_join_preview", "limit": limit,
            "steps": [asdict(step) for step in steps],
        }, self._timeout)
        if query is None:
            raise RuntimeError(
                "n8n W2 did not return the executed SQL — "
                "재배포가 필요합니다 (multi_join_preview는 신 W2 전용)"
            )
        return rows, query
```

import에 `from dataclasses import asdict`와 `from app.domain.validation import JoinStepRef`를 추가한다.

- [ ] **Step 7: Fake는 명시 실패**

`backend/app/adapters/fake_validator.py`의 `FakeJoinValidator`에 추가한다.

```python
    def multi_join_preview(
        self, steps: list[JoinStepRef], limit: int
    ) -> tuple[list[dict], str]:
        """픽스처로 N-웨이 조인을 흉내내지 않는다 — 합성 결과가 실값처럼 나가면 안 된다."""
        raise NotImplementedError(
            "multi_join_preview는 live 원천에서만 지원됩니다 "
            "(합성 조인 결과 노출 금지)"
        )
```

import를 추가한다.

- [ ] **Step 8: 통과 확인**

Run: `cd backend && python3 -m pytest tests/test_n8n_query.py tests/test_validate_api.py tests/test_query_api.py -v`
Expected: PASS

- [ ] **Step 9: 전체 테스트 + 린트**

Run: `cd backend && python3 -m pytest && ruff check .`
Expected: 전부 통과

- [ ] **Step 10: 커밋**

```bash
git add backend/app/adapters/n8n_query.py backend/app/domain/validation.py \
        backend/app/adapters/fake_validator.py backend/tests/test_n8n_query.py
git commit -m "feat(adapters): carry the executed SQL back from W2 and add N-way preview — 실행문 전달 + N-웨이 어댑터"
```

---

## Task 14: `POST /api/join/preview`

**Files:**
- Create: `backend/app/api/join_preview.py`
- Create: `backend/tests/test_join_preview.py`
- Modify: `backend/app/main.py` (라우터 등록)

**Interfaces:**
- Consumes: Task 13의 `JoinStepRef`, `multi_join_preview`, 기존 `resolve_column_ref`
- Produces: `POST /api/join/preview` → `{ rows, query, limit, masked_columns, observed_at }`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_join_preview.py` 신규 생성.

```python
"""N-웨이 조인 미리보기 엔드포인트 테스트. / multi-table join preview API."""

import pytest
import sqlalchemy as sa

from app.api.validate import get_join_validator
from app.models import Base

# 픽스처의 실제 FK — fixtures/catalog.json: FK_HR_EMP_FAMILY_HR_EMP
LEFT = ("dbo.HR_EMP_FAMILY", "EMP_NO")
RIGHT = ("dbo.HR_EMP", "EMP_NO")


class StubValidator:
    """실행문과 행을 고정 반환 — 스텝 배열을 그대로 캡처한다."""

    def __init__(self) -> None:
        self.steps = None
        self.limit = None

    def containment(self, src, tgt):  # pragma: no cover - 이 테스트에서 미사용
        raise NotImplementedError

    def preview(self, src, tgt, limit):  # pragma: no cover - 이 테스트에서 미사용
        raise NotImplementedError

    def multi_join_preview(self, steps, limit):
        self.steps = steps
        self.limit = limit
        return [{"HR_EMP_FAMILY.EMP_NO": "E001", "HR_EMP.EMP_NO": "E001"}], "SELECT TOP 20 ..."


@pytest.fixture()
def stub() -> StubValidator:
    return StubValidator()


@pytest.fixture()
def jclient(client, stub):
    client.app.dependency_overrides[get_join_validator] = lambda: stub
    return client


def _seed(client, load_fixture) -> None:
    sid = client.post("/api/ingest/catalog",
                      json=load_fixture("catalog.json")).json()["snapshot_id"]
    client.post("/api/ingest/view-deps",
                json={**load_fixture("view_deps.json"), "snapshot_id": sid})


def _column_id(engine, object_qname: str, column: str) -> int:
    schema, table = object_qname.split(".", 1)
    obj_t, col_t = Base.metadata.tables["objects"], Base.metadata.tables["columns"]
    with engine.connect() as conn:
        return conn.execute(
            sa.select(col_t.c.id)
            .join(obj_t, col_t.c.object_id == obj_t.c.id)
            .where(obj_t.c.schema == schema, obj_t.c.name == table, col_t.c.name == column)
        ).scalar_one()


def _step(engine, join_type: str = "inner") -> dict:
    return {
        "left_column_id": _column_id(engine, *LEFT),
        "right_column_id": _column_id(engine, *RIGHT),
        "join_type": join_type,
    }


def test_rejects_an_empty_step_list(jclient, load_fixture):
    _seed(jclient, load_fixture)
    res = jclient.post("/api/join/preview", json={"steps": []})
    # Pydantic min_length=1이 422로 막는다 / rejected by request validation
    assert res.status_code == 422


def test_rejects_more_than_eight_steps(jclient, migrated_engine, load_fixture):
    _seed(jclient, load_fixture)
    res = jclient.post("/api/join/preview",
                       json={"steps": [_step(migrated_engine)] * 9})
    assert res.status_code == 400
    assert "too many join steps" in str(res.json())


def test_rejects_a_disconnected_second_step(jclient, migrated_engine, load_fixture):
    """끊긴 조인은 곱집합이 된다 — 두 번째 스텝은 기존 테이블과 이어져야 한다."""
    _seed(jclient, load_fixture)
    far = {
        "left_column_id": _column_id(migrated_engine, "dbo.HR_CERT", "APPOINT_NO"),
        "right_column_id": _column_id(migrated_engine, "dbo.HR_APPOINT", "APPOINT_NO"),
        "join_type": "inner",
    }
    res = jclient.post("/api/join/preview",
                       json={"steps": [_step(migrated_engine), far]})
    assert res.status_code == 400
    assert "disconnected join step" in str(res.json())


def test_returns_rows_and_the_executed_sql(jclient, stub, migrated_engine, load_fixture):
    _seed(jclient, load_fixture)
    res = jclient.post("/api/join/preview",
                       json={"steps": [_step(migrated_engine, "left")]})

    assert res.status_code == 200
    body = res.json()
    assert body["query"] == "SELECT TOP 20 ..."
    assert body["limit"] == 20
    assert len(body["rows"]) == 1
    assert stub.limit == 20
    assert stub.steps[0].join_type == "left"
    assert stub.steps[0].left_table == "HR_EMP_FAMILY"
    assert stub.steps[0].right_table == "HR_EMP"


def test_writes_an_audit_log(jclient, migrated_engine, load_fixture):
    """원본 값이 나가는 지점 — 감사 없이 통과하면 안 된다."""
    _seed(jclient, load_fixture)
    jclient.post("/api/join/preview", json={"steps": [_step(migrated_engine)]})

    audit_t = Base.metadata.tables["audit_logs"]
    with migrated_engine.connect() as conn:
        actions = conn.execute(sa.select(audit_t.c.action)).scalars().all()
    assert "join_preview" in actions


def test_reports_503_when_the_source_is_synthetic(client, migrated_engine, load_fixture):
    """FakeJoinValidator는 명시 실패 — 합성 조인 결과가 실값처럼 나가면 안 된다."""
    from app.adapters.fake_validator import FakeJoinValidator

    _seed(client, load_fixture)

    def _fake():
        return FakeJoinValidator.__new__(FakeJoinValidator)

    client.app.dependency_overrides[get_join_validator] = _fake
    res = client.post("/api/join/preview", json={"steps": [_step(migrated_engine)]})
    assert res.status_code == 503
```

**확인:** `dbo.HR_CERT.APPOINT_NO` / `dbo.HR_APPOINT.APPOINT_NO`는 픽스처의 `FK_HR_CERT_HR_APPOINT`에서 온 실제 페어다. 이름이 다르면 아래로 확인해 맞춘다.

Run: `cd /Users/hyeonjin/Documents/db-viewer && python3 -c "import json,pathlib; d=json.loads(pathlib.Path('fixtures/catalog.json').read_text()); o={x['object_id']:x for x in d['objects']}; [print(fk['name'], o[fk['src_object_id']]['schema']+'.'+o[fk['src_object_id']]['name'], '->', o[fk['tgt_object_id']]['schema']+'.'+o[fk['tgt_object_id']]['name'], fk['columns']) for fk in d['foreign_keys'][:5]]"`

- [ ] **Step 2: 실패 확인**

Run: `cd backend && python3 -m pytest tests/test_join_preview.py -v`
Expected: FAIL — 404 (라우트 없음)

- [ ] **Step 3: 라우터 구현**

`backend/app/api/join_preview.py` 신규 생성.

```python
"""Multi-table join preview — N-way join over validated column pairs.
/ N-웨이 조인 미리보기 (스펙 2026-08-05 §3.3)."""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.validate import get_join_validator, resolve_column_ref
from app.db import get_db
from app.domain.validation import JoinStepRef, JoinValidator, ValidationDataMissing
from app.models import AuditLog

router = APIRouter(prefix="/api/join", tags=["join"])

# TOP 20 고정 — 클라이언트가 늘릴 수 없다 (계획 §3.5와 같은 규약)
PREVIEW_LIMIT = 20
# 조인 단계 상한 — join_check.BATCH_TARGET_LIMIT과 같은 값 / same cap as batch join check
MAX_STEPS = 8


class JoinStepIn(BaseModel):
    left_column_id: int
    right_column_id: int
    join_type: str = Field(default="inner", pattern="^(inner|left)$")


class JoinPreviewRequest(BaseModel):
    steps: list[JoinStepIn] = Field(min_length=1)
    requested_by: str = "local"


def _check_connectivity(steps: list[JoinStepRef]) -> None:
    """끊긴 조인은 곱집합이 된다 — 각 스텝은 이미 들어온 테이블과 이어져야 한다."""
    seen: set[str] = set()
    for index, step in enumerate(steps):
        left = f"{step.left_schema}.{step.left_table}"
        right = f"{step.right_schema}.{step.right_table}"
        if left == right:
            raise HTTPException(400, {
                "message": "join step connects a table to itself",
                "context": {"step": index, "table": left},
            })
        if index == 0:
            seen.update({left, right})
            continue
        if left not in seen and right not in seen:
            raise HTTPException(400, {
                "message": "disconnected join step",
                "context": {"step": index, "left": left, "right": right,
                            "joined": sorted(seen)},
            })
        seen.update({left, right})


@router.post("/preview")
def run_join_preview(
    req: JoinPreviewRequest,
    db: Session = Depends(get_db),
    validator: JoinValidator = Depends(get_join_validator),
) -> dict:
    """N-웨이 조인 샘플 — 원본 값이 나가는 지점: 무캐시·마스킹·감사 (스펙 §3.3)."""
    if len(req.steps) > MAX_STEPS:
        raise HTTPException(400, {
            "message": f"too many join steps (max {MAX_STEPS})",
            "context": {"steps": len(req.steps)},
        })

    refs: list[JoinStepRef] = []
    masked_keys: set[str] = set()
    for step in req.steps:
        left_ref, left_col = resolve_column_ref(db, step.left_column_id)
        right_ref, right_col = resolve_column_ref(db, step.right_column_id)
        refs.append(JoinStepRef(
            left_schema=left_ref.schema, left_table=left_ref.table,
            left_column=left_ref.column,
            right_schema=right_ref.schema, right_table=right_ref.table,
            right_column=right_ref.column,
            join_type=step.join_type,
        ))
        # W2가 "테이블.컬럼"으로 별칭을 붙인다 — 마스킹 키를 같은 규칙으로 만든다
        if left_col.masking_policy:
            masked_keys.add(f"{left_ref.table}.{left_ref.column}")
        if right_col.masking_policy:
            masked_keys.add(f"{right_ref.table}.{right_ref.column}")

    _check_connectivity(refs)

    try:
        rows, query = validator.multi_join_preview(refs, PREVIEW_LIMIT)
    except ValidationDataMissing as e:
        raise HTTPException(
            404, {"message": "no value data for column", "context": {"column": str(e.ref)}}
        ) from e
    except NotImplementedError as e:
        raise HTTPException(
            503,
            {"message": "join preview is unavailable without a live source",
             "context": {"reason": str(e)}},
        ) from e

    if masked_keys:
        rows = [
            {k: ("●●●" if k in masked_keys else v) for k, v in row.items()}
            for row in rows
        ]

    now = datetime.now(UTC)
    path = " -> ".join(
        f"{s.left_schema}.{s.left_table}.{s.left_column}"
        f"={s.right_schema}.{s.right_table}.{s.right_column}" for s in refs
    )
    db.add(AuditLog(
        action="join_preview",
        detail=f"{path} ({len(rows)} rows)",
        requested_by=req.requested_by, requested_at=now,
    ))
    return {
        "rows": rows, "query": query, "limit": PREVIEW_LIMIT,
        "masked_columns": sorted(masked_keys),
        "observed_at": now.isoformat(),
    }
```

- [ ] **Step 4: 라우터 등록**

`backend/app/main.py`에서 다른 라우터 등록부를 찾아 같은 방식으로 추가한다.

Run: `cd backend && grep -n "include_router" app/main.py | head`

```python
from app.api import join_preview
...
app.include_router(join_preview.router)
```

인증이 걸린 라우터가 `dependencies=[Depends(...)]`를 받고 있으면 **같은 의존성을 붙인다** — 미리보기는 원본 값이 나가는 경로다.

- [ ] **Step 5: 통과 확인**

Run: `cd backend && python3 -m pytest tests/test_join_preview.py -v`
Expected: PASS

- [ ] **Step 6: 전체 테스트 + 린트**

Run: `cd backend && python3 -m pytest && ruff check .`
Expected: 전부 통과

- [ ] **Step 7: 커밋**

```bash
git add backend/app/api/join_preview.py backend/app/main.py backend/tests/test_join_preview.py
git commit -m "feat(api): add POST /api/join/preview for N-way joins — N-웨이 조인 미리보기 API"
```

---

## Task 15: 프론트 연결 — SQL 탭 / 행 탭

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/lib/types.ts`
- Create: `frontend/src/components/erd/JoinPreviewPanel.tsx`
- Modify: `frontend/src/components/erd/ErdCanvas.tsx`
- Modify: `frontend/src/lib/i18n.ts`

**Interfaces:**
- Consumes: Task 14의 `POST /api/join/preview`, Task 9의 `onPreview`
- Produces: `JoinPreviewResponse`, `runJoinPreview(steps)`, `<JoinPreviewPanel />`

- [ ] **Step 1: 타입 추가**

`frontend/src/lib/types.ts`에 추가한다.

```ts
export interface JoinPreviewResponse {
  rows: Record<string, unknown>[];
  /** W2가 실제로 실행한 SQL — 화면 표시용으로 조립하지 않는다 */
  query: string;
  limit: number;
  masked_columns: string[];
  observed_at: string;
}
```

- [ ] **Step 2: API 클라이언트 추가**

`frontend/src/lib/api.ts`에 추가한다(`runPreview` 근처).

```ts
/** N-웨이 조인 미리보기 — 행과 실행 SQL을 함께 받는다 / rows plus the executed SQL. */
export async function runJoinPreview(
  steps: { left_column_id: number; right_column_id: number; join_type: string }[],
): Promise<JoinPreviewResponse> {
  return postJson("/api/join/preview", { steps });
}
```

`JoinPreviewResponse` import를 추가한다.

- [ ] **Step 3: i18n 키 추가**

```ts
  "join.tabSql": { ko: "SQL", en: "SQL" },
  "join.tabRows": { ko: "결과 {n}행", en: "{n} rows" },
  "join.previewMasked": { ko: "마스킹된 컬럼: {cols}", en: "Masked columns: {cols}" },
  "join.previewEmpty": { ko: "조인 결과가 0행입니다", en: "The join returned no rows" },
  "join.copySql": { ko: "SQL 복사", en: "Copy SQL" },
```

- [ ] **Step 4: 결과 패널 생성**

`frontend/src/components/erd/JoinPreviewPanel.tsx` 신규 생성.

```tsx
"use client";

/** 조인 미리보기 결과 — SQL 탭 / 행 탭. SQL은 W2가 실행한 문장 그대로다.
 * Join preview result: the SQL tab shows exactly what W2 executed. */

import { useState } from "react";

import { CloseIcon } from "@/components/icons";
import { useI18n } from "@/components/i18n";
import type { JoinPreviewResponse } from "@/lib/types";

interface Props {
  result: JoinPreviewResponse | null;
  error: string | null;
  onClose: () => void;
}

export function JoinPreviewPanel({ result, error, onClose }: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"sql" | "rows">("rows");

  if (!result && !error) return null;
  const columns = result && result.rows.length > 0 ? Object.keys(result.rows[0]) : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
         onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-[56rem] max-w-[94vw] flex-col rounded-xl border p-5"
        style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-card)" }}
        onClick={(e) => e.stopPropagation()}
        data-testid="JoinPreviewPanel-root"
      >
        <div className="mb-2 flex items-center gap-2">
          <button
            className={tab === "rows" ? "btn-primary !py-1 text-xs" : "btn-secondary !py-1 text-xs"}
            onClick={() => setTab("rows")}
            data-testid="JoinPreviewPanel-rowsTab"
          >
            {t("join.tabRows").replace("{n}", String(result?.rows.length ?? 0))}
          </button>
          <button
            className={tab === "sql" ? "btn-primary !py-1 text-xs" : "btn-secondary !py-1 text-xs"}
            onClick={() => setTab("sql")}
            data-testid="JoinPreviewPanel-sqlTab"
          >
            {t("join.tabSql")}
          </button>
          <button className="icon-button ml-auto" onClick={onClose}
                  data-testid="JoinPreviewPanel-closeButton">
            <CloseIcon />
          </button>
        </div>

        {error && (
          <p className="text-sm" style={{ color: "var(--error)" }}
             data-testid="JoinPreviewPanel-error">
            {error}
          </p>
        )}

        {result && tab === "sql" && (
          <div className="scroll-area min-h-0 overflow-auto">
            <pre className="whitespace-pre-wrap font-mono text-xs"
                 data-testid="JoinPreviewPanel-sql">
              {result.query}
            </pre>
            <button
              className="btn-secondary mt-2 !py-1 text-xs"
              onClick={() => void navigator.clipboard.writeText(result.query)}
              data-testid="JoinPreviewPanel-copySql"
            >
              {t("join.copySql")}
            </button>
          </div>
        )}

        {result && tab === "rows" && (
          <div className="scroll-area min-h-0 overflow-auto"
               data-testid="JoinPreviewPanel-rows">
            {result.rows.length === 0 && (
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                {t("join.previewEmpty")}
              </p>
            )}
            {result.rows.length > 0 && (
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <th key={c} className="px-2 py-1 text-left font-mono"
                          style={{ color: "var(--muted)" }}>
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr key={i}>
                      {columns.map((c) => (
                        <td key={c} className="px-2 py-1 font-mono">{String(row[c] ?? "")}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {result.masked_columns.length > 0 && (
              <p className="mt-2 text-xs" style={{ color: "var(--slate)" }}>
                {t("join.previewMasked").replace("{cols}", result.masked_columns.join(", "))}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: ErdCanvas에 배선**

`ErdCanvas.tsx`에 상태를 추가한다.

```tsx
  const [joinPreview, setJoinPreview] = useState<JoinPreviewResponse | null>(null);
  const [joinPreviewError, setJoinPreviewError] = useState<string | null>(null);
  const [joinPreviewBusy, setJoinPreviewBusy] = useState(false);
```

Task 10에서 비워뒀던 `onPreview`를 채운다.

```tsx
        onPreview={() => {
          setJoinPreviewBusy(true);
          setJoinPreviewError(null);
          void runJoinPreview(draft.steps.map((s) => ({
            left_column_id: s.left.columnId,
            right_column_id: s.right.columnId,
            join_type: s.joinType,
          })))
            .then(setJoinPreview)
            .catch((e: Error) => setJoinPreviewError(e.message))
            .finally(() => setJoinPreviewBusy(false));
        }}
        previewBusy={joinPreviewBusy}
```

`<JoinBuilder />` 아래에 패널을 추가한다.

```tsx
      <JoinPreviewPanel
        result={joinPreview}
        error={joinPreviewError}
        onClose={() => { setJoinPreview(null); setJoinPreviewError(null); }}
      />
```

import를 추가한다.

- [ ] **Step 6: 검증**

Run: `cd frontend && npx tsc --noEmit && npx eslint src && npx vitest run`
Expected: 전부 통과

- [ ] **Step 7: PROGRESS 갱신 후 커밋**

```bash
git add frontend/src/lib/api.ts frontend/src/lib/types.ts frontend/src/lib/i18n.ts \
        frontend/src/components/erd/JoinPreviewPanel.tsx \
        frontend/src/components/erd/ErdCanvas.tsx PROGRESS.md
git commit -m "feat(join): show the executed SQL alongside the 20-row sample — SQL 탭 + 결과 탭"
```

---

# Phase 5 — 기존 진입점 통합

## Task 16: `ColumnPanel` 제거 + 딥링크 매핑

**Files:**
- Delete: `frontend/src/components/ColumnPanel.tsx`
- Modify: `frontend/src/app/erd/page.tsx`
- Modify: `frontend/src/components/erd/ErdCanvas.tsx`
- Modify: `frontend/src/components/browser/ColumnCheckModal.tsx` (import 경로만)

**Interfaces:**
- Consumes: Task 7의 `PATTERN_LABELS`(이미 `join-verdict.ts`로 이관됨)
- Produces: `ErdCanvas`의 `initialColumnId` prop

`/erd?col=&colName=&label=` 딥링크는 "그 컬럼에서 드래그 대기 상태로 빌더 열기"로 매핑해 깨뜨리지 않는다.

- [ ] **Step 1: `PATTERN_LABELS` 참조 이관**

Run: `cd frontend && grep -rn "PATTERN_LABELS" src`
`ColumnCheckModal.tsx`가 `@/components/ColumnPanel`에서 import 중이다. `@/lib/join-verdict`로 바꾼다.

```tsx
import { PATTERN_LABELS } from "@/lib/join-verdict";
```

- [ ] **Step 2: ErdCanvas에 딥링크 진입 prop 추가**

`ErdCanvas` Props 인터페이스에 추가한다.

```tsx
  /** 딥링크로 들어온 컬럼 — 추천 하이라이트를 켠 채로 드래그를 기다린다 */
  initialColumnId?: number | null;
```

`ErdCanvasInner`에 이펙트를 추가한다.

```tsx
  // 딥링크(?col=) — 그 컬럼의 추천을 미리 켜 드래그 출발점을 알려준다
  // deep link: pre-light the candidates so the user knows where to drag from
  useEffect(() => {
    if (!initialColumnId || !graph) return;
    void fetchCandidates(initialColumnId)
      .then((res) => {
        const byNode = new Map<number, string[]>();
        for (const candidate of res.candidates) {
          const node = graph.nodes.find((n) => `${n.schema}.${n.name}` === candidate.object);
          if (!node) continue;
          byNode.set(node.id, [...(byNode.get(node.id) ?? []), candidate.column]);
        }
        setDragHint(byNode);
      })
      .catch(() => undefined);
  }, [initialColumnId, graph]);
```

- [ ] **Step 3: erd/page.tsx에서 ColumnPanel 제거**

`frontend/src/app/erd/page.tsx`를 고친다.

- `import { ColumnPanel, type SelectedColumn } from "@/components/ColumnPanel";` 제거
- `selectedColumn` 상태를 컬럼 id만 담는 것으로 축소

```tsx
  // 브라우저 컬럼 칩 딥링크 → 빌더의 추천 하이라이트 자동 점등
  const [initialColumnId] = useState<number | null>(() => {
    const columnId = params.get("col");
    return columnId ? Number(columnId) : null;
  });
```

- `handleSelectColumn`은 이제 아무 것도 하지 않으므로 제거하고, `ErdCanvas`의 `onSelectColumn`은 컬럼 행 클릭 시 아무 패널도 열지 않도록 no-op로 남긴다(드래그가 주 조작이다).

```tsx
        <ErdCanvas
          anchorId={anchor?.id ?? null}
          initialColumnId={initialColumnId}
          onSelectColumn={() => undefined}
          onQuickStart={handleQuickStart}
        />
        <SearchPanel onSelect={setAnchor} selectedId={anchor?.id ?? null} />
```

- `<ColumnPanel ... />` 렌더 제거

- [ ] **Step 4: 파일 삭제**

```bash
git rm frontend/src/components/ColumnPanel.tsx
```

- [ ] **Step 5: 남은 참조 확인**

Run: `cd frontend && grep -rn "ColumnPanel" src`
Expected: 결과 없음 (있으면 마저 정리)

- [ ] **Step 6: 검증**

Run: `cd frontend && npx tsc --noEmit && npx eslint src && npx vitest run`
Expected: 전부 통과

- [ ] **Step 7: 커밋**

```bash
git add -A frontend/src
git commit -m "refactor(erd): fold ColumnPanel into the join builder — ColumnPanel 흡수"
```

---

## Task 17: `ColumnCheckModal` 제거 + 브라우저 칩 직행

**Files:**
- Delete: `frontend/src/components/browser/ColumnCheckModal.tsx`
- Modify: `frontend/src/app/page.tsx`
- Modify: `frontend/src/components/browser/TableDetail.tsx`

**Interfaces:**
- Consumes: Task 16의 딥링크 매핑
- Produces: 없음

브라우저에서 컬럼 칩을 누르면 자동 T2 3건을 돌리는 모달 대신 ERD 빌더로 직행한다.

- [ ] **Step 1: 사용처 확인**

Run: `cd frontend && grep -rn "ColumnCheckModal\|onOpenColumn" src`

- [ ] **Step 2: page.tsx에서 모달 제거**

`frontend/src/app/page.tsx`에서 `ColumnCheckModal` import·상태·렌더를 지우고, 컬럼 칩 클릭을 ERD 딥링크 이동으로 바꾼다. 기존 `onOpenColumn` 핸들러를 아래로 교체한다(라우터 push는 이미 쓰고 있는 방식을 따른다 — `grep -n "router.push" src/app/page.tsx`로 확인).

```tsx
  // 컬럼 클릭 → ERD 조인 빌더로 직행 (검증은 거기서 드래그로 한다)
  const handleOpenColumn = useCallback(
    (columnId: number, columnName: string) => {
      if (!selected) return;
      const label = `${selected.schema}.${selected.name}`;
      router.push(
        `/erd?anchor=${selected.id}&label=${encodeURIComponent(label)}`
        + `&col=${columnId}&colName=${encodeURIComponent(columnName)}`,
      );
    },
    [router, selected],
  );
```

`selected`는 현재 선택된 테이블 상태의 실제 이름으로 맞춘다(`grep -n "const \[selected" src/app/page.tsx`).

- [ ] **Step 3: 파일 삭제**

```bash
git rm frontend/src/components/browser/ColumnCheckModal.tsx
```

- [ ] **Step 4: 남은 참조 확인**

Run: `cd frontend && grep -rn "ColumnCheckModal" src`
Expected: 결과 없음

- [ ] **Step 5: 검증**

Run: `cd frontend && npx tsc --noEmit && npx eslint src && npx vitest run`
Expected: 전부 통과

- [ ] **Step 6: 커밋**

```bash
git add -A frontend/src
git commit -m "refactor(browser): send column clicks straight to the ERD join builder — 컬럼 클릭을 빌더로 직행"
```

---

## Task 18: `TableDetail` 「빌더에 추가」 + 용어 정리

**Files:**
- Modify: `backend/app/api/join_check.py`
- Modify: `backend/tests/test_join_check.py`
- Modify: `frontend/src/components/browser/TableDetail.tsx`
- Modify: `frontend/src/lib/i18n.ts`

**Interfaces:**
- Consumes: Task 17의 딥링크 형식
- Produces: `/api/join-check` 응답 항목에 `src_column_id`, `tgt_column_id` 추가

`TableDetail`의 일괄 조인검증은 **발견 기능이라 유지**한다("이 테이블은 뭐랑 조인되나"를 답한다). 결과 행에서 빌더로 넘어가게만 한다. 현재 응답은 `target_object`·`src_column`·`tgt_column`·`score`·`signals`만 담아 **컬럼 id가 없어 딥링크를 만들 수 없다** — 먼저 백엔드에 id를 싣는다.

- [ ] **Step 1: 백엔드 — 실패하는 테스트 작성**

`backend/tests/test_join_check.py`에 추가한다.

```python
def test_join_check_items_carry_column_ids_for_deep_links(vclient, load_fixture, migrated_engine):
    """결과에서 조인 빌더로 넘어가려면 컬럼 id가 필요하다 / deep links need column ids."""
    _seed(vclient, load_fixture)
    object_id = _object_id(migrated_engine, "dbo.HR_EMP_FAMILY")

    res = vclient.post(f"/api/objects/{object_id}/join-check", json={})

    assert res.status_code == 200
    items = res.json()["results"]
    assert items, "픽스처에 조인 후보가 있어야 한다"
    for item in items:
        assert isinstance(item["src_column_id"], int)
        assert isinstance(item["tgt_column_id"], int)
```

`_seed` / `_object_id` / `vclient` 헬퍼는 이 파일에 이미 있는 것을 쓴다. 없으면 `test_validate_api.py`의 `_column_id` 패턴을 본떠 만든다.

Run: `cd backend && grep -n "^def _\|^@pytest.fixture" tests/test_join_check.py`

- [ ] **Step 2: 실패 확인**

Run: `cd backend && python3 -m pytest tests/test_join_check.py -v`
Expected: FAIL — `KeyError: 'src_column_id'`

- [ ] **Step 3: 응답에 id 추가**

`backend/app/api/join_check.py`의 `item` 딕셔너리를 교체한다.

```python
        item = {
            "target_object": cand.target.object_qname,
            "src_column": src_col.name, "tgt_column": cand.target.name,
            # 조인 빌더 딥링크용 — 이름만으로는 컬럼을 특정할 수 없다
            "src_column_id": src_col.column_id, "tgt_column_id": cand.target.column_id,
            "score": cand.score, "signals": cand.signals,
        }
```

- [ ] **Step 4: 통과 확인**

Run: `cd backend && python3 -m pytest tests/test_join_check.py -v && ruff check .`
Expected: PASS

- [ ] **Step 5: 잔존 T2/T3 문구 전수 확인**

Run: `cd frontend && grep -rn "T2\|T3\|전수 탐색" src --include="*.ts" --include="*.tsx" | grep -v ".test."`

- [ ] **Step 6: i18n 문구 교체**

`frontend/src/lib/i18n.ts`에서 아래 키의 값을 교체한다(키 이름은 유지 — 참조가 흩어져 있다).

```ts
  "panel.verify": { ko: "조인 검증", en: "Check join" },
  "joincheck.hint": {
    ko: "타깃 테이블별 최고 후보 컬럼 페어에 실데이터 포함률 검증을 일괄 실행합니다. 값 데이터가 없는 페어는 배지로만 표시됩니다.",
    en: "Runs containment on the best candidate pair per target table. Pairs without value data are just badged.",
  },
  "joincheck.title": { ko: "조인 가능성 찾기", en: "Find joinable tables" },
  "tip.joinCheck": {
    ko: "타깃 테이블별 최고 후보 컬럼 페어에 실데이터 포함률 검증을 일괄 실행합니다.",
    en: "Runs containment on the best candidate pair per target table.",
  },
  "detail.noValidated": {
    ko: "검증된 관계 없음 — ERD에서 조인을 만들어 발견하세요",
    en: "No validated relations — build a join in the ERD to discover them",
  },
  "joincheck.addToBuilder": { ko: "빌더에 추가", en: "Add to builder" },
```

기존 키 이름이 다르면 Step 5의 grep 결과에 맞춰 조정한다. `scan.button`·`scan.hint` 등 T3 전용 키는 `ColumnPanel` 삭제로 참조가 사라졌다 — `grep -rn '"scan\.' src`로 확인 후 미참조 키를 지운다.

- [ ] **Step 7: 프론트 타입에 컬럼 id 추가**

`/api/join-check` 응답 타입을 찾아 두 필드를 더한다.

Run: `cd frontend && grep -rn "target_object" src/lib/types.ts src/lib/api.ts src/components/browser/TableDetail.tsx`

해당 인터페이스에 추가한다.

```ts
  /** 조인 빌더 딥링크용 — 이름만으로는 컬럼을 특정할 수 없다 */
  src_column_id: number;
  tgt_column_id: number;
```

- [ ] **Step 8: `JoinCheckRow`에 빌더 진입 추가**

Run: `cd frontend && grep -n "function JoinCheckRow" -A 40 src/components/browser/TableDetail.tsx`

`JoinCheckRow`의 props에 `onOpenColumn: (columnId: number, columnName: string) => void`를 추가하고, `TableDetail`에서 이미 받고 있는 `onOpenColumn`을 그대로 내려준다. 행 우측에 버튼을 넣는다.

```tsx
              <button
                className="btn-secondary !py-0.5 text-xs"
                onClick={() => onOpenColumn(item.src_column_id, item.src_column)}
                data-testid={`TableDetail-addToBuilder-${item.target_object}`}
              >
                {t("joincheck.addToBuilder")}
              </button>
```

`onOpenColumn`은 Task 17에서 ERD 딥링크 이동으로 바뀌었으므로, 이 버튼 하나로 "발견 → 빌더" 경로가 이어진다.

- [ ] **Step 9: 프론트 검증**

Run: `cd frontend && npx tsc --noEmit && npx eslint src && npx vitest run`
Expected: 전부 통과

- [ ] **Step 10: 백엔드 전체 검증**

Run: `cd backend && python3 -m pytest && ruff check .`
Expected: 전부 통과

- [ ] **Step 11: PROGRESS 갱신 후 커밋**

`PROGRESS.md`의 `## 2026-08-05` 섹션 맨 위 항목을 Phase 1~5 전체 요약으로 정리한다(중간 단계 항목은 하나로 압축 — `rules/common/git.md`).

```bash
git add backend/app/api/join_check.py backend/tests/test_join_check.py \
        frontend/src/components/browser/TableDetail.tsx frontend/src/lib/types.ts \
        frontend/src/lib/i18n.ts PROGRESS.md
git commit -m "refactor(ui): drop T2/T3 tier names and route discovery into the builder — UI 계층 용어 제거 + 빌더 연결"
```

---

## 남은 수동 검증 (n8n 재배포 후)

코드로 검증할 수 없는 항목이다. Phase 4를 배포한 뒤 실서버에서 확인한다.

| 확인 | 방법 |
|------|------|
| W2 임포트 | n8n에 `n8n/workflows/w2_query_executor.json` 재임포트 → credentials 재설정 → 활성화 |
| 기존 kind 무회귀 | 테이블 미리보기·단일 페어 검증이 그대로 동작 (`_post_query`의 신·구 형태 양쪽 수용 확인) |
| N-웨이 실행 | ERD에서 3테이블 조인 → SQL 탭의 문장이 실제 스키마·별칭과 맞는가 |
| 마스킹 | `masking_policy`가 걸린 컬럼이 포함된 조인 → 해당 열이 `●●●`인가 |
| 감사 로그 | `audit_logs`에 `action='join_preview'` 행이 남는가 |
