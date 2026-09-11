# View Definition (뷰 쿼리 보기) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users read a view's SQL definition — from a value-probe hit on a view and from the table browser's view detail — with the hit column highlighted.

**Architecture:** The catalog already stores `CatalogObject.definition` (MSSQL `sys.sql_modules`, PG `pg_get_viewdef`, SQLite `sqlite_master`). One new read endpoint exposes it behind the hidden-schema gate (structure, not values → no preview allowlist, no audit, same as columns). One shared frontend panel component fetches and renders it through the existing `tokenizeSql` highlighter with an optional highlighted column and a copy button; the value-probe hit row and `TableDetail` both mount it.

**Tech Stack:** FastAPI / SQLAlchemy / pytest; Next.js 15 / TypeScript / vitest; headless Playwright for verification.

**Spec:** `docs/superpowers/specs/2026-09-10-value-probe-design.md` (§8 gains this button; user request on 2026-09-11, controller ruling: both surfaces).

## Global Constraints

- Hidden schemas: `is_schema_hidden(view.schema)` → 403, mirroring `get_object_preview`'s message style. Non-views → 404. A missing definition (permission-blocked at collection) is `definition: null`, not an error.
- The definition is metadata: no `is_preview_allowed`, no `AuditLog` (parity with column listing).
- Frontend: no `any`/`as`, `interface` props, named exports, `import type`, Korean why-comments, `data-testid` = `ComponentName-role`; ESLint/tsc/vitest clean (do not run `npm run build` while the dev server is up).
- Commit format and trailer lines as on this branch; PROGRESS line per commit; push after commit.
- Do not modify `PreviewSqlButton.tsx` (its token style map is duplicated into the new shared code component on purpose — two consumers, tiny map).

## File Structure

- Backend modify: `backend/app/api/views.py` (+ endpoint). Test create: `backend/tests/test_views_definition.py`.
- Frontend create: `frontend/src/components/SqlCode.tsx` (tokenized SQL block with optional highlight), `frontend/src/components/ViewDefinitionPanel.tsx` (fetch + header + copy + `SqlCode`), `frontend/src/lib/view-definition.ts` + `view-definition.test.ts` (pure highlight matching). Modify: `frontend/src/lib/api.ts`, `frontend/src/lib/i18n.ts`, `frontend/src/components/trace/ProbeHits.tsx`, `frontend/src/components/browser/TableDetail.tsx`.

---

### Task 15: Backend — `GET /api/views/{object_id}/definition`

**Files:**
- Modify: `backend/app/api/views.py`
- Test: `backend/tests/test_views_definition.py`

**Interfaces:**
- Consumes: `CatalogObject`, `is_schema_hidden` (`app.services.schema_visibility`).
- Produces: `GET /api/views/{object_id}/definition` → `{"object_id": int, "object": "schema.name", "definition": str | null, "parse_status": str | null}`; 404 `{"message": "view not found"}`; 403 hidden.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_views_definition.py
"""뷰 정의 SQL 조회 — 구조 정보이므로 숨김 스키마만 막는다. / view definition endpoint."""

import sqlalchemy as sa

from app.config import get_settings
from app.models import Base


def _seed(client, load_fixture) -> None:
    sid = client.post("/api/ingest/catalog", json=load_fixture("catalog.json")).json()["snapshot_id"]
    client.post("/api/ingest/view-deps",
                json={**load_fixture("view_deps.json"), "snapshot_id": sid})


def _object_ids(engine) -> tuple[int, int, int]:
    """(정의 있는 뷰, 정의 없는 뷰, 테이블) id / ids of a view with, a view without, and a table."""
    objects = Base.metadata.tables["objects"]
    with engine.connect() as conn:
        with_def = conn.execute(sa.select(objects.c.id).where(
            objects.c.type == "view", objects.c.definition.is_not(None)).limit(1)).scalar_one()
        without_def = conn.execute(sa.select(objects.c.id).where(
            objects.c.type == "view", objects.c.definition.is_(None)).limit(1)).scalar_one_or_none()
        table = conn.execute(sa.select(objects.c.id).where(objects.c.type == "table").limit(1)).scalar_one()
    return with_def, without_def, table


