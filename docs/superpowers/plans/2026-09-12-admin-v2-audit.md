# Admin Console v2 + Audit Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the admin console for scannability (P1–P10 of the approved mockup, audit log as a fifth tab with one-line rows, a detail modal, uniform filter controls and requester/target dropdowns) and close the audit-record gaps A0–A5 (requester taken from auth, denied access, collect step 2/cancel, category rename, AI index trigger, enable/disable direction).

**Architecture:** Backend gains an `audit_logs.target` column (migration 0020, Python backfill of the first detail token) so the audit API can serve distinct `requesters`/`targets` for dropdowns and `counts_by_action`/`failed_logins` for summary tiles; every `AuditLog(...)` call site passes `target=` and takes `requested_by` from the auth dependency. Frontend keeps the same panels and API calls but lifts the admin password into one `AdminLockBar`, adds pure helpers in `lib/audit.ts` + `lib/relative-time.ts`, a new `AuditPanel` (tab `audit`; `/admin/audit` becomes a redirect), and a `globals.css` block of v2 classes (`.sec-head`, `.lock-bar`, `.src-card`, `.stepper`, `.ctl-field`, `.audit-*`, `.modal`) so components stay Tailwind-light and the CSS tokens carry both themes.

**Tech Stack:** FastAPI + SQLAlchemy + Alembic (pytest); Next.js 15 + React 19 + TypeScript (vitest, eslint, tsc); headless Playwright from the npx cache for screen checks.

**Spec:** Approved mockup https://claude.ai/code/artifact/1433068a-52ea-4459-b64d-e1222a19a118 (P1–P10) and the chat decisions of 2026-09-12: audit gaps A0–A5 all in scope; audit rows stay one line with ellipsis and open a rectangular modal on click; filter/input controls share one height, date filters wrap to a second row when short of space, the clear button stays right-aligned; requester and target filters are dropdowns.

## Global Constraints

- Design system (`rules/frontend/design-app.md`): electric yellow `--primary` only for CTA/selected/stat; no second brand color; no shadows; card radius 12px, button 8px, badges pill; Pretendard/JetBrains Mono via tokens. Semantic status colors use existing tokens: `--deep-green`, `--error`, `--code-fn` (amber), `--obj-view` (blue).
- `data-testid` = `ComponentName-role`, list items suffixed with the key (`rules/frontend/identifiers.md`). Existing ids stay unless the element is removed (listed per task).
- Existing behaviour is preserved: same API endpoints, same filters/paging on the audit list, same collect/source/allowlist actions.
- Language: code/comments English or the repo's Korean comment style; commit messages `type(scope): English — 한국어`.
- Backend tests: `cd backend && .venv/bin/pytest -q`. Frontend: `cd frontend && npm test -- --run`, `npx tsc --noEmit`, `npm run lint`, `npm run build`.
- Every commit ends with the session trailer lines (Co-Authored-By + Claude-Session).

---

### Task 1: `audit_logs.target` column, list API dropdown/summary fields

**Files:**
- Modify: `backend/app/models/relations.py:117-126` (AuditLog)
- Create: `backend/alembic/versions/0020_audit_target.py`
- Modify: `backend/app/api/admin.py:200-256` (`get_audit_log`)
- Test: `backend/tests/test_audit_log.py`

**Interfaces:**
- Produces: `AuditLog.target: str | None` (String(300)); `GET /api/admin/audit` accepts `target` (substring, LIKE-escaped like `q`) and returns `items[].target`, `requesters: list[str]`, `targets: list[str]` (distinct, sorted, max 500), `counts_by_action: dict[str, int]` and `failed_logins: int` computed with every filter **except** `action`.

- [ ] **Step 1: Write the failing tests** (append to `backend/tests/test_audit_log.py`)

```python
def test_target_is_recorded_and_filterable(client, sysadmins):
    client.post("/api/admin/whitelist", headers=_admin_headers("kim.admin"),
                json={"login_id": "hong.gil"})
    client.post("/api/admin/whitelist", headers=_admin_headers("kim.admin"),
                json={"login_id": "park.min"})
    body = client.get("/api/admin/audit", params={"target": "hong"},
                      headers=_admin_headers("kim.admin")).json()
    assert [item["target"] for item in body["items"]] == ["hong.gil"]
    assert body["requesters"] == ["kim.admin"]
    assert body["targets"] == ["hong.gil", "park.min"]


def test_summary_counts_ignore_the_action_filter(client, sysadmins):
    client.post("/api/admin/whitelist", headers=_admin_headers("kim.admin"),
                json={"login_id": "hong.gil"})
    client.delete("/api/admin/whitelist/hong.gil", headers=_admin_headers("kim.admin"))
    body = client.get("/api/admin/audit", params={"action": "whitelist_add"},
                      headers=_admin_headers("kim.admin")).json()
    assert body["total"] == 1
    assert body["counts_by_action"] == {"whitelist_add": 1, "whitelist_remove": 1}
    assert body["failed_logins"] == 0
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_audit_log.py -q -k "target_is_recorded or summary_counts"`
Expected: FAIL — `KeyError: 'target'` / `'requesters'`.

- [ ] **Step 3: Model + migration**

`backend/app/models/relations.py` — after `detail`:
```python
    # 조작 대상 하나(테이블·스키마·login_id·소스명·job) — 감사 화면 드롭다운·필터 축.
    # detail은 자유 문장이라 축으로 못 쓴다 / one target per row, the filter axis
    target: Mapped[str | None] = mapped_column(String(300), nullable=True)
```

`backend/alembic/versions/0020_audit_target.py`:
```python
"""Audit log: target column (감사 로그 대상 컬럼).

Revision ID: 0020
Revises: 0019
Create Date: 2026-09-12

감사 화면의 요청자·대상 드롭다운 축. 기존 행은 detail의 첫 토큰(테이블명·login_id·소스명)이
곧 대상이었으므로 그 값으로 백필한다.
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "0020"
down_revision: Union[str, None] = "0019"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("audit_logs") as batch:
        batch.add_column(sa.Column("target", sa.String(length=300), nullable=True))
    # 파이썬 백필 — SQLite/PostgreSQL 공통 문자열 함수가 없어 DB별 SQL을 나누지 않는다
    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, detail FROM audit_logs")).fetchall()
    for row_id, detail in rows:
        target = (detail or "").split(" ", 1)[0][:300] or None
        conn.execute(sa.text("UPDATE audit_logs SET target = :t WHERE id = :i"),
                     {"t": target, "i": row_id})


def downgrade() -> None:
    with op.batch_alter_table("audit_logs") as batch:
        batch.drop_column("target")
```

- [ ] **Step 4: List API** — replace the body of `get_audit_log` in `backend/app/api/admin.py`:

```python
@router.get("/audit")
def get_audit_log(
    action: str | None = None,
    requested_by: str | None = None,
    target: str | None = None,
    q: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    _admin: str = Depends(require_sysadmin),
) -> dict:
    """감사 로그 조회 — 최신순. (docstring 기존 유지)"""
    def contains(column, term: str):
        escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        return column.ilike(f"%{escaped}%", escape="\\")
    # action을 뺀 필터 — 요약 타일(counts_by_action·failed_logins)은 "이 기간·이 사람"의
    # 전체 분포를 보여줘야 하므로 동작 필터에 영향받지 않는다
    base = []
    if requested_by:
        base.append(contains(AuditLog.requested_by, requested_by))
    if target:
        base.append(contains(AuditLog.target, target))
    if q:
        base.append(contains(AuditLog.detail, q))
    if date_from is not None:
        base.append(AuditLog.requested_at >= date_from)
    if date_to is not None:
        base.append(AuditLog.requested_at < date_to)
    filters = [*base, *([AuditLog.action == action] if action else [])]
    total = db.execute(select(func.count()).select_from(AuditLog).where(*filters)).scalar_one()
    rows = db.execute(
        select(AuditLog).where(*filters)
        .order_by(AuditLog.requested_at.desc(), AuditLog.id.desc())
        .limit(limit).offset(offset)
    ).scalars().all()
    actions = list(db.execute(
        select(AuditLog.action).distinct().order_by(AuditLog.action)).scalars())
    # 드롭다운 축 — 500개 상한: 그 이상이면 검색창 타이핑으로 좁힌다
    requesters = list(db.execute(
        select(AuditLog.requested_by).distinct().order_by(AuditLog.requested_by).limit(500)
    ).scalars())
    targets = list(db.execute(
        select(AuditLog.target).where(AuditLog.target.is_not(None))
        .distinct().order_by(AuditLog.target).limit(500)
    ).scalars())
    counts = db.execute(
        select(AuditLog.action, func.count()).where(*base).group_by(AuditLog.action)
    ).all()
    failed_logins = db.execute(
        select(func.count()).select_from(AuditLog).where(
            *base,
            or_(AuditLog.action == "access_denied",
                (AuditLog.action == "ldap_login") & AuditLog.detail.like("% fail")),
        )
    ).scalar_one()
    return {
        "total": total, "actions": actions,
        "requesters": requesters, "targets": targets,
        "counts_by_action": {name: count for name, count in counts},
        "failed_logins": failed_logins,
        "items": [
            {"id": row.id, "action": row.action, "target": row.target,
             "detail": row.detail, "requested_by": row.requested_by,
             "requested_at": row.requested_at.isoformat()}
            for row in rows
        ],
    }
```
Then make the two whitelist audit calls in the same file pass `target`: line 70 `db.add(AuditLog(action="whitelist_add", target=login_id, detail=login_id, ...))` and line 86 `action="whitelist_remove", target=login_id`.

- [ ] **Step 5: Run the audit tests**

Run: `cd backend && .venv/bin/pytest tests/test_audit_log.py -q`
Expected: all PASS (the two new ones included).

- [ ] **Step 6: Commit**

```bash
git add backend/app/models/relations.py backend/alembic/versions/0020_audit_target.py backend/app/api/admin.py backend/tests/test_audit_log.py
git commit -m "feat(audit): add target column and dropdown/summary fields to the audit list — 감사 대상 컬럼·요약 집계"
```

---

### Task 2: A0 requester from auth + A2 collect step 2/cancel + targets on value-exposure rows

**Files:**
- Modify: `backend/app/api/join_preview.py:36-39, 113-118, 208-213`
- Modify: `backend/app/api/validate.py:206-228, 251-256, 294-299`
- Modify: `backend/app/api/relations.py:10-11, 27-31, 55-59`
- Modify: `backend/app/api/scan.py:10, 33-40, 62-72`
- Modify: `backend/app/api/collect.py:181-198, 201-231, 234-250, 257-278`
- Modify: `backend/app/api/objects.py:468` (table_preview target), `backend/app/api/value_probe.py:162, 307`, `backend/app/api/auth_login.py:142, 150`, `backend/app/api/me.py:41`
- Test: `backend/tests/test_collect.py:466-475`, `backend/tests/test_join_preview.py` (audit assertion), `backend/tests/test_audit_log.py`

