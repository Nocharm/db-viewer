# Value Probe Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the "related views from other schemas" option to value probe, turn the find button into a live progress/stop control, and restyle the `/trace` page's controls and copy with the design tokens.

**Architecture:** Backend gains one request flag and three job columns; the planner accepts extra view object ids found through `ViewLineageFlat` and the same hidden/allowlist gates decide per view schema whether they may be probed. The frontend replaces native checkboxes/radios with token-styled controls (global CSS), makes the find button carry a spinner + inline progress bar and flip to "중단" on hover, shows policy-excluded views behind an ⓘ tooltip, and rewrites card copy as noun phrases with icon pills.

**Tech Stack:** Python 3.12 / FastAPI / SQLAlchemy 2.0 / Alembic / pytest; Next.js 15 / TypeScript / Tailwind v4 + global CSS / vitest; headless Playwright (npx cache) for verification.

**Spec:** `docs/superpowers/specs/2026-09-10-value-probe-design.md` (this plan extends §5, §6, §8; the user approved the three changes in chat on 2026-09-11).

## Global Constraints

- Every raw-value read stays behind `is_schema_hidden` → `is_preview_allowed` per schema. A related view is probed only when ITS schema passes both; otherwise it is reported as skipped with the reason (`hidden` | `not_allowed`), never silently dropped and never probed.
- Backend commands from `backend/`: `.venv/bin/python -m pytest tests -q`, `.venv/bin/ruff check app alembic tests`. Frontend from `frontend/`: `npm test`, `npm run lint`, `npx tsc --noEmit`, `npm run build`.
- Commit message `type(scope): English summary — 한국어 요약` ending with the two trailer lines used on this branch (`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01QSWKWS5ScUzYKsqY9kExzK`); PROGRESS.md line under `## 2026-09-10` before each commit; `git push` after each commit.
- TS: no `any`, no `as` where a guard is possible, `interface` props, named exports, `import type`; comments explain why (Korean), identifiers English; `data-testid` = `ComponentName-role`.
- Existing behaviour that must not change: `/trace` without the new flag behaves exactly as before; existing tests keep passing.

## File Structure

- Backend modify: `backend/app/models/value_probe.py` (3 job columns), `backend/alembic/versions/0019_value_probe_related_views.py` (create), `backend/app/services/value_probe.py` (`RelatedViews`, `find_related_views`, `extra_object_ids` in `load_probe_catalog`/`build_plan`, gate over related schemas), `backend/app/api/value_probe.py` (request flag, plan/GET fields, gate lists), tests `backend/tests/test_value_probe_api.py`, `backend/tests/test_value_probe_service.py`.
- Frontend modify: `frontend/src/app/globals.css` (control + pill classes, spinner), `frontend/src/components/icons.tsx` (`SpinnerIcon`, `StopIcon`, `TableIcon`, `ViewIcon`), `frontend/src/components/InfoTip.tsx` (rich content), `frontend/src/lib/api.ts`, `frontend/src/lib/value-probe.ts` + test, `frontend/src/lib/i18n.ts`, `frontend/src/components/trace/ProbeForm.tsx`, `ProbeProgress.tsx`, `ProbeHits.tsx`, `ProbeHeavyList.tsx`, `frontend/src/app/trace/page.tsx`.

---

### Task 12: Backend — related views option

**Files:**
- Modify: `backend/app/models/value_probe.py`, `backend/app/services/value_probe.py`, `backend/app/api/value_probe.py`
- Create: `backend/alembic/versions/0019_value_probe_related_views.py`
- Test: `backend/tests/test_value_probe_api.py`, `backend/tests/test_value_probe_service.py` (append)

**Interfaces:**
- Consumes: `ViewLineageFlat`, `CatalogObject`, `is_schema_hidden`, `is_preview_allowed`, existing `load_probe_catalog`/`build_plan`/`_check_schema_gates`.
- Produces:
  - `ValueProbeJob.include_related_views: bool`, `related_schemas: str` (JSON list), `related_skipped: str` (JSON list of `{qname, schema, reason}`).
  - `find_related_views(db, snapshot_id, schemas, source_id) -> RelatedViews(object_ids, schemas, skipped)`.
  - `load_probe_catalog(db, snapshot_id, schemas, extra_object_ids=())`, `build_plan(db, snapshot_id, schemas, engine, value, mode, hint, settings, extra_object_ids=())`.
  - Request `include_related_views: bool = False`; POST response `plan.related_views = {"included": n, "skipped": [...]}`; GET adds `include_related_views`, `related_schemas`, `related_view_skipped`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_value_probe_api.py`:

```python
from datetime import UTC, datetime

from app.models import CatalogColumn, ViewLineageFlat