def test_returns_the_definition_for_a_view(client, load_fixture, migrated_engine):
    _seed(client, load_fixture)
    with_def, _, _ = _object_ids(migrated_engine)
    res = client.get(f"/api/views/{with_def}/definition")
    assert res.status_code == 200, res.json()
    body = res.json()
    assert body["object_id"] == with_def and "." in body["object"]
    assert body["definition"] and "SELECT" in body["definition"].upper()


def test_missing_definition_is_null_not_an_error(client, load_fixture, migrated_engine):
    _seed(client, load_fixture)
    _, without_def, _ = _object_ids(migrated_engine)
    if without_def is None:
        # 픽스처에 권한 차단 뷰가 없으면 하나 만든다 / synthesize a permission-blocked view
        with migrated_engine.begin() as conn:
            conn.execute(sa.text(
                "UPDATE objects SET definition = NULL WHERE id = (SELECT MIN(id) FROM objects WHERE type = 'view')"))
            without_def = conn.execute(sa.text(
                "SELECT MIN(id) FROM objects WHERE type = 'view'")).scalar_one()
    res = client.get(f"/api/views/{without_def}/definition")
    assert res.status_code == 200 and res.json()["definition"] is None


def test_table_is_404(client, load_fixture, migrated_engine):
    _seed(client, load_fixture)
    _, _, table = _object_ids(migrated_engine)
    assert client.get(f"/api/views/{table}/definition").status_code == 404
    assert client.get("/api/views/999999/definition").status_code == 404


def test_hidden_schema_is_403(client, load_fixture, migrated_engine, monkeypatch):
    _seed(client, load_fixture)
    with_def, _, _ = _object_ids(migrated_engine)
    monkeypatch.setattr(get_settings(), "hidden_schemas", "dbo")
    res = client.get(f"/api/views/{with_def}/definition")
    assert res.status_code == 403
    assert res.json()["error"]["context"]["schema"] == "dbo"
```

- [ ] **Step 2: Run to verify failure** — `cd backend && .venv/bin/python -m pytest tests/test_views_definition.py -q` → 404s (route missing).

- [ ] **Step 3: Add the endpoint to `backend/app/api/views.py`**

Add `from app.services.schema_visibility import is_schema_hidden` to the local imports, then:

```python
@router.get("/{object_id}/definition")
def get_view_definition(object_id: int, db: Session = Depends(get_db)) -> dict:
    """뷰 정의 SQL — 구조 정보라 미리보기 허용 목록·감사와 무관하지만, 숨김 스키마는 컬럼처럼 감춘다.

    definition이 NULL이면 수집 시 VIEW DEFINITION 권한이 없었던 것 — 오류가 아니라 상태다.
    / structure, not values: hidden-schema gate only; NULL means permission-blocked at collect time.
    """
    view = db.get(CatalogObject, object_id)
    if view is None or view.type != "view":
        raise HTTPException(404, {"message": "view not found", "context": {"object_id": object_id}})
    if is_schema_hidden(view.schema):
        raise HTTPException(403, {
            "message": "this schema is hidden — its columns and definitions are not served "
                       "(HIDDEN_SCHEMAS)",
            "context": {"object": f"{view.schema}.{view.name}", "schema": view.schema},
        })
    return {
        "object_id": view.id,
        "object": f"{view.schema}.{view.name}",
        "definition": view.definition,
        "parse_status": view.parse_status,
    }