**Interfaces:**
- Produces: `requested_by` on `join_preview`, `preview` (validate), `confirm`, `collect_trigger` rows equals the authenticated user (`X-Dev-User` in tests); body fields `requested_by`/`confirmed_by`/`triggered_by` are accepted but ignored (comment says so). New action `collect_cancel`. `collect_trigger` detail for step 2 is `view-deps job=#<id> source=<id|default>`.
- Targets: `join_preview` → `<left_schema>.<left_table>` of the first step; `preview`/`confirm` → `src_ref.object_qname`; `table_preview` → `qname`; `value_probe` → comma-joined schemas (≤300 chars); `value_probe_heavy` → `job=#<id>`; `login`/`ldap_login` → `login_id`; `collect_*` → `source=<id|default>` (cancel: `job=#<id>`).

- [ ] **Step 1: Failing tests**

`backend/tests/test_collect.py` — change the existing assertion block at lines 466-475 so the body identity is ignored:
```python
    res = cclient.post("/api/collect/catalog", json={"triggered_by": "kim.ops"},
                       headers={"X-Dev-User": "admin.user"})
    assert res.status_code == 202
    triggers = [item for item in cclient.get("/api/admin/audit",
                        headers={"X-Dev-User": "admin.user"}).json()["items"]
                if item["action"] == "collect_trigger"]
    assert triggers[0]["requested_by"] == "admin.user"   # 본문의 kim.ops가 아니라 인증 사용자
    assert triggers[0]["target"] == "source=default"
```
Add to the same file (reuse the file's existing fixtures for a `catalog_done` job — copy the setup from the test around line 195 that creates a `deps_running`/`catalog_done` job):
```python
def test_view_deps_and_cancel_are_audited(cclient, session_factory, ...):
    # 1) catalog_done 잡을 만들고 2단계를 트리거 → collect_trigger view-deps 행
    ...
    res = cclient.post("/api/collect/view-deps", json={"job_id": job_id},
                       headers={"X-Dev-User": "admin.user"})
    assert res.status_code == 202
    # 2) 실행 중 잡을 중단 → collect_cancel 행
    ...
    res = cclient.post(f"/api/collect/jobs/{running_id}/cancel", headers={"X-Dev-User": "admin.user"})
    assert res.status_code == 200
    items = cclient.get("/api/admin/audit", headers={"X-Dev-User": "admin.user"}).json()["items"]
    assert any(i["action"] == "collect_trigger" and i["detail"].startswith("view-deps job=#") for i in items)
    cancel = next(i for i in items if i["action"] == "collect_cancel")
    assert cancel["requested_by"] == "admin.user" and cancel["target"] == f"job=#{running_id}"
```
(Fill the `...` with the job-creation lines that already exist in that test module — the executor copies them verbatim from the neighbouring tests.)

`backend/tests/test_join_preview.py` — in the test that asserts the `join_preview` audit row, send `headers={"X-Dev-User": "hong.gil"}` and body `requested_by: "someone.else"`, then assert `requested_by == "hong.gil"` and `target == "<schema>.<left table>"` of the first step.

- [ ] **Step 2: Run, expect FAIL** — `cd backend && .venv/bin/pytest tests/test_collect.py tests/test_join_preview.py -q`

- [ ] **Step 3: Implement**

`join_preview.py`: `from app.auth import get_current_user`; in `JoinPreviewRequest` keep `requested_by: str = "local"` with comment `# 하위 호환용 — 감사 요청자는 인증 사용자로 기록한다(무시됨)`; signature `run_join_preview(req, db, validator, login_id: str = Depends(get_current_user))`; audit call:
```python
    db.add(AuditLog(
        action="join_preview",
        target=f"{refs[0].left_schema}.{refs[0].left_table}",
        detail=_build_audit_detail(refs, len(rows)),
        requested_by=login_id, requested_at=now,
    ))
```
`validate.py`: import `get_current_user`; `run_containment(..., login_id: str = Depends(get_current_user))` → `record_observation(db, src_ref, tgt_ref, result, login_id, now)`; `run_preview(..., login_id: str = Depends(get_current_user))` → `AuditLog(action="preview", target=src_ref.object_qname, detail=..., requested_by=login_id, requested_at=now)`. Keep the request fields with the same 하위 호환 comment.
`relations.py`: import; `confirm_relation(req, db, login_id: str = Depends(get_current_user))` → `AuditLog(action="confirm", target=src_ref.object_qname, detail=f"{src_ref} -> {tgt_ref}", requested_by=login_id, ...)`.
`scan.py`: import `get_current_user`; `start_scan(..., login_id: str = Depends(get_current_user))` → `triggered_by=login_id`.
`collect.py`: catalog + full get `admin: str = Depends(require_sysadmin)`; `_create_job(db, "step", admin)`; audit `target=f"source={sid}"` where `sid = req.source_id if req.source_id is not None else 'default'`; `requested_by=admin`. view-deps: add `admin` dep and, right after `job.stage = "deps_running"`:
```python
    db.add(AuditLog(action="collect_trigger", target=f"source={sid}",
                    detail=f"view-deps job=#{job.id} source={sid}",
                    requested_by=admin, requested_at=job.updated_at))
```
cancel: before `job.stage = "failed"` capture `previous = job.stage`, then after setting the error:
```python
    db.add(AuditLog(action="collect_cancel", target=f"job=#{job.id}",
                    detail=f"job=#{job.id} stage={previous}",
                    requested_by=admin, requested_at=job.updated_at))
```
Targets on the remaining rows: `objects.py:468` `target=qname`; `value_probe.py:162` `target=",".join(schemas)[:300]` (use the variable that holds the selected schema list in that function); `value_probe.py:307` `target=f"job=#{job.id}"`; `auth_login.py:142/150` `target=login_id`; `me.py:41` `target=login_id`.

- [ ] **Step 4: Run** — `cd backend && .venv/bin/pytest tests/test_collect.py tests/test_join_preview.py tests/test_audit_log.py tests/test_validate*.py tests/test_relations*.py -q` → PASS. Then the full suite `.venv/bin/pytest -q` → PASS (fix any test that asserted the old body identity).

- [ ] **Step 5: Commit**

```bash
git add backend/app/api backend/tests
git commit -m "fix(audit): take the requester from auth, record collect step 2 and cancel, stamp targets — 감사 요청자 인증 기반·수집 2단계/중단 기록"
```

---

### Task 3: A1 access_denied, A3 category_set, A4 embed_index_trigger, A5 enable/disable direction, targets on admin/source rows

**Files:**
- Modify: `backend/app/api/me.py:28-43, 70`
- Modify: `backend/app/api/categories.py:8-18, 86-101`
- Modify: `backend/app/api/ai.py:156-176` (+ import `AuditLog`)
- Modify: `backend/app/api/sources.py:209, 226-230, 241-243, 295, 342, 357, 371`
- Modify: `backend/app/api/admin.py:195, 296, 314, 335`
- Test: `backend/tests/test_me.py` (or the module that tests `/api/me`), `backend/tests/test_categories.py`, `backend/tests/test_ai*.py` (embed-index test), `backend/tests/test_sources_api.py`

**Interfaces:**
- Produces new actions `access_denied` (target/detail = login_id, one row per KST day), `category_set` (target = schema, detail `"<schema> -> <category|(default)> source=<id>"`), `embed_index_trigger` (target `embed_index`, detail `job=#<id>`); `source_update` detail lists `is_enabled=true|false` instead of the bare field name; `source_*` targets = source name; `preview_allow_*` target = schema; `hidden_schema_render_set` target = `hidden_schema_render`; `ad_sync_all` target = `ad_sync`.

- [ ] **Step 1: Failing tests**

`me.py` helper test (new file `backend/tests/test_me_audit.py`):
```python
from app.api.me import _record_daily
from app.models import AuditLog


def test_daily_record_dedupes_per_action(db_session):
    _record_daily(db_session, "access_denied", "park.min")
    _record_daily(db_session, "access_denied", "park.min")
    _record_daily(db_session, "login", "park.min")
    rows = db_session.query(AuditLog).order_by(AuditLog.id).all()
    assert [(r.action, r.target) for r in rows] == [("access_denied", "park.min"), ("login", "park.min")]
```
(Use the session fixture name the suite already exposes — check `backend/tests/conftest.py`; if only `client` exists, obtain a session through the app's `get_db` override the same way other tests do.)

`test_categories.py`: after a successful `PUT /api/schema-categories/<schema>` with `{"category": "품질"}`, `GET /api/admin/audit` (sysadmin header) contains a row `action == "category_set"`, `target == schema`, `detail == f"{schema} -> 품질 source=1"`.

`test_sources_api.py`: after `PATCH /api/sources/<id>` with `{"is_enabled": false}`, the `source_update` row has `detail.endswith("[is_enabled=false]")` and `target == <source name>`.

Embed-index: in the module that already tests `POST /api/ai/embed-index` (it stubs `embed_url`/`embed_model`), assert an `embed_index_trigger` audit row with `target == "embed_index"`.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

`me.py` — replace `_record_login` with:
```python
def _record_daily(db: Session, action: str, login_id: str) -> None:
    """하루 1건 기록 — KST 자정 경계 (bpm 패턴). 로그인과 접근 거부가 같은 규칙을 쓴다."""
    now = datetime.now(UTC)
    kst_midnight = now.astimezone(_KST).replace(hour=0, minute=0, second=0, microsecond=0)
    today_start = kst_midnight.astimezone(UTC)
    existing = db.execute(
        select(AuditLog.id).where(
            AuditLog.action == action,
            AuditLog.detail == login_id,
            AuditLog.requested_at >= today_start,
        ).limit(1)
    ).first()
    if existing is None:
        db.add(AuditLog(action=action, target=login_id, detail=login_id,
                        requested_by=login_id, requested_at=now))
```
and in `get_me` replace `_record_login(db, login_id)` with:
```python
    # 화이트리스트 밖 계정이 문을 두드린 것도 남긴다 — 관리자가 누구를 등록해야 하는지 본다
    _record_daily(db, "login" if whitelisted else "access_denied", login_id)
```
`categories.py`: `from app.models import AuditLog, CatalogObject, SchemaCategory`; before each `return` in `assign_schema_category` (both branches):
```python
    db.add(AuditLog(action="category_set", target=schema_name,
                    detail=f"{schema_name} -> {category or '(default)'} source={snapshot.data_source_id}",
                    requested_by=login_id, requested_at=datetime.now(UTC)))
```
`ai.py` embed-index: add `admin: str = Depends(require_sysadmin)` to the signature (the decorator dependency stays), `triggered_by=admin`, and after `db.flush()`:
```python
    db.add(AuditLog(action="embed_index_trigger", target="embed_index",
                    detail=f"job=#{job.id}", requested_by=admin, requested_at=job.created_at))
```
`sources.py`: loop body `changed.append(f"is_enabled={str(value).lower()}" if field == "is_enabled" else field)`; add `target=source.name` to the create/update/delete/test(×3) `AuditLog(...)` calls (for delete use the name captured before deletion).
`admin.py`: `preview_allow_add`/`remove` → `target=schema`; `hidden_schema_render_set` → `target="hidden_schema_render"`; `ad_sync_all` → `target="ad_sync"`.

- [ ] **Step 4: Run the full backend suite** — `cd backend && .venv/bin/pytest -q` → PASS; `.venv/bin/ruff check app tests` → clean.

- [ ] **Step 5: Commit**

```bash
git add backend/app backend/tests
git commit -m "feat(audit): record denied access, category changes, AI index start and enable direction — 접근 거부·카테고리·색인·활성 방향 감사"
```

---

### Task 4: Frontend audit helpers, API types, tab id, redirect

**Files:**
- Create: `frontend/src/lib/audit.ts`, `frontend/src/lib/audit.test.ts`
- Create: `frontend/src/lib/relative-time.ts`, `frontend/src/lib/relative-time.test.ts`
- Modify: `frontend/src/lib/api.ts:753-786`
- Modify: `frontend/src/lib/admin-tabs.ts:4`, `frontend/src/lib/admin-tabs.test.ts:35-45`
- Modify: `frontend/src/app/admin/audit/page.tsx` (becomes a redirect)

**Interfaces:**
- Produces (`lib/audit.ts`): `ACTION_LABELS: Record<string,string>`; `type AuditCategory = "exposure"|"policy"|"ops"|"login"`; `getActionCategory(action): AuditCategory`; `isFailedEntry(action, detail): boolean`; `type AuditPeriod = "today"|"7d"|"30d"|"all"`; `buildPeriodRange(period, now: Date): {dateFrom?: string; dateTo?: string}` (local midnight ISO); `toIsoRange(from, to)` (moved from the page); `summarizeCounts(counts: Record<string,number>): {total, exposure, policy}`; `ACTION_GROUPS: {category: AuditCategory; label: string; actions: string[]}[]` for the grouped select.
- Produces (`lib/relative-time.ts`): `formatRelativeTime(iso: string, now = new Date()): string` → `"방금"`, `"3분 전"`, `"2시간 전"`, `"어제 18:40"`, `"09-09 11:30"` (older than 2 days: `MM-DD HH:mm`).
- API: `AuditEntry.target: string | null`; `AuditPage` gains `requesters: string[]`, `targets: string[]`, `counts_by_action: Record<string, number>`, `failed_logins: number`; `fetchAuditLog` opts gain `target?: string`.
- `ADMIN_TAB_IDS = ["sources","access","ai","users","audit"]`.

- [ ] **Step 1: Failing tests**

`frontend/src/lib/audit.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildPeriodRange, getActionCategory, isFailedEntry, summarizeCounts } from "./audit";

describe("getActionCategory", () => {
  it("maps exposure, policy, ops and login actions", () => {
    expect(getActionCategory("table_preview")).toBe("exposure");
    expect(getActionCategory("preview_allow_add")).toBe("policy");
    expect(getActionCategory("collect_cancel")).toBe("ops");
    expect(getActionCategory("access_denied")).toBe("login");
    expect(getActionCategory("something_new")).toBe("ops");
  });
});

describe("isFailedEntry", () => {
  it("flags denied access and 'fail' details", () => {
    expect(isFailedEntry("access_denied", "park.min")).toBe(true);
    expect(isFailedEntry("ldap_login", "park.min fail")).toBe(true);
    expect(isFailedEntry("source_test", "svcc fail (OperationalError)")).toBe(true);
    expect(isFailedEntry("ldap_login", "park.min ok")).toBe(false);
  });
});

describe("buildPeriodRange", () => {
  const now = new Date(2026, 8, 12, 15, 30);
  it("today starts at local midnight and has no upper bound", () => {
    expect(buildPeriodRange("today", now)).toEqual({ dateFrom: new Date(2026, 8, 12).toISOString() });
  });
  it("7d and 30d count back from today's midnight", () => {
    expect(buildPeriodRange("7d", now).dateFrom).toBe(new Date(2026, 8, 6).toISOString());
    expect(buildPeriodRange("30d", now).dateFrom).toBe(new Date(2026, 7, 14).toISOString());
  });
  it("all is empty", () => expect(buildPeriodRange("all", now)).toEqual({}));
});

describe("summarizeCounts", () => {
  it("sums by category", () => {
    expect(summarizeCounts({ table_preview: 3, value_probe: 1, whitelist_add: 2, login: 5 }))
      .toEqual({ total: 11, exposure: 4, policy: 2 });
  });
});
```
`frontend/src/lib/relative-time.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./relative-time";

describe("formatRelativeTime", () => {
  const now = new Date(2026, 8, 12, 9, 15);
  it("uses minutes and hours within the day", () => {
    expect(formatRelativeTime(new Date(2026, 8, 12, 9, 14, 40).toISOString(), now)).toBe("방금");
    expect(formatRelativeTime(new Date(2026, 8, 12, 9, 12).toISOString(), now)).toBe("3분 전");
    expect(formatRelativeTime(new Date(2026, 8, 12, 7, 15).toISOString(), now)).toBe("2시간 전");
  });
  it("names yesterday and falls back to a date", () => {
    expect(formatRelativeTime(new Date(2026, 8, 11, 18, 40).toISOString(), now)).toBe("어제 18:40");
    expect(formatRelativeTime(new Date(2026, 8, 9, 11, 30).toISOString(), now)).toBe("09-09 11:30");
  });
});
```
`admin-tabs.test.ts`: extend the neighbour test — `getNeighbourTab("users", 1)` is `"audit"` and `getNeighbourTab("audit", 1)` wraps to `"sources"`; `parseAdminTab("audit")` is `"audit"`.

- [ ] **Step 2: Run** `cd frontend && npx vitest run src/lib/audit.test.ts src/lib/relative-time.test.ts src/lib/admin-tabs.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Implement**

`frontend/src/lib/audit.ts`:
```ts
/** 감사 로그 화면의 순수 로직 — 동작 라벨·분류·기간·요약. 화면 없이 테스트한다.
 * Pure helpers for the audit panel: labels, categories, period ranges, summaries. */

export type AuditCategory = "exposure" | "policy" | "ops" | "login";

// 코드 그대로는 무슨 조작인지 안 읽힌다 — 목록에 없는 action은 코드를 그대로 보여준다
export const ACTION_LABELS: Record<string, string> = {
  table_preview: "테이블 미리보기",
  join_preview: "조인 미리보기",
  preview: "조인 검증 미리보기",
  value_probe: "값 추적",
  value_probe_heavy: "값 추적 — 무거운 객체",
  whitelist_add: "화이트리스트 등록",
  whitelist_remove: "화이트리스트 해제",
  preview_allow_add: "미리보기 허용 등록",
  preview_allow_remove: "미리보기 허용 해제",
  hidden_schema_render_set: "감춘 스키마 표시 토글",
  confirm: "관계 확정",
  category_set: "스키마 카테고리 변경",
  source_create: "데이터 소스 등록",
  source_update: "데이터 소스 수정",
  source_delete: "데이터 소스 삭제",
  source_test: "소스 연결 테스트",
  collect_trigger: "카탈로그 수집",
  collect_cancel: "카탈로그 수집 중단",
  ad_sync_all: "AD 전체 동기화",
  embed_index_trigger: "AI 색인 시작",
  login: "로그인 (Keycloak)",
  ldap_login: "로그인 (LDAP)",
  access_denied: "접근 거부 (화이트리스트 밖)",
};

export const ACTION_GROUPS: { category: AuditCategory; label: string; actions: string[] }[] = [
  { category: "exposure", label: "실값 반출",
    actions: ["table_preview", "join_preview", "preview", "value_probe", "value_probe_heavy"] },
  { category: "policy", label: "권한·설정",
    actions: ["preview_allow_add", "preview_allow_remove", "whitelist_add", "whitelist_remove",
              "hidden_schema_render_set", "confirm", "category_set"] },
  { category: "ops", label: "소스·수집",
    actions: ["source_create", "source_update", "source_delete", "source_test",
              "collect_trigger", "collect_cancel", "ad_sync_all", "embed_index_trigger"] },
  { category: "login", label: "로그인", actions: ["login", "ldap_login", "access_denied"] },
];

const CATEGORY_BY_ACTION = new Map(
  ACTION_GROUPS.flatMap((group) => group.actions.map((action) => [action, group.category] as const)),
);

export function getActionCategory(action: string): AuditCategory {
  return CATEGORY_BY_ACTION.get(action) ?? "ops";
}

/** 실패 행 — 접근 거부이거나 detail이 "<대상> fail…" 꼴(LDAP 실패·연결 테스트 실패). */
export function isFailedEntry(action: string, detail: string): boolean {
  return action === "access_denied" || /(^|\s)fail(\s|\(|$)/.test(detail);
}

export type AuditPeriod = "today" | "7d" | "30d" | "all";

const PERIOD_DAYS: Record<Exclude<AuditPeriod, "all">, number> = { today: 0, "7d": 6, "30d": 29 };

/** 기간 칩 → [from, ∞). 로컬 자정 기준 — 백엔드는 [from, to)로 받는다. */
export function buildPeriodRange(period: AuditPeriod, now: Date): { dateFrom?: string; dateTo?: string } {
  if (period === "all") return {};
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - PERIOD_DAYS[period]);
  return { dateFrom: start.toISOString() };
}

/** 날짜 입력(YYYY-MM-DD)을 [from, to) ISO로 — to는 다음 날 자정(미포함 상한). */
export function toIsoRange(from: string, to: string): { dateFrom?: string; dateTo?: string } {
  const range: { dateFrom?: string; dateTo?: string } = {};
  if (from) range.dateFrom = new Date(`${from}T00:00:00`).toISOString();
  if (to) {
    const next = new Date(`${to}T00:00:00`);
    next.setDate(next.getDate() + 1);
    range.dateTo = next.toISOString();
  }
  return range;
}

export function summarizeCounts(counts: Record<string, number>): { total: number; exposure: number; policy: number } {
  let total = 0, exposure = 0, policy = 0;
  for (const [action, count] of Object.entries(counts)) {
    total += count;
    const category = getActionCategory(action);
    if (category === "exposure") exposure += count;
    if (category === "policy") policy += count;
  }
  return { total, exposure, policy };
}
```
`frontend/src/lib/relative-time.ts`:
```ts
/** 상대 시각 — 목록에서 "3분 전"이 절대 시각보다 먼저 읽힌다. 이틀 넘으면 날짜로.
 * Relative timestamps for list rows; older than two days falls back to MM-DD HH:mm. */

const pad = (n: number) => String(n).padStart(2, "0");

export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const diffMs = now.getTime() - at.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  const sameDay = at.toDateString() === now.toDateString();
  if (sameDay && hours < 24) return `${hours}시간 전`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const hhmm = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (at.toDateString() === yesterday.toDateString()) return `어제 ${hhmm}`;
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${hhmm}`;
}
```
`api.ts`: add `target: string | null;` to `AuditEntry`; add to `AuditPage`: `requesters: string[]; targets: string[]; counts_by_action: Record<string, number>; failed_logins: number;`; add `target?: string;` to the opts and `if (opts.target) params.set("target", opts.target);`.
`admin-tabs.ts`: `export const ADMIN_TAB_IDS = ["sources", "access", "ai", "users", "audit"] as const;`
`app/admin/audit/page.tsx` — whole file:
```tsx
"use client";

/** 예전 주소 호환 — 감사 로그는 관리 콘솔의 다섯 번째 탭이 됐다. 딥링크·안내서 링크가 깨지지
 * 않게 ?tab=audit로 보낸다. / legacy route: the audit log now lives in the admin console tab. */

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AuditRedirectPage() {
  const router = useRouter();
  useEffect(() => { router.replace("/admin?tab=audit"); }, [router]);
  return null;
}
```

- [ ] **Step 4: Run** the three vitest files → PASS; `npx tsc --noEmit` → the only errors should be in components not yet updated (AdminTabs `TAB_META` missing `audit`) — fix in Task 5; for now add `audit: { label: "admin.tab.audit", desc: "admin.tab.auditDesc", icon: <ClipboardIcon size={15} /> }` to `TAB_META` and the i18n key `"admin.tab.auditDesc": { ko: "누가 언제 실제 값을 봤고 무엇을 바꿨는지 — 지울 수 없는 장부입니다.", en: "Who saw real values and who changed what — an append-only ledger." }` so tsc is clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/audit.ts frontend/src/lib/audit.test.ts frontend/src/lib/relative-time.ts frontend/src/lib/relative-time.test.ts frontend/src/lib/api.ts frontend/src/lib/admin-tabs.ts frontend/src/lib/admin-tabs.test.ts frontend/src/app/admin/audit/page.tsx frontend/src/components/admin/AdminTabs.tsx frontend/src/lib/i18n.ts
git commit -m "feat(admin): audit helpers, API fields and the audit tab id — 감사 화면 순수 로직·탭 id"
```

---

### Task 5: v2 CSS block, `AdminLockBar`, `AdminTabs` counts/desc, page wiring (P1, P2)

**Files:**
- Modify: `frontend/src/app/globals.css` (append a block at the end)
- Create: `frontend/src/components/admin/AdminLockBar.tsx`
- Modify: `frontend/src/components/admin/AdminTabs.tsx`
- Modify: `frontend/src/app/admin/page.tsx`
- Modify: `frontend/src/components/icons.tsx` (add `PlayIcon`, `KeyIcon`, `SyncIcon`, `WarningIcon`, `ClockIcon`, `FileIcon`, `PlusIcon`)

**Interfaces:**
- `AdminTabs` props: `active`, `onChange`, `counts?: Partial<Record<AdminTabId, number | string>>`, `dots?: Partial<Record<AdminTabId, "running" | "ok">>`. Renders `.admin-tab__count` after the label when a count exists, `.admin-tab__dot--<state>` when a dot exists; the audit tab is the last tab with `ml-auto`; the hint line shows the **active** tab description (hover still overrides).
- `AdminLockBar` props: `value: string; onChange: (v: string) => void; configured: boolean; hint: string`. Test ids `AdminLockBar-root`, `AdminLockBar-state`, `AdminLockBar-passwordInput`.
- Page state: `adminPassword`, `passwordConfigured` (from `fetchPreviewAllowlistAdmin()` once), counts: `sourceCount` (callback from DataSourcePanel `onLoaded`), `allowCount` (from PreviewAllowlistPanel `onLoaded`), whitelist `items.length`, `auditToday` (from AuditPanel `onTodayCount`).

- [ ] **Step 1: CSS** — append to `frontend/src/app/globals.css`:

```css
/* ── 관리 콘솔 v2 — 섹션 헤더·잠금 바·소스 카드·수집 스테퍼·표·감사 로그 (2026-09-12) ──
   토큰만 쓴다: 라이트 테마는 [data-theme="light"] 토큰 세트가 그대로 담당한다 */
.ctl-field {
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--hairline-strong);
  border-radius: 8px;
  background: var(--surface-card);
  color: var(--ink);
  font-size: 13px;
}
.ctl-field::placeholder { color: var(--muted-soft); }
button.ctl-field { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; cursor: pointer; }
button.ctl-field:disabled { opacity: 0.45; cursor: default; }
.ctl-field--danger { color: var(--error); }

.sec-head { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
.sec-head__tile {
  width: 26px; height: 26px; border-radius: 7px; flex: none;
  background: var(--surface-elevated); color: var(--body-text);
  display: grid; place-items: center;
}
.sec-head__title { margin: 0; color: var(--ink); font-size: 15px; font-weight: 700; }
.sec-head__right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.sec-desc { margin: 0 0 12px 36px; font-size: 12.5px; color: var(--muted); }
.cnt-pill {
  font-family: var(--font-mono); font-size: 11px; font-weight: 700;
  padding: 1px 8px; border-radius: 999px;
  background: var(--surface-elevated); color: var(--slate);
}

.badge--ok { background: color-mix(in srgb, var(--deep-green) 16%, var(--surface-card)); color: var(--deep-green); }
.badge--err { background: color-mix(in srgb, var(--error) 16%, var(--surface-card)); color: var(--error); }
.badge--warn { background: color-mix(in srgb, var(--code-fn) 18%, var(--surface-card)); color: var(--code-fn); }
.badge--view { background: color-mix(in srgb, var(--obj-view) 18%, var(--surface-card)); color: var(--obj-view); }
.badge--login { background: var(--surface-elevated); color: var(--body-text); }
.badge--plain { text-transform: none; letter-spacing: 0; }
.badge svg { width: 11px; height: 11px; vertical-align: -1px; margin-right: 4px; }
.badge__dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: currentColor; margin-right: 5px; vertical-align: 1px; }

.admin-tab__count {
  font-family: var(--font-mono); font-size: 11px; font-weight: 700;
  padding: 1px 7px; border-radius: 999px;
  background: var(--surface-elevated); color: var(--slate);
}
.admin-tab[aria-selected="true"] .admin-tab__count {
  background: color-mix(in srgb, var(--primary) 18%, var(--surface-card)); color: var(--primary);
}
.admin-tab__dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted-soft); }
.admin-tab__dot--running { background: var(--code-fn); }
.admin-tab__dot--ok { background: var(--deep-green); }
.admin-tabs__kbd { margin-left: auto; display: inline-flex; gap: 4px; align-items: center; font-size: 12px; color: var(--muted); }
.admin-tabs__kbd kbd { font-family: var(--font-mono); font-size: 11px; border: 1px solid var(--hairline-strong); border-radius: 5px; padding: 0 5px; color: var(--slate); }