def _add_related_view(migrated_engine, sid: int, schema: str = "OTHER") -> int:
    """다른 스키마에서 dbo.APV_APRV.APRVCD를 읽는 뷰 1개 + lineage / a view in another schema."""
    now = datetime.now(UTC)
    with sessionmaker(bind=migrated_engine)() as db:
        base = db.execute(sa.select(CatalogObject).where(
            CatalogObject.snapshot_id == sid, CatalogObject.schema == "dbo",
            CatalogObject.name == "APV_APRV")).scalar_one()
        view = CatalogObject(snapshot_id=sid, schema=schema, name="V_RELATED", type="view",
                             object_id=990001, row_count=None,
                             definition="SELECT APRVCD AS RELATED_CD FROM dbo.APV_APRV",
                             dmv_unresolved=False)
        db.add(view)
        db.flush()
        db.add(CatalogColumn(object_id=view.id, name="RELATED_CD", ordinal=1, data_type="int",
                             max_length=4, is_nullable=True, is_pk=False, is_computed=False))
        db.add(ViewLineageFlat(snapshot_id=sid, view_object_id=view.id, view_column="RELATED_CD",
                               base_object_id=base.id, base_column="APRVCD", depth=1,
                               mapping_kind="derived", flag=None))
        db.commit()
        return view.id


def test_related_views_are_off_by_default(pclient, load_fixture, allow_preview, migrated_engine):
    sid = _seed(pclient, load_fixture)
    allow_preview("dbo.X")
    _add_related_view(migrated_engine, sid)
    _, _, value = _known_value(load_fixture)
    res = _start(pclient, value)
    assert res.json()["plan"]["related_views"] == {"included": 0, "skipped": []}
    job = pclient.get(f"/api/value-probe/{res.json()['job_id']}").json()
    assert job["include_related_views"] is False and job["related_schemas"] == []


def test_related_view_outside_the_allowlist_is_reported_not_probed(pclient, load_fixture, allow_preview, migrated_engine):
    sid = _seed(pclient, load_fixture)
    allow_preview("dbo.X")
    _add_related_view(migrated_engine, sid)
    _, _, value = _known_value(load_fixture)
    res = _start(pclient, value, include_related_views=True)
    assert res.status_code == 202, res.json()
    plan = res.json()["plan"]["related_views"]
    assert plan == {"included": 0, "skipped": [
        {"qname": "OTHER.V_RELATED", "schema": "OTHER", "reason": "not_allowed"}]}
    with migrated_engine.connect() as conn:
        probed = conn.execute(sa.text(
            "SELECT COUNT(*) FROM value_probe_targets WHERE job_id = :j AND qname = 'OTHER.V_RELATED'"
        ), {"j": res.json()["job_id"]}).scalar_one()
    assert probed == 0
    job = pclient.get(f"/api/value-probe/{res.json()['job_id']}").json()
    assert job["related_view_skipped"][0]["reason"] == "not_allowed"


def test_hidden_related_view_schema_is_reported_as_hidden(pclient, load_fixture, allow_preview, migrated_engine, monkeypatch):
    sid = _seed(pclient, load_fixture)
    allow_preview("dbo.X", "OTHER.X")
    _add_related_view(migrated_engine, sid)
    monkeypatch.setattr(get_settings(), "hidden_schemas", "other")
    _, _, value = _known_value(load_fixture)
    res = _start(pclient, value, include_related_views=True)
    assert res.json()["plan"]["related_views"]["skipped"][0]["reason"] == "hidden"


def test_allowed_related_view_joins_the_plan_and_the_gates(pclient, load_fixture, allow_preview, migrated_engine):
    sid = _seed(pclient, load_fixture)
    allow_preview("dbo.X", "OTHER.X")
    _add_related_view(migrated_engine, sid)
    _, _, value = _known_value(load_fixture)
    res = _start(pclient, value, include_related_views=True)
    assert res.json()["plan"]["related_views"] == {"included": 1, "skipped": []}
    job_id = res.json()["job_id"]
    with migrated_engine.connect() as conn:
        target = conn.execute(sa.text(
            "SELECT tier, object_type FROM value_probe_targets WHERE job_id = :j AND qname = 'OTHER.V_RELATED'"
        ), {"j": job_id}).one()
    assert target.object_type == "view"
    job = pclient.get(f"/api/value-probe/{job_id}").json()
    assert job["related_schemas"] == ["OTHER"] and job["include_related_views"] is True
    # 감사 로그에 연관 뷰 포함/제외 수가 남는다 / audit carries the related-view counts
    with migrated_engine.connect() as conn:
        detail = conn.execute(sa.text(
            "SELECT detail FROM audit_logs WHERE action = 'value_probe' ORDER BY id DESC LIMIT 1"
        )).scalar_one()
    assert "related_views=+1/-0" in detail