```

- [ ] **Step 4: Run tests + ruff + full suite** — `cd backend && .venv/bin/python -m pytest tests/test_views_definition.py -q && .venv/bin/ruff check app tests && .venv/bin/python -m pytest tests -q`.

- [ ] **Step 5: Commit** — PROGRESS line: `- **뷰 정의 SQL API** — `GET /api/views/{id}/definition`. 구조 정보라 허용 목록·감사 없이 숨김 스키마만 403, 권한 차단으로 미수집이면 definition null.` Commit `feat(views): expose the stored view definition behind the hidden-schema gate — 뷰 정의 SQL API`; push.

---

### Task 16: Frontend — shared SQL panel, hit-row and detail buttons

**Files:**
- Create: `frontend/src/components/SqlCode.tsx`, `frontend/src/components/ViewDefinitionPanel.tsx`, `frontend/src/lib/view-definition.ts`, `frontend/src/lib/view-definition.test.ts`
- Modify: `frontend/src/lib/api.ts`, `frontend/src/lib/i18n.ts`, `frontend/src/components/trace/ProbeHits.tsx`, `frontend/src/components/browser/TableDetail.tsx`

**Interfaces:**
- Consumes: `tokenizeSql`, `copyTextToClipboard`, `SqlToken` from `@/lib/preview-utils`; `CodeIcon`, `CopyIcon`, `CloseIcon` from icons; Task 15 endpoint.
- Produces: `fetchViewDefinition(objectId): Promise<ViewDefinition>`; `markHitTokens(tokens, column) -> HighlightedToken[]`; `SqlCode({ sql, highlightColumn })`; `ViewDefinitionPanel({ objectId, qname, highlightColumn?, onClose? })`; testids `ProbeHits-definition-${key}` (button), `ProbeHits-definitionPanel-${key}`, `TableDetail-definitionButton`, `TableDetail-definitionPanel`, `ViewDefinitionPanel-root/code/copyButton/missing/error/loading`, `SqlCode-hit`.

- [ ] **Step 1: Failing vitest**

```ts
// frontend/src/lib/view-definition.test.ts
import { describe, expect, it } from "vitest";

import { tokenizeSql } from "./preview-utils";
import { markHitTokens, normalizeIdentifier } from "./view-definition";

describe("normalizeIdentifier", () => {
  it("strips quoting and qualifiers so a.[APRV_CD] matches APRV_CD", () => {
    expect(normalizeIdentifier("a.[APRV_CD]")).toBe("aprv_cd");
    expect(normalizeIdentifier('"Aprv_Cd"')).toBe("aprv_cd");
    expect(normalizeIdentifier("dbo.T_ORD")).toBe("t_ord");
  });
});

describe("markHitTokens", () => {
  it("flags identifier tokens equal to the hit column, case-insensitively", () => {
    const tokens = tokenizeSql("SELECT a.APRVCD AS related_cd, b.ItemCd FROM dbo.APV_APRV a");
    const marked = markHitTokens(tokens, "aprvcd");
    const hits = marked.filter((tk) => tk.hit).map((tk) => tk.text);
    expect(hits).toEqual(["a.APRVCD"]);
  });

  it("marks nothing without a column", () => {
    const tokens = tokenizeSql("SELECT 1");
    expect(markHitTokens(tokens, null).some((tk) => tk.hit)).toBe(false);
  });
});
```
(If `tokenizeSql` splits `a.APRVCD` into separate tokens, adjust the expected hit list to the identifier token text that carries `APRVCD` — the assertion is "exactly the tokens naming the hit column are flagged".)

- [ ] **Step 2: Helpers + API**

```ts
// frontend/src/lib/view-definition.ts
/** 뷰 정의 SQL 표시의 순수 로직 — 히트 컬럼 토큰 판별 / pure helpers for the definition panel. */

import type { SqlToken } from "@/lib/preview-utils";

export interface HighlightedToken extends SqlToken { hit: boolean }