.lock-bar {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 10px 14px; border-radius: 10px; background: var(--surface-elevated); margin-bottom: 18px;
}
.lock-bar__desc { flex: 1; min-width: 200px; font-size: 12.5px; color: var(--muted); }
.lock-bar__input { width: 260px; }

.banner { display: flex; align-items: flex-start; gap: 10px; padding: 10px 14px; border-radius: 10px; font-size: 13px; margin: 0 0 12px; }
.banner svg { flex: none; margin-top: 2px; }
.banner--warn { background: color-mix(in srgb, var(--code-fn) 14%, var(--surface-card)); color: var(--code-fn); border: 1px solid color-mix(in srgb, var(--code-fn) 40%, var(--hairline)); }
.banner--ok { background: color-mix(in srgb, var(--deep-green) 12%, var(--surface-card)); color: var(--deep-green); border: 1px solid color-mix(in srgb, var(--deep-green) 35%, var(--hairline)); }
.banner--err { background: color-mix(in srgb, var(--error) 12%, var(--surface-card)); color: var(--error); border: 1px solid color-mix(in srgb, var(--error) 35%, var(--hairline)); }

.src-card { display: grid; grid-template-columns: 34px 1fr; gap: 6px 12px; padding: 12px 14px; }
.src-card__engine { grid-row: 1 / -1; width: 34px; height: 34px; border-radius: 9px; background: var(--surface-elevated); color: var(--body-text); display: grid; place-items: center; }
.src-card__engine--mssql { color: var(--primary); }
.src-card__engine--postgres { color: var(--obj-view); }
.src-card__top, .src-card__meta, .src-card__error, .src-card__actions, .src-card__form { grid-column: 2; }
.src-card__top { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.src-card__name { color: var(--ink); font-weight: 700; font-size: 14.5px; }
.src-card__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; font-size: 12.5px; color: var(--muted); }
.src-card__kv { display: inline-flex; align-items: center; gap: 5px; }
.src-card__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 4px; }
.src-card__spacer { flex: 1; }
.src-card__error { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--error); }
.src-card--off { opacity: 0.72; }