def test_runner_gate_covers_related_schemas(pclient, load_fixture, allow_preview, migrated_engine, monkeypatch):
    sid = _seed(pclient, load_fixture)
    allow_preview("dbo.X", "OTHER.X")
    _add_related_view(migrated_engine, sid)
    _, _, value = _known_value(load_fixture)
    monkeypatch.setattr(get_settings(), "value_probe_max_concurrent", 0)  # 큐에 머문다
    job_id = _start(pclient, value, include_related_views=True).json()["job_id"]
    with migrated_engine.begin() as conn:
        conn.execute(sa.text("DELETE FROM preview_allowlist WHERE data_source_id = 1 AND schema = 'OTHER'"))
    monkeypatch.setattr(get_settings(), "value_probe_max_concurrent", 1)
    job = pclient.get(f"/api/value-probe/{job_id}").json()
    assert job["status"] == "failed" and job["error"] == "schema gate revoked"
```

Update the `_start` helper in that file to forward extra fields: `def _start(client, value, schemas=("dbo",), **extra)` already spreads `**extra` into the JSON body — confirm it does; if it was written otherwise, make it `json={"source_id": 1, "schemas": list(schemas), "value": value, **extra}`.

Append to `backend/tests/test_value_probe_service.py`:

```python
def test_find_related_views_respects_hidden_and_allowlist(client, migrated_engine, load_fixture, monkeypatch):
    sid = _seed(client, load_fixture)
    from datetime import UTC, datetime

    from app.models import CatalogColumn, CatalogObject, PreviewAllowlist, ViewLineageFlat
    now = datetime.now(UTC)
    with sessionmaker(bind=migrated_engine)() as db:
        base = db.execute(sa.select(CatalogObject).where(
            CatalogObject.snapshot_id == sid, CatalogObject.schema == "dbo",
            CatalogObject.name == "APV_APRV")).scalar_one()
        for schema, name in (("ALLOWED", "V_A"), ("BLOCKED", "V_B"), ("HIDDEN", "V_H")):
            view = CatalogObject(snapshot_id=sid, schema=schema, name=name, type="view",
                                 object_id=hash((schema, name)) % 10_000_000, row_count=None,
                                 definition="SELECT APRVCD FROM dbo.APV_APRV", dmv_unresolved=False)
            db.add(view)
            db.flush()
            db.add(CatalogColumn(object_id=view.id, name="APRVCD", ordinal=1, data_type="int",
                                 max_length=4, is_nullable=True, is_pk=False, is_computed=False))
            db.add(ViewLineageFlat(snapshot_id=sid, view_object_id=view.id, view_column="APRVCD",
                                   base_object_id=base.id, base_column="APRVCD", depth=1,
                                   mapping_kind="direct", flag=None))
        db.add(PreviewAllowlist(data_source_id=MANAGED_MSSQL_SOURCE_ID, schema="ALLOWED",
                                note=None, added_by="test", created_at=now))
        db.add(PreviewAllowlist(data_source_id=MANAGED_MSSQL_SOURCE_ID, schema="HIDDEN",
                                note=None, added_by="test", created_at=now))
        db.commit()
    monkeypatch.setattr(get_settings(), "hidden_schemas", "hidden")

    with sessionmaker(bind=migrated_engine)() as db:
        related = service.find_related_views(db, sid, ["dbo"], MANAGED_MSSQL_SOURCE_ID)
    assert related.schemas == ("ALLOWED",)
    assert len(related.object_ids) == 1
    assert sorted(s["reason"] for s in related.skipped) == ["hidden", "not_allowed"]
    assert {s["qname"] for s in related.skipped} == {"BLOCKED.V_B", "HIDDEN.V_H"}
```
(`get_settings` import: add `from app.config import get_settings` at the top of that test file if missing.)

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && .venv/bin/python -m pytest tests/test_value_probe_api.py tests/test_value_probe_service.py -q -k "related"`
Expected: FAIL (`AttributeError: ... find_related_views` / KeyError `related_views`).

- [ ] **Step 3: Model + migration**

Add to `ValueProbeJob` in `backend/app/models/value_probe.py`, after `cancel_requested`:

```python
    # 연관 뷰 옵션 — 선택 스키마 밖에서 lineage로 찾아 자동 포함한 스키마와, 정책(숨김·허용 목록)
    # 때문에 제외한 뷰 목록(JSON). 실행 직전 게이트 재검사가 related_schemas까지 본다.
    # / related-view option: auto-included schemas and policy-skipped views (JSON)
    include_related_views: Mapped[bool] = mapped_column(Boolean, server_default=false())
    related_schemas: Mapped[str] = mapped_column(Text, server_default="[]")
    related_skipped: Mapped[str] = mapped_column(Text, server_default="[]")
```

Create `backend/alembic/versions/0019_value_probe_related_views.py`:

```python
"""Value probe: related-view option columns (값 추적 연관 뷰 옵션).

Revision ID: 0019
Revises: 0018
Create Date: 2026-09-11

선택 스키마 밖의 뷰를 lineage로 찾아 포함할 때, 자동 포함된 스키마와 정책으로 제외된 뷰를
잡 행에 남긴다 — 실행 직전 게이트 재검사와 화면 표시의 근거다.
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "0019"
down_revision: Union[str, None] = "0018"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("value_probe_jobs") as batch:
        batch.add_column(sa.Column("include_related_views", sa.Boolean(), nullable=False,
                                   server_default=sa.false()))
        batch.add_column(sa.Column("related_schemas", sa.Text(), nullable=False,
                                   server_default="[]"))
        batch.add_column(sa.Column("related_skipped", sa.Text(), nullable=False,
                                   server_default="[]"))


def downgrade() -> None:
    with op.batch_alter_table("value_probe_jobs") as batch:
        batch.drop_column("related_skipped")
        batch.drop_column("related_schemas")
        batch.drop_column("include_related_views")
```