/** 인용부호·별칭 접두를 벗기고 소문자로 — a.[APRV_CD] ↔ APRVCD 비교용 */
export function normalizeIdentifier(text: string): string {
  const last = text.split(".").pop() ?? text;
  return last.replace(/^[\[\"`]|[\]\"`]$/g, "").toLowerCase();
}

export function markHitTokens(tokens: SqlToken[], column: string | null): HighlightedToken[] {
  const target = column ? normalizeIdentifier(column) : null;
  return tokens.map((tk) => ({
    ...tk,
    hit: target !== null && tk.type === "identifier" && normalizeIdentifier(tk.text) === target,
  }));
}
```

`frontend/src/lib/api.ts` (after `fetchHiddenSchemas`):
```ts
export interface ViewDefinition {
  object_id: number;
  object: string;
  /** null = 수집 시 VIEW DEFINITION 권한이 없었다 / permission-blocked at collect time */
  definition: string | null;
  parse_status: string | null;
}

export function fetchViewDefinition(objectId: number): Promise<ViewDefinition> {
  return getJson(`/api/views/${objectId}/definition`);
}
```

- [ ] **Step 3: i18n keys**

```ts
  "viewdef.button": { ko: "쿼리 보기", en: "View SQL" },
  "viewdef.title": { ko: "뷰 정의 SQL", en: "View definition" },
  "viewdef.copy": { ko: "복사", en: "Copy" },
  "viewdef.copied": { ko: "복사됨", en: "Copied" },
  "viewdef.copyFailed": { ko: "복사 실패", en: "Copy failed" },
  "viewdef.missing": { ko: "정의가 수집되지 않았다 — 원본 DB의 VIEW DEFINITION 권한 확인", en: "Definition not collected — check VIEW DEFINITION permission on the source" },
  "viewdef.loading": { ko: "불러오는 중…", en: "Loading…" },
  "viewdef.hitColumn": { ko: "히트 컬럼", en: "hit column" },
  "viewdef.close": { ko: "닫기", en: "Close" },
```

- [ ] **Step 4: `SqlCode.tsx`**

```tsx
"use client";

/** 토큰 색을 입힌 SQL 블록 — 히트 컬럼 토큰은 배경으로 표시 / tokenized SQL with an optional hit mark. */

import type { CSSProperties } from "react";

import { tokenizeSql, type SqlToken } from "@/lib/preview-utils";
import { markHitTokens } from "@/lib/view-definition";

// PreviewSqlButton과 같은 색 규칙 — 소비자가 둘이라 작은 표를 나눠 갖는다 / same palette as the preview SQL
const TOKEN_STYLES: Record<SqlToken["type"], CSSProperties> = {
  keyword: { color: "var(--obj-view)", fontWeight: 600 },
  identifier: { color: "var(--ink)" },
  string: { color: "var(--rel-confirmed)" },
  number: { color: "var(--rel-ai)" },
  plain: { color: "var(--slate)" },
};

interface SqlCodeProps {
  sql: string;
  highlightColumn?: string | null;
}

export function SqlCode({ sql, highlightColumn = null }: SqlCodeProps) {
  const tokens = markHitTokens(tokenizeSql(sql), highlightColumn);
  return (
    <pre className="scroll-area m-0 max-h-[50vh] overflow-auto whitespace-pre-wrap rounded p-3 font-mono text-xs leading-relaxed"
         style={{ background: "var(--surface-elevated)" }} data-testid="SqlCode-root">
      {tokens.map((tk, index) => (
        <span key={index} style={tk.hit
          ? { ...TOKEN_STYLES[tk.type], background: "color-mix(in srgb, var(--primary) 35%, transparent)", borderRadius: 3 }
          : TOKEN_STYLES[tk.type]}
          data-testid={tk.hit ? "SqlCode-hit" : undefined}>
          {tk.text}
        </span>
      ))}
    </pre>
  );
}
```

- [ ] **Step 5: `ViewDefinitionPanel.tsx`**

Props `{ objectId: number; qname: string; highlightColumn?: string | null; onClose?: () => void }`. On mount (effect keyed on `objectId`) call `fetchViewDefinition`; states `loading | error | data`. Render `<section className="card mt-2 p-3" data-testid="ViewDefinitionPanel-root">` with a header row: `<CodeIcon size={12} />` + `t("viewdef.title")` + `<code>{qname}</code>` + (highlightColumn ? `key-chip` with `t("viewdef.hitColumn")`: column : null) + right side: copy button (`icon-button`, `CopyIcon`, `data-testid="ViewDefinitionPanel-copyButton"`, disabled without definition; on click `copyTextToClipboard(definition)` → transient label `viewdef.copied` / `viewdef.copyFailed` for 1.5 s) + optional close (`CloseIcon`, `onClose`). Body: loading → `<div className="skeleton h-16" data-testid="ViewDefinitionPanel-loading" />`; error → `<p style={{ color: "var(--error)" }} data-testid="ViewDefinitionPanel-error">{message}</p>` (use a `toErrorMessage`-style `instanceof Error` guard); `definition === null` → `<p className="hint-pill" data-testid="ViewDefinitionPanel-missing">{t("viewdef.missing")}</p>`; else `<SqlCode sql={definition} highlightColumn={highlightColumn} />` inside `data-testid="ViewDefinitionPanel-code"`.

- [ ] **Step 6: Mount points**

`ProbeHits.tsx`: keep `openPanels` state (`Set<string>` of hit keys). For `hit.object_type === "view"` render, after the preview link, a `btn-secondary` button `<CodeIcon size={12} /> {t("viewdef.button")}` (`data-testid={`ProbeHits-definition-${key}`}`, `aria-expanded`) toggling the key; when open render `<div className="w-full" data-testid={`ProbeHits-definitionPanel-${key}`}><ViewDefinitionPanel objectId={hit.object_id} qname={hit.qname} highlightColumn={hit.column} onClose={…} /></div>` inside the `<li>`.

`TableDetail.tsx`: in the actions row (`mb-7 flex flex-wrap gap-3`, after the ERD button) add, for `detail.type === "view"`, `<button className="btn-secondary" onClick={() => setShowDefinition((v) => !v)} disabled={detail.hidden} title={detail.hidden ? t("detail.hiddenHint") : undefined} data-testid="TableDetail-definitionButton" aria-expanded={showDefinition}><CodeIcon … /> {t("viewdef.button")}</button>` (if a `detail.hiddenHint`-style key does not exist, reuse the message key the component already shows for hidden schemas; check the file). Directly below the actions row render `{showDefinition && detail.type === "view" && (<div className="mb-7" data-testid="TableDetail-definitionPanel"><ViewDefinitionPanel objectId={detail.id} qname={`${schema}.${detail.name}`} onClose={() => setShowDefinition(false)} /></div>)}` — `ObjectDetail` has `name` but check whether it carries `schema`; if not, pass the qname from the selected `ObjectSummary` the page already has (`TableDetail` receives `detail` only — look at how the sticky header prints the name; if only `detail.name` is available, show `detail.name`). Reset `showDefinition` when `detail.id` changes (effect).

- [ ] **Step 7: Verify** — `cd frontend && npx tsc --noEmit && npm run lint && npm test` (no build).

- [ ] **Step 8: Commit** — PROGRESS line: `- **뷰 쿼리 보기** — 값 추적 히트(뷰)와 테이블 상세(뷰)에 「쿼리 보기」. 공용 ViewDefinitionPanel이 정의 SQL을 토큰 색으로 보여주고 히트 컬럼을 강조, 복사 버튼, 미수집이면 안내. README 화면 절 갱신.` Also update README's `/trace` bullet with one clause about 쿼리 보기 for view hits. Commit `feat(views): show a view's SQL from value-probe hits and the detail pane — 뷰 쿼리 보기`; push.

---

### Task 17: Verification (controller)

Headless Playwright: (a) table browser — open a fixture view (`/?table=<view id>`), click `TableDetail-definitionButton`, expect `ViewDefinitionPanel-code` with SQL text and copy button; (b) value probe — add a value set for `OTHER.V_RELATED.RELATED_CD` to the local `fixtures/value_sets.json` (git-ignored), allowlist `OTHER`, run with the related switch on → the view hit shows `ProbeHits-definition-OTHER.V_RELATED.RELATED_CD`; click → panel with `SqlCode-hit` on `RELATED_CD`/`APRVCD`. Screenshots; PROGRESS line; commit.