details.collapse { border: 1px dashed var(--hairline-strong); border-radius: 12px; }
details.collapse > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 8px; padding: 12px 14px; color: var(--body-text); font-weight: 600; font-size: 13.5px; }
details.collapse > summary::-webkit-details-marker { display: none; }
details.collapse[open] > summary { border-bottom: 1px solid var(--hairline); }
.form-grid { padding: 14px; display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; }
.form-grid label { display: flex; flex-direction: column; gap: 5px; font-size: 11.5px; font-weight: 600; letter-spacing: 0.3px; color: var(--muted); }
.form-grid .ctl-field { width: 100%; }
.span-2 { grid-column: span 2; } .span-3 { grid-column: span 3; } .span-6 { grid-column: span 6; }
.form-grid__foot { grid-column: span 6; display: flex; align-items: center; gap: 10px; }
.seg { display: inline-flex; border: 1px solid var(--hairline-strong); border-radius: 8px; overflow: hidden; height: 36px; }
.seg__btn { border: 0; background: var(--surface-card); color: var(--muted); padding: 0 12px; display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; cursor: pointer; }
.seg__btn--on { background: var(--surface-elevated); color: var(--ink); }

.stepper { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px; }
.step { padding: 12px 14px; display: grid; grid-template-columns: 26px 1fr; gap: 2px 10px; }
.step__n { grid-row: span 2; width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 12px; background: var(--surface-elevated); color: var(--muted); }
.step--done .step__n { background: color-mix(in srgb, var(--deep-green) 18%, var(--surface-card)); color: var(--deep-green); }
.step--active .step__n { background: var(--primary); color: var(--on-primary); }
.step--active { border-color: color-mix(in srgb, var(--primary) 55%, var(--hairline)); }
.step__title { color: var(--ink); font-weight: 700; font-size: 13.5px; display: flex; align-items: center; gap: 8px; }
.step__sub { font-size: 12px; color: var(--muted); }
.job-row { display: grid; grid-template-columns: 64px 92px 1fr auto auto; gap: 12px; align-items: center; padding: 8px 12px; border-top: 1px solid var(--hairline); font-size: 12.5px; }
.job-row:first-child { border-top: 0; }
.job-row__id { font-family: var(--font-mono); color: var(--slate); }
.job-row__who, .job-row__when { color: var(--muted); font-variant-numeric: tabular-nums; }