- [ ] **Step 4: Service**

In `backend/app/services/value_probe.py`:

1. Imports: add `from dataclasses import dataclass`, `from sqlalchemy import or_, select` (replace the existing `select` import), and `from app.services.preview_policy import is_preview_allowed` / `from app.services.schema_visibility import get_hidden_schemas, is_schema_hidden` (the runner gate already imports these — merge, don't duplicate).

2. Add after `SOURCE_ERRORS`:

```python
@dataclass(frozen=True)
class RelatedViews:
    """선택 스키마 밖에서 찾은 연관 뷰 — 포함할 객체 id, 그 스키마, 정책으로 제외한 목록."""

    object_ids: tuple[int, ...]
    schemas: tuple[str, ...]
    skipped: tuple[dict, ...]


def find_related_views(
    db: Session, snapshot_id: int, schemas: list[str], source_id: int,
) -> RelatedViews:
    """선택 스키마의 객체를 lineage로 읽는 다른 스키마의 뷰.

    값을 실제로 읽는 대상이므로 그 뷰의 스키마도 숨김이 아니고 허용 목록에 있어야 한다.
    조건에 안 맞는 뷰는 조용히 빼지 않고 사유와 함께 돌려준다 — 화면이 ⓘ로 보여준다.
    """
    base_obj = aliased(CatalogObject)
    view_obj = aliased(CatalogObject)
    rows = db.execute(
        select(view_obj.id, view_obj.schema, view_obj.name).distinct()
        .join(ViewLineageFlat, ViewLineageFlat.view_object_id == view_obj.id)
        .join(base_obj, base_obj.id == ViewLineageFlat.base_object_id)
        .where(ViewLineageFlat.snapshot_id == snapshot_id, view_obj.type == "view",
               base_obj.schema.in_(schemas), view_obj.schema.notin_(schemas))
        .order_by(view_obj.schema, view_obj.name)
    ).all()
    object_ids: list[int] = []
    included: list[str] = []
    skipped: list[dict] = []
    for view_id, schema, name in rows:
        qname = f"{schema}.{name}"
        if is_schema_hidden(schema):
            skipped.append({"qname": qname, "schema": schema, "reason": "hidden"})
        elif not is_preview_allowed(db, source_id, schema):
            skipped.append({"qname": qname, "schema": schema, "reason": "not_allowed"})
        else:
            object_ids.append(view_id)
            if schema not in included:
                included.append(schema)
    return RelatedViews(tuple(object_ids), tuple(included), tuple(skipped))
```

3. `load_probe_catalog(db, snapshot_id, schemas, extra_object_ids: tuple[int, ...] | list[int] = ())`: build `scope = CatalogObject.schema.in_(wanted)` and, when `extra_object_ids` is non-empty, `scope = or_(scope, CatalogObject.id.in_(list(extra_object_ids)))`; use `scope` in the objects query and the columns query (the columns query joins `CatalogObject`, so the same expression applies). In the lineage query use `or_(view_obj.schema.in_(wanted), view_obj.id.in_(list(extra_object_ids)))` when extra ids exist, else the existing filter. Early return `[] , {}` only when `wanted` is empty AND no extra ids.

4. `build_plan(..., settings, extra_object_ids=())` forwards to `load_probe_catalog`.

5. Runner gate (`_execute_probe` first session): compute `gate_schemas = json.loads(job.schemas) + json.loads(job.related_schemas or "[]")` and check every one (existing loop).

- [ ] **Step 5: API**

In `backend/app/api/value_probe.py`:

1. `ValueProbeRequest` gains `include_related_views: bool = False`.
2. In `start_value_probe`, after `_check_schema_gates(...)` and before `build_plan`:
```python
    related = (find_related_views(db, snapshot.id, schemas, source.id)
               if req.include_related_views else RelatedViews((), (), ()))
    targets = build_plan(db, snapshot.id, schemas, source.engine, value, req.mode, req.hint,
                         settings, extra_object_ids=related.object_ids)
```
   Job construction adds `include_related_views=req.include_related_views, related_schemas=json.dumps(list(related.schemas)), related_skipped=json.dumps(list(related.skipped))`. Audit detail appends ` related_views=+{len(related.object_ids)}/-{len(related.skipped)}` only when `req.include_related_views`. Response `plan` adds `"related_views": {"included": len(related.object_ids), "skipped": list(related.skipped)}`.
3. Import `RelatedViews, find_related_views` from `app.services.value_probe`.
4. `run_heavy_targets`: `_check_schema_gates(db, job.data_source_id, json.loads(job.schemas) + json.loads(job.related_schemas or "[]"))`.
5. GET response adds `"include_related_views": job.include_related_views, "related_schemas": json.loads(job.related_schemas or "[]"), "related_view_skipped": json.loads(job.related_skipped or "[]")`.

- [ ] **Step 6: Run tests + ruff, then the full suite**

Run: `cd backend && .venv/bin/python -m pytest tests/test_value_probe_api.py tests/test_value_probe_service.py tests/test_value_probe_models.py -q && .venv/bin/ruff check app alembic tests && .venv/bin/python -m pytest tests -q`
Expected: all PASS.

- [ ] **Step 7: Commit**

PROGRESS line: `- **값 추적 연관 뷰 옵션(백엔드)** — `include_related_views`로 선택 스키마 밖에서 lineage로 읽는 뷰를 후보에 추가. 그 뷰의 스키마도 숨김·허용 목록 게이트를 통과해야 하며, 제외된 뷰는 사유(hidden/not_allowed)와 함께 응답·잡 행에 남긴다(0019). 실행 직전 게이트 재검사와 heavy 승격이 related_schemas까지 본다.`

```bash
git add backend/app/models/value_probe.py backend/alembic/versions/0019_value_probe_related_views.py backend/app/services/value_probe.py backend/app/api/value_probe.py backend/tests/test_value_probe_api.py backend/tests/test_value_probe_service.py PROGRESS.md
git commit -m "feat(value-probe): opt-in related views from other schemas behind the same gates — 연관 뷰 옵션"
git push
```

---

### Task 13: Frontend — token-styled controls, live find button, related views, copy

**Files:**
- Modify: `frontend/src/app/globals.css`, `frontend/src/components/icons.tsx`, `frontend/src/components/InfoTip.tsx`, `frontend/src/lib/api.ts`, `frontend/src/lib/value-probe.ts`, `frontend/src/lib/value-probe.test.ts`, `frontend/src/lib/i18n.ts`, `frontend/src/components/trace/ProbeForm.tsx`, `ProbeProgress.tsx`, `ProbeHits.tsx`, `ProbeHeavyList.tsx`, `frontend/src/app/trace/page.tsx`

**Interfaces:**
- Consumes: Task 12 JSON (`include_related_views`, `plan.related_views`, `related_view_skipped`, `related_schemas`).
- Produces: CSS classes `.ctl-check`, `.ctl-radio`, `.ctl-switch`, `.choice-pill`, `.stat-pill`, `.btn-progress`, `.spin`; icons `SpinnerIcon`, `StopIcon`, `TableIcon`, `ViewIcon`; `InfoTip` accepts `children`; helper `describeSkippedView(item, t)`; testids `ProbeForm-relatedSwitch`, `ProbeForm-stopButton`, `ProbeProgress-relatedSkippedTip`, `ProbeProgress-stat-candidates|columns|heavy|related`.

- [ ] **Step 1: Failing vitest for the new helper**

Append to `frontend/src/lib/value-probe.test.ts`:

```ts
import { describeSkippedView, findButtonLabel } from "./value-probe";

describe("describeSkippedView", () => {
  it("names the view and the policy reason", () => {
    expect(describeSkippedView({ qname: "SAP.V_X", schema: "SAP", reason: "not_allowed" }, "ko"))
      .toBe("SAP.V_X — 허용 목록 밖");
    expect(describeSkippedView({ qname: "HR.V_Y", schema: "HR", reason: "hidden" }, "en"))
      .toBe("HR.V_Y — hidden schema");
  });
});

describe("findButtonLabel", () => {
  it("shows progress while running and stop on hover", () => {
    expect(findButtonLabel({ running: false, hovering: false, done: 0, total: 0 })).toBe("find");
    expect(findButtonLabel({ running: true, hovering: false, done: 12, total: 422 })).toBe("progress");
    expect(findButtonLabel({ running: true, hovering: true, done: 12, total: 422 })).toBe("stop");
  });
});
```

Run: `cd frontend && npm test -- value-probe` → FAIL (missing exports).

- [ ] **Step 2: Helpers + API types**

`frontend/src/lib/value-probe.ts` — add:

```ts
export interface SkippedRelatedView { qname: string; schema: string; reason: "hidden" | "not_allowed" }

const SKIP_REASON: Record<SkippedRelatedView["reason"], { ko: string; en: string }> = {
  hidden: { ko: "숨김 스키마", en: "hidden schema" },
  not_allowed: { ko: "허용 목록 밖", en: "not on the preview allowlist" },
};

/** ⓘ 말풍선 한 줄 — 뷰 이름과 정책 사유 / one tooltip line: view + policy reason. */
export function describeSkippedView(item: SkippedRelatedView, lang: "ko" | "en"): string {
  return `${item.qname} — ${SKIP_REASON[item.reason][lang]}`;
}

export type FindButtonMode = "find" | "progress" | "stop";

/** 찾기 버튼의 세 얼굴 — 대기·진행·중단(호버) / the find button's three states. */
export function findButtonLabel(state: { running: boolean; hovering: boolean; done: number; total: number }): FindButtonMode {
  if (!state.running) return "find";
  return state.hovering ? "stop" : "progress";
}
```

`frontend/src/lib/api.ts` — `ValueProbeRequest` gains `include_related_views?: boolean`; `ValueProbeStart.plan` gains `related_views: { included: number; skipped: SkippedRelatedView[] }` (import the type from `@/lib/value-probe` — or define `SkippedRelatedView` in `api.ts` and re-export from `value-probe.ts`; pick `api.ts` as the owner to avoid a cycle: define it in `api.ts`, and in `value-probe.ts` `import type { SkippedRelatedView } from "@/lib/api"` and `export type { SkippedRelatedView }`); `ValueProbeJob` gains `include_related_views: boolean; related_schemas: string[]; related_view_skipped: SkippedRelatedView[]`.

Run: `npm test -- value-probe` → PASS.

- [ ] **Step 3: Global CSS — controls, pills, spinner**

Append to `frontend/src/app/globals.css` (after the `.hint-pill` block):

```css
/* ── 값 추적 폼 컨트롤 — 브라우저 기본 체크박스·라디오·토글 대신 토큰으로 그린다
   / token-drawn form controls: same ink, hairline and primary as the rest of the UI */
.ctl-check,
.ctl-radio {
  appearance: none;
  width: 16px;
  height: 16px;
  margin: 0;
  flex: none;
  border: 1.5px solid var(--hairline-strong);
  background: var(--surface-card);
  cursor: pointer;
  position: relative;
  transition: background-color 0.12s ease-in-out, border-color 0.12s ease-in-out;
}
.ctl-check { border-radius: 4px; }
.ctl-radio { border-radius: 999px; }
.ctl-check:checked,
.ctl-radio:checked { border-color: var(--primary); background: var(--primary); }
.ctl-check:checked::after {
  content: "";
  position: absolute;
  left: 4.5px;
  top: 1.5px;
  width: 5px;
  height: 9px;
  border: solid var(--on-primary);
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
.ctl-radio:checked::after {
  content: "";
  position: absolute;
  inset: 4px;
  border-radius: 999px;
  background: var(--on-primary);
}
.ctl-check:focus-visible,
.ctl-radio:focus-visible,
.ctl-switch:focus-visible { outline: 2px solid var(--focus-blue); outline-offset: 2px; }
.ctl-check:disabled,
.ctl-radio:disabled,
.ctl-switch:disabled { opacity: 0.5; cursor: not-allowed; }

.ctl-switch {
  appearance: none;
  width: 34px;
  height: 18px;
  margin: 0;
  flex: none;
  border-radius: 999px;
  border: 1.5px solid var(--hairline-strong);
  background: var(--surface-elevated);
  cursor: pointer;
  position: relative;
  transition: background-color 0.15s ease-in-out, border-color 0.15s ease-in-out;
}
.ctl-switch::before {
  content: "";
  position: absolute;
  top: 1.5px;
  left: 1.5px;
  width: 12px;
  height: 12px;
  border-radius: 999px;
  background: var(--slate);
  transition: transform 0.15s ease-in-out, background-color 0.15s ease-in-out;
}
.ctl-switch:checked { background: var(--primary); border-color: var(--primary); }
.ctl-switch:checked::before { transform: translateX(16px); background: var(--on-primary); }

/* 선택형 필 — 체크박스/라디오를 감싸는 라벨. 선택되면 필 자체가 밝아진다 */
.choice-pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 12px;
  border: 1px solid var(--hairline-strong);
  border-radius: 999px;
  font-size: 13px;
  cursor: pointer;
  transition: background-color 0.12s ease-in-out, border-color 0.12s ease-in-out;
}
.choice-pill:has(input:checked) {
  border-color: var(--primary);
  background: color-mix(in srgb, var(--primary) 16%, var(--surface-card));
}
.choice-pill:has(input:disabled) { opacity: 0.6; cursor: not-allowed; }

/* 숫자 필 — 아이콘 + 라벨 + 숫자 / stat pill for plan counts */
.stat-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--surface-elevated);
  color: var(--body-text);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.stat-pill b { font-weight: 700; color: var(--ink); }

/* 찾기 버튼 안의 진척 바 — 버튼만 보고도 얼마나 남았는지 읽힌다 */
.btn-progress { position: relative; overflow: hidden; }
.btn-progress__fill {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 3px;
  background: var(--on-primary);
  opacity: 0.55;
  transition: width 0.3s ease-in-out;
}
.btn-stop {
  background: color-mix(in srgb, var(--error) 16%, var(--surface-card));
  color: var(--error);
  border-color: var(--error);
}

@keyframes spin { to { transform: rotate(360deg); } }
.spin { animation: spin 0.9s linear infinite; }  /* 전역 reduced-motion 가드가 멈춘다 */
```

(`--on-primary` exists — it is what `.btn-primary` uses for its text colour. If a token named differently is used there, use that one.)

- [ ] **Step 4: Icons + InfoTip**

`frontend/src/components/icons.tsx` — append four icons in the file's `Svg` style (24-viewBox, `stroke="currentColor"`, `strokeWidth={2}`, `strokeLinecap="round"`, `strokeLinejoin="round"`):

```tsx
export function SpinnerIcon(props: IconProps) {
  return <Svg {...props}><path d="M12 3a9 9 0 1 0 9 9" /></Svg>;
}
export function StopIcon(props: IconProps) {
  return <Svg {...props}><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" /></Svg>;
}
export function TableIcon(props: IconProps) {
  return <Svg {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 10v10" /></Svg>;
}
export function ViewIcon(props: IconProps) {
  return <Svg {...props}><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></Svg>;
}
```

`frontend/src/components/InfoTip.tsx` — accept rich content: signature `InfoTip({ text, align, children }: { text: string; align?: "left" | "right"; children?: React.ReactNode })`, bubble renders `{children ?? text}`; keep `aria-label={text}`. Add a why-comment: 목록(제외 뷰)은 여러 줄이라 children으로 받는다.

- [ ] **Step 5: i18n copy (noun phrases) + new keys**

In `frontend/src/lib/i18n.ts` replace these values and add the new keys:

```ts
  "trace.subtitle": { ko: "화면 값 하나 → 저장 테이블·컬럼", en: "One screen value → the table and column that store it" },
  "trace.form.title": { ko: "조건", en: "Conditions" },
  "trace.form.desc": { ko: "소스·스키마 선택, 값 입력. 스키마가 좁을수록 소스 쿼리 감소", en: "Source, schemas, value. Narrower scope, fewer source queries" },
  "trace.form.related": { ko: "다른 스키마의 연관 뷰 포함", en: "Include related views from other schemas" },
  "trace.form.relatedHint": { ko: "선택 스키마의 테이블을 읽는 뷰", en: "views that read the selected schemas' tables" },
  "trace.form.stop": { ko: "중단", en: "Stop" },
  "trace.form.progress": { ko: "찾는 중", en: "Finding" },
  "trace.progress.title": { ko: "진행", en: "Progress" },
  "trace.progress.desc": { ko: "객체당 쿼리 1개, 도착 순 표시", en: "One query per object, shown as they arrive" },
  "trace.progress.candidates": { ko: "후보 객체", en: "candidates" },
  "trace.progress.columns": { ko: "컬럼", en: "columns" },
  "trace.progress.heavy": { ko: "무거운 객체", en: "heavy" },
  "trace.progress.related": { ko: "연관 뷰", en: "related views" },
  "trace.progress.relatedSkipped": { ko: "제외", en: "excluded" },
  "trace.progress.relatedSkippedTip": { ko: "미리보기가 허용되지 않아 검색하지 않은 뷰", en: "Views not searched because preview is not allowed" },
  "trace.hits.title": { ko: "찾은 컬럼", en: "Matches" },
  "trace.hits.desc": { ko: "값이 저장된 컬럼, 건수 상한 1000", en: "Columns storing the value, counts capped at 1000" },
  "trace.heavy.title": { ko: "무거운 객체", en: "Heavy objects" },
  "trace.heavy.desc": { ko: "자동 실행 제외 객체, 선택 실행", en: "Excluded from the automatic run; run on demand" },
```
Remove `trace.progress.plan` and `trace.progress.cancel` (the cancel button moves into the find button; the plan sentence becomes stat pills). tsc will point at any remaining consumer.

- [ ] **Step 6: Components**

`ProbeForm.tsx` — new props: `progress: { done: number; total: number } | null` (null when not running), `onStop: () => void`, `running: boolean` (replaces `busy`). Behaviour:
- Schema options render as `<label className="choice-pill"><input type="checkbox" className="ctl-check" …/>…</label>`; the "허용 스키마 전체" toggle uses `ctl-switch`; the mode radios are `choice-pill` + `ctl-radio` with the description as a `hint-pill` inside the label; the related-views option is a `choice-pill` with `ctl-switch` (`data-testid="ProbeForm-relatedSwitch"`) + `hint-pill` `trace.form.relatedHint`. Form state gains `includeRelatedViews: boolean` (add to `ProbeForm` interface in `value-probe.ts`, default false; `validateProbeRequest` unchanged).
- All inputs are `disabled={running}`.
- The submit button: `const mode = findButtonLabel({ running, hovering, done, total })`. `find` → `btn-primary` "찾기" (`type="submit"`). `progress` → `btn-primary btn-progress` with `<SpinnerIcon size={14} className="spin" />` + `t("trace.form.progress")` + ` ${done} / ${total}` + `<span className="btn-progress__fill" style={{ width: `${percent}%` }} />` (`type="button"`, `data-testid="ProbeForm-findButton"` stays on this element in all modes). `stop` → `btn-secondary btn-stop` with `<StopIcon size={12} />` + `t("trace.form.stop")`, `onClick={onStop}`, `data-testid="ProbeForm-stopButton"`. Hover/focus state via `onMouseEnter/onMouseLeave/onFocus/onBlur`; reset `hovering` when `running` turns false. Add a why-comment: 한 버튼이 세 얼굴 — 자리를 옮기지 않아야 눈이 따라간다.

`ProbeProgress.tsx` — remove the cancel button and the `done` prop on `StepCardHeader` (the status badge alone says 완료); replace the plan sentence with stat pills:
```tsx
<div className="mb-2 flex flex-wrap gap-2" data-testid="ProbeProgress-plan">
  <span className="stat-pill" data-testid="ProbeProgress-stat-candidates"><ListIcon size={12} /> {t("trace.progress.candidates")} <b>{plan.auto}</b></span>
  <span className="stat-pill" data-testid="ProbeProgress-stat-columns"><ColumnsIcon size={12} /> {t("trace.progress.columns")} <b>{plan.columns}</b></span>
  <span className="stat-pill" data-testid="ProbeProgress-stat-heavy"><DatabaseIcon size={12} /> {t("trace.progress.heavy")} <b>{plan.heavy}</b></span>
  {job.include_related_views && (
    <span className="stat-pill" data-testid="ProbeProgress-stat-related">
      <ViewIcon size={12} /> {t("trace.progress.related")} <b>+{plan.related_views.included}</b>
      {plan.related_views.skipped.length > 0 && (
        <>
          <span style={{ color: "var(--muted)" }}>· {t("trace.progress.relatedSkipped")} {plan.related_views.skipped.length}</span>
          <span data-testid="ProbeProgress-relatedSkippedTip">
            <InfoTip text={t("trace.progress.relatedSkippedTip")}>
              <ul style={{ margin: 0, paddingLeft: 14 }}>
                {plan.related_views.skipped.map((item) => (
                  <li key={item.qname}>{describeSkippedView(item, lang)}</li>
                ))}
              </ul>
            </InfoTip>
          </span>
        </>
      )}
    </span>
  )}
</div>
```
(`lang` from `useI18n()`; when `plan` is null but the job carries `related_view_skipped`, build the same pill from `job.related_view_skipped`/`job.related_schemas` so a reloaded job still shows it — simplest: derive `skipped = plan?.related_views.skipped ?? job.related_view_skipped` and `included = plan?.related_views.included ?? job.related_schemas.length`.) Keep the bar, done/total, current qname, elapsed and error.

`ProbeHits.tsx` — table/view chip gets an icon (`<TableIcon size={11} />` / `<ViewIcon size={11} />`), the count becomes `<span className="badge badge--muted">…</span>`.

`ProbeHeavyList.tsx` — checkboxes use `ctl-check`; the reason becomes a coloured badge: `rows` → `badge badge--unresolved`, `unknown_rows` → `badge badge--muted`, `view_shape` → `badge badge--ai`.

`app/trace/page.tsx` — pass `running={polling}`, `progress={job && polling ? job.progress : null}`, `onStop={() => void handleCancel()}` to `ProbeForm`; send `include_related_views: request.includeRelatedViews` in `startValueProbe`; drop `onCancel` from `ProbeProgress`.

- [ ] **Step 7: Verify**

Run: `cd frontend && npx tsc --noEmit && npm run lint && npm test && npm run build`
Expected: clean.

- [ ] **Step 8: Commit**

PROGRESS line: `- **/trace 폴리시** — 토큰으로 그린 체크박스·라디오·토글(choice-pill), 찾기 버튼이 실행 중 스피너+진척 바, 호버 시 「중단」으로 전환(진행 카드 취소 버튼 제거, 완료 중복 표시 제거), 연관 뷰 토글 + 제외 뷰 ⓘ 목록, 진행 카드 스탯 필, 테이블/뷰 아이콘, heavy 사유 색 배지, 설명 문구 명사형.`

```bash
git add frontend/src/app/globals.css frontend/src/components/icons.tsx frontend/src/components/InfoTip.tsx frontend/src/lib/api.ts frontend/src/lib/value-probe.ts frontend/src/lib/value-probe.test.ts frontend/src/lib/i18n.ts frontend/src/components/trace frontend/src/app/trace/page.tsx PROGRESS.md
git commit -m "feat(trace): token-styled controls, live find/stop button, related-view option and noun-phrase copy — 값 추적 화면 폴리시"
git push
```

---

### Task 14: Browser verification + screenshots (controller)

Re-run the headless Playwright flow from Task 11 with these additions: the find button shows the spinner/progress while running and flips to 「중단」 on hover; clicking 중단 cancels; the related-views switch toggles and, with a related view in a non-allowlisted schema seeded, the progress card shows `연관 뷰 +0 · 제외 1` with an ⓘ whose tooltip lists the view; controls render with the token styles (screenshot); heavy reason badges coloured. Record results in PROGRESS.md and commit.