.data-table { width: 100%; border-collapse: collapse; font-size: 13px; table-layout: fixed; }
.data-table th { text-align: left; font-size: 11px; letter-spacing: 0.6px; text-transform: uppercase; color: var(--muted); font-weight: 600; padding: 8px 10px; border-bottom: 1px solid var(--hairline); }
.data-table td { padding: 9px 10px; border-bottom: 1px solid var(--hairline); vertical-align: middle; }
.data-table tr:last-child td { border-bottom: 0; }
.data-table tr.reveal-host:hover td { background: var(--surface-soft); }
.avatar { width: 24px; height: 24px; border-radius: 50%; background: var(--surface-elevated); color: var(--ink); font-weight: 700; font-size: 11px; display: inline-grid; place-items: center; margin-right: 8px; vertical-align: middle; }
.chip-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 14px; font-size: 12.5px; color: var(--muted); }
.src-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 999px; border: 1px solid var(--hairline-strong); background: var(--surface-card); color: var(--body-text); font-size: 12.5px; cursor: pointer; }
.src-chip--on { border-color: var(--primary); color: var(--ink); background: color-mix(in srgb, var(--primary) 12%, var(--surface-card)); }
.schema-chip { font-family: var(--font-mono); font-size: 12px; padding: 3px 10px; border-radius: 999px; background: var(--surface-elevated); color: var(--body-text); display: inline-flex; gap: 6px; align-items: center; }
.empty-state { border: 1px dashed var(--hairline-strong); border-radius: 12px; padding: 22px; text-align: center; color: var(--muted); font-size: 13px; display: flex; flex-direction: column; align-items: center; gap: 8px; }
.empty-state svg { color: var(--muted-soft); }
.stat-tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 12px; }
.stat-tiles--4 { grid-template-columns: repeat(4, 1fr); }
.stat-tile { padding: 14px 16px; }
.stat-tile__k { font-size: 11px; letter-spacing: 0.8px; text-transform: uppercase; color: var(--muted); font-weight: 600; margin-bottom: 8px; }
.stat-tile__v { font-size: 28px; font-weight: 700; color: var(--stat-ink); letter-spacing: -1px; line-height: 1; font-variant-numeric: tabular-nums; }
.stat-tile__v--plain { color: var(--ink); }
.stat-tile__v--danger { color: var(--error); }
.stat-tile__sub { font-size: 12px; color: var(--muted); margin-top: 6px; }

.period-chips { display: inline-flex; gap: 4px; padding: 3px; border: 1px solid var(--hairline-strong); border-radius: 999px; background: var(--surface-card); }
.period-chips__btn { border: 0; background: none; color: var(--muted); font-size: 12.5px; font-weight: 600; padding: 4px 12px; border-radius: 999px; cursor: pointer; }
.period-chips__btn--on { background: var(--surface-elevated); color: var(--ink); }
.audit-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 12px 0; }
.audit-filters__dates { display: inline-flex; align-items: center; gap: 6px; }
.audit-filters__clear { margin-left: auto; }
.audit-legend { display: flex; flex-wrap: wrap; gap: 6px 12px; font-size: 12px; color: var(--muted); margin: 0 0 10px 36px; }
.audit-row { cursor: pointer; }
.audit-row:focus-visible { outline: 2px solid var(--focus-blue); outline-offset: -2px; }
.audit-when { white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--ink); }
.audit-when small { display: block; color: var(--muted); font-size: 11.5px; }
.audit-target { font-family: var(--font-mono); font-size: 12px; color: var(--body-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.audit-who { white-space: nowrap; color: var(--body-text); overflow: hidden; text-overflow: ellipsis; }
.pager { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-top: 1px solid var(--hairline); font-size: 12.5px; color: var(--muted); }
.pager__range { font-family: var(--font-mono); color: var(--body-text); }
.pager__spacer { flex: 1; }

.modal-backdrop { position: fixed; inset: 0; z-index: 60; background: color-mix(in srgb, var(--canvas) 70%, transparent); display: grid; place-items: center; padding: 20px; }
.modal { width: min(760px, 100%); background: var(--surface-card); border: 1px solid var(--hairline-strong); border-radius: 8px; padding: 18px 20px; display: flex; flex-direction: column; gap: 14px; max-height: 90vh; }
.modal__head { display: flex; align-items: center; gap: 10px; }
.modal__title { margin: 0; font-size: 15px; font-weight: 700; color: var(--ink); }
.modal__close { margin-left: auto; }
.modal__grid { display: grid; grid-template-columns: 110px 1fr; gap: 8px 14px; font-size: 13px; }
.modal__key { color: var(--muted); font-size: 12px; letter-spacing: 0.4px; text-transform: uppercase; padding-top: 2px; }
.modal__pre { margin: 0; white-space: pre-wrap; word-break: break-all; font-family: var(--font-mono); font-size: 12.5px; background: var(--surface-elevated); border-radius: 6px; padding: 10px 12px; max-height: 50vh; overflow: auto; color: var(--body-text); }

@media (max-width: 720px) {
  .form-grid { grid-template-columns: repeat(2, 1fr); }
  .span-3, .span-6, .form-grid__foot { grid-column: span 2; }
  .stepper, .stat-tiles, .stat-tiles--4 { grid-template-columns: 1fr; }
  .lock-bar__input { width: 100%; }
  .sec-desc, .audit-legend { margin-left: 0; }
}
```

- [ ] **Step 2: Icons** — append to `frontend/src/components/icons.tsx` (same `Svg` wrapper, 24 viewBox):

```tsx
export function PlayIcon(props: IconProps) {
  return <Svg {...props}><path d="M7 4l13 8-13 8V4z" /></Svg>;
}
export function KeyIcon(props: IconProps) {
  return <Svg {...props}><circle cx="8" cy="12" r="4" /><path d="M12 12h9M18 12v3M15 12v2" /></Svg>;
}
export function SyncIcon(props: IconProps) {
  return <Svg {...props}><path d="M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3" /><path d="M18 3v4h-4M6 21v-4h4" /></Svg>;
}
export function WarningIcon(props: IconProps) {
  return <Svg {...props}><path d="M12 3L2.5 20h19L12 3z" /><path d="M12 10v4M12 17v.5" /></Svg>;
}
export function ClockIcon(props: IconProps) {
  return <Svg {...props}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></Svg>;
}
export function FileIcon(props: IconProps) {
  return <Svg {...props}><path d="M6 3h8l4 4v14H6V3z" /><path d="M14 3v4h4" /></Svg>;
}
export function PlusIcon(props: IconProps) {
  return <Svg {...props}><path d="M12 5v14M5 12h14" /></Svg>;
}
```

- [ ] **Step 3: `AdminLockBar.tsx`**

```tsx
"use client";

/** 관리 비밀번호 잠금 바 — 탭마다 흩어져 있던 "수정 비밀번호" 입력을 한 곳으로. 상태 pill이
 * 잠김/열림을, 설명이 "무엇이 풀리는지"를 말한다. 값은 부모(관리 콘솔)가 쥔다.
 * One lock bar per tab: state pill + what it unlocks; the password lives in the page. */

import { LockIcon, LockOpenIcon } from "@/components/icons";

interface AdminLockBarProps {
  value: string;
  onChange: (value: string) => void;
  /** PREVIEW_ADMIN_PASSWORD가 서버에 설정돼 있는가 — 없으면 입력 대신 안내만 */
  configured: boolean;
  /** 이 탭에서 풀리는 조작 한 줄 */
  hint: string;
}

export function AdminLockBar({ value, onChange, configured, hint }: AdminLockBarProps) {
  const open = configured && value.length > 0;
  return (
    <div className="lock-bar" data-testid="AdminLockBar-root">
      {open ? <LockOpenIcon size={16} /> : <LockIcon size={16} />}
      <span className={`badge badge--plain ${open ? "badge--ok" : "badge--err"}`}
            data-testid="AdminLockBar-state">
        <span className="badge__dot" />{open ? "열림" : "잠김"}
      </span>
      <span className="lock-bar__desc">
        {configured
          ? hint
          : "PREVIEW_ADMIN_PASSWORD가 설정되지 않아 수정 기능이 잠겨 있습니다 — 서버 .env에 값을 넣고 백엔드를 재기동하세요."}
      </span>
      {configured && (
        <input
          className="ctl-field lock-bar__input"
          type="password"
          autoComplete="off"
          placeholder="관리 비밀번호 (.env PREVIEW_ADMIN_PASSWORD)"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          data-testid="AdminLockBar-passwordInput"
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: `AdminTabs.tsx`** — add props `counts`, `dots`; add `audit` to `TAB_META` (ClipboardIcon); remove the `<Link>`; render tabs from `ADMIN_TAB_IDS`, giving the `audit` tab `className="admin-tab ml-auto"`; after the label render
```tsx
{counts?.[id] !== undefined && <span className="admin-tab__count">{counts[id]}</span>}
{dots?.[id] && <span className={`admin-tab__dot admin-tab__dot--${dots[id]}`} aria-hidden />}
```
and change the hint line to show `t(TAB_META[hovered ?? active].desc)` with a trailing `<span className="admin-tabs__kbd"><kbd>←</kbd><kbd>→</kbd> 탭 이동</span>` (the hint `<p>` becomes a flex row). Keep test ids `AdminTabs-root`, `AdminTabs-tab-<id>`, `AdminTabs-hint`; the removed `AdminPage-auditLink` is replaced by `AdminTabs-tab-audit`.

- [ ] **Step 5: `page.tsx` wiring** — add state `adminPassword`, `passwordConfigured` (`useEffect` → `fetchPreviewAllowlistAdmin().then(r => setPasswordConfigured(r.password_configured))`), `sourceCount`, `allowCount`, `auditToday`; pass `counts={{ sources: sourceCount, access: allowCount, users: items.length, audit: auditToday === null ? undefined : `오늘 ${auditToday}` }}` and `dots={{ ai: embedBusy ? "running" : embedJob?.status === "done" ? "ok" : undefined }}`; render `<AdminLockBar value={adminPassword} onChange={setAdminPassword} configured={passwordConfigured} hint="…" />` at the top of the `sources` panel (hint: "관리 비밀번호를 넣으면 이 탭의 등록·수정·삭제 조작이 풀립니다. 접속 비밀번호와 다른 값입니다.") and the `access` panel (hint: "허용 스키마 추가·해제와 비공개 스키마 표시 토글이 풀립니다."); pass `password={adminPassword} passwordConfigured={passwordConfigured}` to `DataSourcePanel`, `PreviewAllowlistPanel`, `HiddenSchemaPanel` (props added in Tasks 6/8 — for this task add the props to the three components' interfaces and use them in place of their local `password` state, deleting the local inputs `DataSourcePanel-passwordInput`, `AdminPage-previewAllowPasswordInput`, `AdminPage-hiddenSchemaPasswordInput` and the `passwordConfigured` fetches they did themselves). Add the `audit` panel: `<div {...panelProps("audit")}><AuditPanel onTodayCount={setAuditToday} /></div>` (component in Task 9; until then render nothing and keep tsc clean by adding the panel in Task 9).

- [ ] **Step 6: Verify** — `cd frontend && npx tsc --noEmit && npm run lint && npx vitest run` → clean. Start the fixture stack (memory recipe) and eyeball `/admin`: lock bar shows 잠김 → typing a value flips to 열림; tab counts render.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/app/globals.css frontend/src/components/icons.tsx frontend/src/components/admin/AdminLockBar.tsx frontend/src/components/admin/AdminTabs.tsx frontend/src/app/admin/page.tsx frontend/src/components/admin/DataSourcePanel.tsx frontend/src/components/admin/PreviewAllowlistPanel.tsx frontend/src/components/admin/HiddenSchemaPanel.tsx
git commit -m "feat(admin): v2 styles, shared lock bar, tab counts and descriptions — 관리 콘솔 v2 스타일·잠금 바·탭 카운트"
```

---

### Task 6: `DataSourcePanel` card + collapsible form + banners (P3, P4)

**Files:**
- Modify: `frontend/src/components/admin/DataSourcePanel.tsx:139-692` (render), keep the exported helpers `buildCreateInput`, `buildUpdateInput`, `isSourceFormValid`, `buildDependentLines`, `formatCascadeSummary` unchanged so `DataSourcePanel.test.ts` keeps passing.

**Interfaces:**
- Props: `{ password: string; passwordConfigured: boolean; onLoaded?: (count: number) => void }`.
- Test ids kept: `DataSourcePanel-root/-count/-guideDownload/-keyMissing/-list/-item-<id>/-managedBadge-<id>/-status-<id>/-error-<id>/-testButton-<id>/-collectButton-<id>/-editButton-<id>/-toggleButton-<id>/-deleteButton-<id>/-deleteConfirm-<id>/…/-form/-nameInput/-hostInput/-portInput/-databaseInput/-usernameInput/-secretInput/-filePathInput/-createButton/-message/-errorMessage`. New: `DataSourcePanel-engineSelect` moves onto the segmented group with buttons `DataSourcePanel-engine-postgres` / `-engine-sqlite`; `DataSourcePanel-newSource` on the `<details>`; `DataSourcePanel-lastTest-<id>`.

- [ ] **Step 1: Render the card** — replace the `<li>` body with:

```tsx
<li key={item.id}
    className={`card src-card reveal-host text-sm${item.is_enabled ? "" : " src-card--off"}`}
    data-testid={`DataSourcePanel-item-${item.id}`}>
  <div className={`src-card__engine src-card__engine--${item.engine}`}>
    {item.engine === "sqlite" ? <FileIcon size={18} /> : <DatabaseIcon size={18} />}
  </div>
  <div className="src-card__top">
    <span className="src-card__name">{item.name}</span>
    <span className="badge badge--muted">{item.engine}</span>
    <span className="badge badge--muted">{item.access_mode}</span>
    {item.is_managed && (
      <span className="badge badge--muted badge--plain" data-testid={`DataSourcePanel-managedBadge-${item.id}`}>
        <LockIcon size={11} />관리형 · 읽기전용
      </span>
    )}
    <span className={`badge badge--plain ${item.is_enabled ? "badge--ok" : "badge--muted"}`}
          data-testid={`DataSourcePanel-status-${item.id}`}>
      <span className="badge__dot" />{item.is_enabled ? "활성" : "비활성"}
    </span>
  </div>
  <div className="src-card__meta">
    <span className="font-mono" style={{ color: "var(--slate)" }}>{formatLocation(item)}</span>
    <span className="src-card__kv"><KeyIcon size={12} />{item.has_password ? "비밀번호 설정됨" : "비밀번호 없음"}</span>
    <span className="src-card__kv"
          style={{ color: item.last_error ? "var(--error)" : item.last_ok_at ? "var(--deep-green)" : undefined }}
          data-testid={`DataSourcePanel-lastTest-${item.id}`}>
      {item.last_error ? <WarningIcon size={12} /> : item.last_ok_at ? <CheckIcon size={12} /> : <ClockIcon size={12} />}
      {item.last_error
        ? `연결 실패 · ${item.last_ok_at ? formatRelativeTime(item.last_ok_at) : "성공 이력 없음"}`
        : item.last_ok_at ? `연결 성공 · ${formatRelativeTime(item.last_ok_at)}` : "테스트 이력 없음"}
    </span>
  </div>
  {item.last_error && (
    <p className="src-card__error" data-testid={`DataSourcePanel-error-${item.id}`}>
      <WarningIcon size={13} />{item.last_error}
    </p>
  )}
  <div className="src-card__actions">
    {/* 기존 버튼 블록 그대로 — 클래스만 icon-button (연결 테스트·수집), reveal 세 개; 삭제는 ctl-field--danger */}
    …
    <span className="src-card__spacer" />
    …reveal buttons…
  </div>
  {deleteConfirm?.id === item.id && (<div className="danger-box src-card__form …">…기존 그대로…</div>)}
  {editingId === item.id && (<div className="src-card__form …">…기존 편집 폼, 입력에 className="ctl-field"…</div>)}
</li>
```
Managed sources render `연결 테스트` disabled with `title="관리형 소스는 n8n이 접속합니다"` and a `badge--plain` note `수집은 아래 카탈로그 수집에서`.

- [ ] **Step 2: Collapsible create form** — replace the `keyConfigured && <div … DataSourcePanel-form>` block with:

```tsx
{keyConfigured && (
  <details className="collapse" data-testid="DataSourcePanel-newSource">
    <summary><PlusIcon size={14} />새 소스 등록 <span className="badge badge--muted badge--plain">PostgreSQL · SQLite</span></summary>
    <div className="form-grid" data-testid="DataSourcePanel-form">
      <label className="span-2">이름<input className="ctl-field" placeholder="svca" value={createForm.name} onChange=… data-testid="DataSourcePanel-nameInput" /></label>
      <label className="span-2">엔진
        <span className="seg" role="group" data-testid="DataSourcePanel-engineSelect">
          <button type="button" className={`seg__btn${createForm.engine === "postgres" ? " seg__btn--on" : ""}`} onClick={() => setCreateForm({ ...createForm, engine: "postgres" })} data-testid="DataSourcePanel-engine-postgres"><DatabaseIcon size={13} />PostgreSQL</button>
          <button type="button" className={`seg__btn${createForm.engine === "sqlite" ? " seg__btn--on" : ""}`} onClick={() => setCreateForm({ ...createForm, engine: "sqlite" })} data-testid="DataSourcePanel-engine-sqlite"><FileIcon size={13} />SQLite</button>
        </span>
      </label>
      {createForm.engine === "sqlite" ? (
        <label className="span-6">파일 경로 (backend 컨테이너 안)<input className="ctl-field" placeholder="/mnt/sources/svcc/app.db" … data-testid="DataSourcePanel-filePathInput" /></label>
      ) : (<>
        <label className="span-2">호스트 (네트워크 별칭)<input className="ctl-field" placeholder="svca-db" … data-testid="DataSourcePanel-hostInput" /></label>
        <label className="span-2">포트<input className="ctl-field" type="number" … data-testid="DataSourcePanel-portInput" /></label>
        <label className="span-2">database<input className="ctl-field" placeholder="billing" … data-testid="DataSourcePanel-databaseInput" /></label>
        <label className="span-2">읽기전용 계정<input className="ctl-field" placeholder="dbviewer_ro" … data-testid="DataSourcePanel-usernameInput" /></label>
        <label className="span-3">접속 비밀번호 (선택)<input className="ctl-field" type="password" autoComplete="off" placeholder="보안 채널로 받은 값" … data-testid="DataSourcePanel-secretInput" /></label>
      </>)}
      <div className="form-grid__foot">
        <button className="btn-primary" disabled={!canRegister} title=… onClick={handleCreate} data-testid="DataSourcePanel-createButton"><PlusIcon size={13} />등록</button>
        <span className="text-xs" style={{ color: "var(--muted)" }}>등록 직후 [연결 테스트]로 database·version이 회신값과 같은지 확인하세요.</span>
      </div>
    </div>
  </details>
)}
```
Section header becomes `.sec-head` (tile DatabaseIcon, title, `.cnt-pill` count with `DataSourcePanel-count`, right: guide download `btn-secondary`), description `.sec-desc`. `keyMissing` becomes `<div className="banner banner--warn" data-testid="DataSourcePanel-keyMissing"><WarningIcon size={15} /><span><b>SOURCE_SECRET_KEY가 설정되지 않았습니다.</b> …</span></div>`. `message`/`error` become `.banner--ok` / `.banner--err` (same test ids). Call `onLoaded?.(res.items.length)` inside `reload`.

- [ ] **Step 3: Verify** — `npx vitest run src/components/admin` (pure tests still green), `npx tsc --noEmit`, `npm run lint`; on the fixture stack: card renders for 사내 MSSQL, form collapsed, opens on click, engine segment toggles fields.

- [ ] **Step 4: Commit** — `git commit -m "feat(admin): source cards with engine tile and status pills, collapsible registration — 소스 카드·접이식 등록 폼"`

---

### Task 7: `CollectPanel` stepper + job rows (P5)

**Files:**
- Modify: `frontend/src/components/admin/CollectPanel.tsx`
- Modify: `frontend/src/lib/i18n.ts` (add keys `collect.running`, `collect.pending`, `collect.cancelled`, `collect.step1Only`, `collect.step2Only`, `collect.stepDone`)

**Interfaces:** props unchanged. Test ids kept: `CollectPanel-root/-catalogButton/-viewDepsButton/-fullButton/-current/-stageRow/-cancelButton/-chunkProgress/-counts/-recentList/-errorText/-failedText`. New: `CollectPanel-step-1`, `-step-2`, `-step-3`, `CollectPanel-job-<id>`.

- [ ] **Step 1: i18n keys**

```ts
  "collect.running": { ko: "진행 중", en: "Running" },
  "collect.pending": { ko: "대기", en: "Pending" },
  "collect.cancelled": { ko: "취소됨", en: "Cancelled" },
  "collect.step1Only": { ko: "1단계만", en: "Step 1 only" },
  "collect.step2Only": { ko: "2단계만", en: "Step 2 only" },
  "collect.stepDone": { ko: "완료", en: "Done" },
  "collect.stepDoneHint": { ko: "스냅샷이 ready가 되면 화면에 반영됩니다", en: "Applied once the snapshot is ready" },
```

- [ ] **Step 2: Stepper** — replace `StageProgress` with a pure state derivation and three `.card.step` cards inside `CollectPanel`:

```tsx
/** 3단 스테퍼 상태 — 잡 단계에서 ①카탈로그 ②뷰 의존·파싱 ③완료 각각의 done/active/pending */
export function getStepStates(job: CollectJob | null): ("done" | "active" | "pending" | "failed")[] {
  if (!job) return ["pending", "pending", "pending"];
  if (job.stage === "failed") return ["failed", "failed", "pending"];
  switch (job.stage) {
    case "catalog_running": return ["active", "pending", "pending"];
    case "catalog_done": return ["done", "pending", "pending"];
    case "deps_running": return ["done", "active", "pending"];
    case "ready": return ["done", "done", "done"];
  }
}
```
(export it and add three vitest cases in a new `CollectPanel.test.ts`: running → `["active","pending","pending"]`, `catalog_done` → `["done","pending","pending"]`, ready → all done.)
Render: `<div className="stepper" data-testid="CollectPanel-stageRow">` with cards `data-testid="CollectPanel-step-N"`, class `step step--<state>`, number cell (`CheckIcon` when done, digit otherwise), title = `t("collect.step1")` etc. with a badge (`badge--ok 완료 / badge--warn 진행 중 / badge--muted 대기 / badge--err 실패`), sub = counts text for step 1 (`countText`), chunk progress `분할 진행 d / t · 스냅샷 #n` for step 2, `t("collect.stepDoneHint")` for step 3. Failed job: `CollectPanel-failedText` banner under the stepper.
Buttons row: `btn-secondary` 1단계만 / 2단계만, `btn-primary` 전체 실행 (with `PlayIcon`), and when running a right-aligned `icon-button ctl-field--danger` 중단 (`StopIcon`) — ids as before. A `.rate-bar` under the buttons while running (chunk progress).
Recent jobs: `<div className="card" data-testid="CollectPanel-recentList">` with `.job-row` per job (`CollectPanel-job-<id>`): id, status badge (`ready`→ok 완료, running→warn 진행 중, `failed` whose error starts with `cancelled by` → muted 취소됨, other failed → err 실패, `catalog_done` → muted 1단계 완료), `mode · 스냅샷 #n`, `triggered_by`, `formatRelativeTime(updated_at)`. Include the current job as the first row.

- [ ] **Step 3: Verify** — vitest (new test), tsc, lint; fixture stack: trigger 전체 실행 → stepper animates to ① active → done; recent rows show.

- [ ] **Step 4: Commit** — `git commit -m "feat(admin): collection stepper and job rows — 수집 스테퍼·잡 목록"`

---

### Task 8: Access tab (allowlist table, source chips, hidden-schema switch), Users tab, AI tab, empty states (P6, P7, P8, P9)

**Files:**
- Modify: `frontend/src/components/admin/PreviewAllowlistPanel.tsx`
- Modify: `frontend/src/components/admin/HiddenSchemaPanel.tsx`
- Modify: `frontend/src/components/admin/AdUserList.tsx`
- Create: `frontend/src/components/admin/SourceChips.tsx`
- Modify: `frontend/src/app/admin/page.tsx` (access/ai/users panels)

**Interfaces:**
- `PreviewAllowlistPanel` props: `{ sourceId: number | null; password: string; passwordConfigured: boolean; onLoaded?: (allowed: number) => void }`. Test ids kept (`AdminPage-previewAllowSection/-Count/-SearchInput/-NoteInput/-Scroll/-Table/-Row-<schema>/-RemoveButton-<schema>/-AddButton-<schema>/-EmptyState/-Message/-Error`); `AdminPage-previewAllowNoPassword` removed (lock bar covers it).
- `HiddenSchemaPanel` props: `{ password: string; passwordConfigured: boolean }`. Ids kept: `AdminPage-hiddenSchemaSection/-Count/-List/-Toggle/-State/-Message/-Error`; `-NoPassword` and `-PasswordInput` removed. `-Toggle` is now `<input type="checkbox" role="switch" className="ctl-switch">`.
- `SourceChips` props: `{ value: number | null; onChange: (id: number | null) => void }` → fetches `fetchDataSources()`, renders `.src-chip` per source (`SourceChips-chip-<id>`, MSSQL managed id maps to `null`), hides itself when only one source exists.
- `AdUserList` ids kept; the allow button uses `PlusIcon` and `reveal-action`; empty state uses `.empty-state` with `UsersIcon` and a `동기화가 필요합니다` hint (the sync button stays in the page header).

- [ ] **Step 1: PreviewAllowlistPanel** — header `.sec-head` (ShieldIcon tile, title, `.cnt-pill` `허용 {entries.length} · 전체 {schemas.length}` with id `AdminPage-previewAllowCount`, right: search `ctl-field`), `.sec-desc` text as today, `<div className="card">` around a `.data-table` (columns 스키마 / 객체 / 메모 / 등록 / actions; 객체 as `.cnt-pill`; 등록 = `added_by` + ` · ` + `created_at` date if the entry has it, else `added_by`), rows `reveal-host`; actions: `icon-button reveal-action ctl-field--danger` 허용 해제 (BanIcon) / `btn-primary reveal-action` 허용 추가 (PlusIcon). The note input stays above the table as `ctl-field`. `canEdit = passwordConfigured && password.length > 0`. Messages → banners.

- [ ] **Step 2: HiddenSchemaPanel** — header (EyeOffIcon tile, title, count pill; right: state badge `AdminPage-hiddenSchemaState` (`badge--muted` 목록에서 숨김 / `badge--view` 목록에 표시) + `<input type="checkbox" role="switch" className="ctl-switch" checked={render} disabled={!canEdit || schemas.length === 0} onChange={(e) => toggle(e.target.checked)} data-testid="AdminPage-hiddenSchemaToggle" />`), `.sec-desc`, list: when `render` show `.schema-chip` per schema (EyeOffIcon), else the count sentence — keep id `AdminPage-hiddenSchemaList`.

- [ ] **Step 3: SourceChips + page access panel** — replace the `미리보기 허용 대상 소스` + `SourceSelector` block with `<div className="chip-row">대상 소스 <SourceChips value={previewSourceId} onChange={setPreviewSourceId} /></div>` (import `fetchDataSources` type `DataSourceItem`; managed MSSQL → `null` value; icon `FileIcon` for sqlite, `DatabaseIcon` otherwise).

- [ ] **Step 4: Users panel (page.tsx)** — section header `.sec-head` (UsersIcon tile, "로그인 화이트리스트", `.cnt-pill` items.length; right: `btn-secondary` AD 전체 동기화 with `SyncIcon`, id kept); add row inputs `ctl-field`; `<div className="card"><table className="data-table" data-testid="AdminPage-whitelistTable">` rows `reveal-host` with `.avatar` initial + mono id, name (`name ?? "—"`) + note, 등록 = `added_by · date`, delete `icon-button reveal-action ctl-field--danger` (TrashIcon). `AdUserList`: header `.sec-head` (SearchIcon tile, count pill, search `ctl-field` right), `.card` + `.data-table`, `.avatar`, allow button `icon-button reveal-action` with `PlusIcon` + "허용", whitelisted → `badge--ok badge--plain` 허용됨 (CheckIcon); empty → `.empty-state` (UsersIcon + text). Page `message`/`error` → banners (ids kept).

- [ ] **Step 5: AI panel (page.tsx)** — `.sec-head` (SparklesIcon tile, title, status badge: running → `badge--warn` 진행 중, done → `badge--ok` 완료, failed → `badge--err` 실패), `.sec-desc`, `.stat-tiles` with three `.card.stat-tile`: 진행 (`progress_done` or `result.indexed`), 전체 (`progress_total` or `indexed+skipped+remaining`), 상태 (badge + `formatRelativeTime` of nothing → "이번 세션" text) — when no job yet, tiles show `—`. Keep `AdminPage-embedIndexButton/-Progress/-Result/-ErrorText/-StartErrorText` ids; result/error become banners.

- [ ] **Step 6: Verify** — tsc, lint, vitest; fixture stack: access tab chips show only when ≥2 sources (fixture has 1 → hidden), allowlist rows with pills, switch toggles with password; users tab avatars, AD empty state.

- [ ] **Step 7: Commit** — `git commit -m "feat(admin): access, users and AI tabs restyled with tables, chips, switch and empty states — 공개 범위·사용자·AI 탭 재구성"`

---

### Task 9: `AuditPanel` — period chips, summary tiles, uniform filters with dropdowns, one-line rows, detail modal (P10)

**Files:**
- Create: `frontend/src/components/admin/AuditPanel.tsx`
- Create: `frontend/src/components/admin/AuditDetailModal.tsx`
- Modify: `frontend/src/app/admin/page.tsx` (mount in the `audit` panel)
- Modify: `frontend/src/lib/i18n.ts` (only if the panel uses `t()`; it uses Korean literals like the other panels — no keys)

**Interfaces:**
- `AuditPanel` props: `{ onTodayCount?: (n: number) => void }`. Test ids: `AuditPanel-root`, `AuditPanel-total`, `AuditPanel-period-<today|7d|30d|all>`, `AuditPanel-tile-<total|exposure|policy|loginFail>`, `AuditPanel-actionFilter`, `AuditPanel-requesterFilter` (`<select>`), `AuditPanel-targetFilter` (`<input list>` + `<datalist id="AuditPanel-targets">`), `AuditPanel-detailFilter`, `AuditPanel-dateFromFilter`, `AuditPanel-dateToFilter`, `AuditPanel-clearFilters`, `AuditPanel-refreshButton`, `AuditPanel-table`, `AuditPanel-row-<id>`, `AuditPanel-emptyState`, `AuditPanel-prevButton`, `AuditPanel-nextButton`, `AuditPanel-range`, `AuditPanel-pageSize`, `AuditPanel-error`.
- `AuditDetailModal` props: `{ entry: AuditEntry | null; onClose: () => void }`. Ids: `AuditDetailModal-root`, `AuditDetailModal-closeButton`, `AuditDetailModal-detail`. Closes on Esc, backdrop click and the × button; focuses the close button on open.

- [ ] **Step 1: `AuditDetailModal.tsx`**

```tsx
"use client";

/** 감사 행 상세 — 목록은 한 줄로 자르고, 전문은 여기서 보여준다. 직사각형 모달(라운드 8px),
 * Esc·배경 클릭·× 로 닫는다. / full detail of one audit row; the list keeps rows single-line. */

import { useEffect, useRef } from "react";

import { CloseIcon } from "@/components/icons";
import { ACTION_LABELS, getActionCategory, isFailedEntry } from "@/lib/audit";
import type { AuditEntry } from "@/lib/api";

const CATEGORY_BADGE = { exposure: "badge--warn", policy: "badge--view", ops: "badge--muted", login: "badge--login" } as const;

interface AuditDetailModalProps {
  entry: AuditEntry | null;
  onClose: () => void;
}

export function AuditDetailModal({ entry, onClose }: AuditDetailModalProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!entry) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entry, onClose]);
  if (!entry) return null;
  const badge = isFailedEntry(entry.action, entry.detail) ? "badge--err" : CATEGORY_BADGE[getActionCategory(entry.action)];
  return (
    <div className="modal-backdrop" onClick={onClose} data-testid="AuditDetailModal-root">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="audit-detail-title"
           onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <span className={`badge badge--plain ${badge}`}>{ACTION_LABELS[entry.action] ?? entry.action}</span>
          <h3 id="audit-detail-title" className="modal__title">감사 기록 #{entry.id}</h3>
          <button ref={closeRef} className="icon-button modal__close" onClick={onClose}
                  aria-label="닫기" data-testid="AuditDetailModal-closeButton"><CloseIcon size={13} /></button>
        </div>
        <div className="modal__grid">
          <span className="modal__key">시각</span><span>{new Date(entry.requested_at).toLocaleString()}</span>
          <span className="modal__key">동작</span><span><code>{entry.action}</code></span>
          <span className="modal__key">요청자</span><span className="font-mono">{entry.requested_by}</span>
          <span className="modal__key">대상</span><span className="font-mono">{entry.target ?? "—"}</span>
        </div>
        <pre className="modal__pre" data-testid="AuditDetailModal-detail">{entry.detail}</pre>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `AuditPanel.tsx`** — state: `period: AuditPeriod = "7d"`, `action`, `requestedBy`, `target`, `q`, `dateFrom`, `dateTo`, `offset`, `pageSize: 100|200|500 = 100`, `items`, `actions`, `requesters`, `targets`, `counts`, `failedLogins`, `total`, `loading`, `error`, `selected: AuditEntry | null`. Date range = explicit `dateFrom/dateTo` when either is set, else `buildPeriodRange(period, new Date())`. `load` is the same debounced pattern as the old page with the extra params. On mount also `fetchAuditLog({ ...buildPeriodRange("today", new Date()), limit: 1 })` → `onTodayCount?.(res.total)`.

Render skeleton:
```tsx
<section data-testid="AuditPanel-root">
  <div className="sec-head">
    <span className="sec-head__tile"><ClipboardIcon size={14} /></span>
    <h2 className="sec-head__title">감사 로그</h2>
    <span className="cnt-pill" data-testid="AuditPanel-total">{total.toLocaleString()}</span>
    <div className="sec-head__right">
      <span className="period-chips" role="group" aria-label="기간">
        {(["today", "7d", "30d", "all"] as AuditPeriod[]).map((p) => (
          <button key={p} type="button" className={`period-chips__btn${period === p && !dateFrom && !dateTo ? " period-chips__btn--on" : ""}`}
                  onClick={() => { setPeriod(p); setDateFrom(""); setDateTo(""); setOffset(0); }}
                  data-testid={`AuditPanel-period-${p}`}>{PERIOD_LABELS[p]}</button>
        ))}
      </span>
      <button className="icon-button ctl-field" onClick={load} disabled={loading} data-testid="AuditPanel-refreshButton"><SyncIcon size={13} />{loading ? "불러오는 중…" : "새로고침"}</button>
    </div>
  </div>
  <p className="sec-desc">실제 값을 본 기록(미리보기·조인 샘플·값 추적)과 권한·설정 변경, 로그인이 최신순으로 남습니다. 수정·삭제는 없습니다.</p>

  <div className="stat-tiles stat-tiles--4">
    <div className="card stat-tile" data-testid="AuditPanel-tile-total"><div className="stat-tile__k">{periodLabel} 전체</div><div className="stat-tile__v stat-tile__v--plain">{summary.total.toLocaleString()}</div></div>
    <div className="card stat-tile" data-testid="AuditPanel-tile-exposure"><div className="stat-tile__k">실값 반출</div><div className="stat-tile__v">{summary.exposure.toLocaleString()}</div></div>
    <div className="card stat-tile" data-testid="AuditPanel-tile-policy"><div className="stat-tile__k">권한·설정 변경</div><div className="stat-tile__v stat-tile__v--plain">{summary.policy.toLocaleString()}</div></div>
    <div className="card stat-tile" data-testid="AuditPanel-tile-loginFail"><div className="stat-tile__k">로그인 실패·거부</div><div className={`stat-tile__v ${failedLogins > 0 ? "stat-tile__v--danger" : "stat-tile__v--plain"}`}>{failedLogins.toLocaleString()}</div></div>
  </div>

  <div className="audit-filters">
    <select className="ctl-field" value={action} onChange=… data-testid="AuditPanel-actionFilter">
      <option value="">동작: 전체</option>
      {ACTION_GROUPS.map((g) => (
        <optgroup key={g.category} label={g.label}>
          {g.actions.filter((a) => actions.includes(a)).map((a) => <option key={a} value={a}>{ACTION_LABELS[a] ?? a}</option>)}
        </optgroup>
      ))}
      {/* 분류에 없는 새 action도 잃지 않는다 */}
      {actions.filter((a) => !ACTION_GROUPS.some((g) => g.actions.includes(a))).map((a) => <option key={a} value={a}>{a}</option>)}
    </select>
    <select className="ctl-field" value={requestedBy} onChange=… data-testid="AuditPanel-requesterFilter">
      <option value="">요청자: 전체</option>
      {requesters.map((r) => <option key={r} value={r}>{r}</option>)}
    </select>
    <input className="ctl-field" list="AuditPanel-targets" placeholder="대상 (선택 또는 입력)" value={target} onChange=… data-testid="AuditPanel-targetFilter" />
    <datalist id="AuditPanel-targets">{targets.map((t) => <option key={t} value={t} />)}</datalist>
    <input className="ctl-field" placeholder="내용 검색" value={q} onChange=… data-testid="AuditPanel-detailFilter" style={{ minWidth: 160 }} />
    <span className="audit-filters__dates">
      <input type="date" className="ctl-field" value={dateFrom} onChange=… data-testid="AuditPanel-dateFromFilter" />
      <span style={{ color: "var(--muted)" }}>~</span>
      <input type="date" className="ctl-field" value={dateTo} onChange=… data-testid="AuditPanel-dateToFilter" />
    </span>
    <button className="icon-button ctl-field audit-filters__clear" disabled={!hasFilters} onClick={clear} data-testid="AuditPanel-clearFilters"><BanIcon size={13} />필터 해제</button>
  </div>
  <div className="audit-legend">…5 badges as in the mockup…</div>

  <div className="card">
    <table className="data-table" data-testid="AuditPanel-table">
      <colgroup><col style={{ width: 110 }} /><col style={{ width: 210 }} /><col /><col style={{ width: 150 }} /></colgroup>
      <thead><tr><th>시각</th><th>동작</th><th>대상</th><th>요청자</th></tr></thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id} className="audit-row reveal-host" tabIndex={0} role="button"
              onClick={() => setSelected(item)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(item); } }}
              data-testid={`AuditPanel-row-${item.id}`}>
            <td className="audit-when">{hhmm(item.requested_at)}<small>{dayLabel(item.requested_at)}</small></td>
            <td><span className={`badge badge--plain ${badgeFor(item)}`}>{ACTION_LABELS[item.action] ?? item.action}</span></td>
            <td className="audit-target" title={item.detail}>{item.detail}</td>
            <td className="audit-who"><span className="avatar">{initial(item.requested_by)}</span>{item.requested_by}</td>
          </tr>
        ))}
        {items.length === 0 && !loading && <tr><td colSpan={4} data-testid="AuditPanel-emptyState" style={{ color: "var(--muted)" }}>기록 없음</td></tr>}
      </tbody>
    </table>
    <div className="pager">
      <span className="pager__range" data-testid="AuditPanel-range">{total === 0 ? "0" : `${offset + 1}–${Math.min(offset + pageSize, total)}`}</span>
      <span>/ {total.toLocaleString()}건</span>
      <span className="pager__spacer" />
      <select className="ctl-field" value={pageSize} onChange=… data-testid="AuditPanel-pageSize"><option value={100}>100건씩</option><option value={200}>200건씩</option><option value={500}>500건씩</option></select>
      <button className="icon-button ctl-field" disabled={offset === 0} onClick=… data-testid="AuditPanel-prevButton">‹ 이전</button>
      <button className="icon-button ctl-field" disabled={offset + pageSize >= total} onClick=… data-testid="AuditPanel-nextButton">다음 ›</button>
    </div>
  </div>
  {error && <div className="banner banner--err" data-testid="AuditPanel-error"><WarningIcon size={15} /><span>{error}</span></div>}
  <AuditDetailModal entry={selected} onClose={() => setSelected(null)} />
</section>
```
Helpers inside the file: `hhmm(iso)`, `dayLabel(iso)` (오늘 / 어제 / `MM-DD`), `initial(id)` (first char upper), `badgeFor(item)` (`isFailedEntry` → `badge--err`, else category map). `PERIOD_LABELS = { today: "오늘", "7d": "7일", "30d": "30일", all: "전체" }`. The failed-login tile uses the API's `failed_logins`. The detail column keeps `white-space: nowrap` via `.audit-target` — the `table-layout: fixed` + `<colgroup>` guarantees one line.

- [ ] **Step 3: Mount** — in `page.tsx`: `import { AuditPanel } from "@/components/admin/AuditPanel";` and `<div {...panelProps("audit")}><AuditPanel onTodayCount={setAuditToday} /></div>`; the forbidden check for the audit tab is the page's existing sysadmin gate.

- [ ] **Step 4: Verify** — tsc, lint, vitest; on the fixture stack: seed produces audit rows (whitelist, confirm, preview) → open `/admin?tab=audit`: tiles, dropdown options populated from `requesters`/`targets`, a row click opens the modal, Esc closes, narrow the window to 700px → date group wraps to the second row and 필터 해제 stays right; `/admin/audit` redirects to the tab.

- [ ] **Step 5: Commit** — `git commit -m "feat(admin): audit log as a tab — period tiles, dropdown filters, one-line rows with a detail modal — 감사 로그 탭"`

---

### Task 10: Headless verification, guide screenshots, docs, PROGRESS

**Files:**
- Scratchpad scripts only (outside the repo) for capture/verification
- Modify: `frontend/public/handoff/user-guide.html` (rebuild with new `admin*.jpg`/`audit.jpg` shots; update the `/admin/audit` mentions to "관리 콘솔 → 감사 로그 탭")
- Modify: `README.md:105` (audit is now a tab; `/admin/audit` still redirects)
- Modify: `PROGRESS.md`

- [ ] **Step 1: Backend + frontend suites** — `cd backend && .venv/bin/pytest -q && .venv/bin/ruff check app tests`; `cd frontend && npx vitest run && npx tsc --noEmit && npm run lint && npm run build`. All green before anything else.
- [ ] **Step 2: Fixture stack + headless script** (memory recipe; `FIXTURE_DIR=fixtures`, seed from repo root, allowlist insert). Checks: tabs 5 with counts; lock bar locked→open; source card badges; form collapsed; stepper 3 cards; access chips hidden with one source; allowlist row pills; hidden-schema switch present; users avatars; AI tiles; audit: tiles present, action select has optgroups, requester select options ≥1, target datalist options ≥1, row click → modal visible with full detail, Esc closes, at 700px width the date group is on a lower row than the action select and the clear button's right edge is within 2px of the filter bar's right edge; `/admin/audit` → URL ends with `?tab=audit`. Console errors 0. Capture `admin.jpg`, `admin-access.jpg`, `admin-users.jpg`, `admin-ai.jpg`, `audit.jpg` (1280×800) into the scratchpad `shots/` and rebuild `user-guide.html` with the existing build script (add the AI tab shot to chapter 9).
- [ ] **Step 3: Docs** — README line 105 and the user guide text (9장 표 + figcaption) say the audit log is the fifth tab (`/admin?tab=audit`, old link redirects). PROGRESS: one entry (what changed + why + verification + "no .env change; migration 0020 backfills target").
- [ ] **Step 4: Commit + push** — `git commit -m "docs(admin): refresh guide screenshots and notes for the v2 console — 안내서 화면 갱신"`, `git push -u origin feature/admin-v2`.

---

## Self-review notes

- Spec coverage: P1 (Task 5 tabs), P2 (Task 5 lock bar), P3/P4 (Task 6), P5 (Task 7), P6/P7/P9 (Task 8), P8 (Task 8 step 5), P10 + one-line rows + modal + uniform heights + wrapping dates + right-aligned clear + requester/target dropdowns (Task 9, CSS in Task 5), A0 (Task 2), A1/A3/A4/A5 (Task 3), A2 (Task 2), target column for dropdowns (Task 1).
- Type consistency: `AuditEntry.target: string | null` (Task 4) matches the backend `target` nullable (Task 1); `buildPeriodRange`/`toIsoRange`/`ACTION_GROUPS`/`ACTION_LABELS`/`isFailedEntry`/`getActionCategory`/`summarizeCounts` names are used identically in Tasks 4 and 9; `AdminLockBar` props (Task 5) match the page wiring; panel props `password`/`passwordConfigured`/`onLoaded` are the same in Tasks 5, 6, 8.
- Known execution-time lookups (not placeholders — the executor reads the file): exact fixture names in `test_collect.py`/`test_join_preview.py`/embed-index tests; the `db` session fixture name in `conftest.py`; the schema-list variable name in `value_probe.py` near line 162.
