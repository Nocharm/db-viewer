# Verify Page + Read-Only ERD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 검증을 신설 `/verify` 페이지의 1:1 흐름(게이트 → containment → 프리뷰 → 확정)으로 옮기고, ERD를 confirmed+FK만 그리는 읽기 전용 전체 그래프로 재작성한다.

**Architecture:** 백엔드 3단계 파이프라인(containment·preview·confirm)은 이미 있으므로 신규는 게이트(`/api/validate/gate`)·페어 후보(`/api/validate/pair-candidates`)·대기 목록(`/api/relations/pending`)·전체 그래프(`/api/erd`)뿐이다. 게이트는 카탈로그 타입 패밀리 검사(쿼리 0회) → TOP 200 유니크니스(n8n, 컬럼 단위 캐시) 순으로 계층화한다. 프론트는 `/verify` 신설 + `/erd` 재작성 + 구 검증 UI(JoinBuilder 등) 삭제.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 + Alembic / Next.js 15 + React Flow + elkjs / pytest + vitest / n8n W2 쿼리 실행기.

**Spec:** `docs/superpowers/specs/2026-08-07-verify-page-readonly-erd-design.md`

## Global Constraints

- 언어: 설명·주석은 한국어(+영문 병기 관용), 코드·식별자·커밋 메시지는 영어. 커밋: `type(scope): English summary — 한국어 요약`.
- 함수명은 동사로 시작 (`rules/common/naming.md`). Python `snake_case`, TS `camelCase`.
- 커밋 직전 `PROGRESS.md` 갱신 — 이 브랜치는 **항목 1개를 유지하며 이어 붙인다** (머지 시 압축 규칙과 정합). 커밋 후 즉시 push (사용자 선호).
- 모든 함수 시그니처에 타입 힌트. `X | None`, `list[str]` 사용.
- TS: `strict`, `any` 금지, named export, 인터랙티브 요소에 `data-testid="ComponentName-role"` (`rules/frontend/identifiers.md`).
- 파라미터라이즈드 쿼리만. n8n W2 템플릿 밖 SQL 조립 금지 (식별자 브래킷 이스케이프 패턴 유지).
- 게이트 임계값: `GATE_DISTINCT_RATIO=0.9`, 샘플 크기 `GATE_SAMPLE_TOP=200` — Tuning 분류 → Settings + `.env.example` (`rules/backend/config.md`).
- 테스트: 백엔드 `cd backend && .venv/bin/pytest tests/<file> -q`, 프론트 `cd frontend && npx vitest run <file>`, 타입 `npx tsc --noEmit`, 린트 `npx next lint`.
- 백엔드 전체 스위트: `cd backend && .venv/bin/pytest -q`. 커밋 전 해당 영역 전체 스위트 통과.

---

## Phase 1 — 백엔드

### Task 1: 마이그레이션 0014 — 컬럼 샘플 통계 필드

**Files:**
- Create: `backend/alembic/versions/0014_column_sample_stats.py`
- Modify: `backend/app/models/catalog.py` (CatalogColumn, `masking_policy` 필드 아래)
- Test: `backend/tests/test_migrations.py` (기존 drift 검사가 커버 — 새 테스트 불필요)

**Interfaces:**
- Produces: `CatalogColumn.sample_rows: int | None`, `CatalogColumn.sample_distinct: int | None`, `CatalogColumn.sampled_at: datetime | None` — Task 6(gate)의 캐시 저장처.

- [ ] **Step 1: 마이그레이션 작성**

```python
"""Per-column TOP-N sample stats for the join gate (조인 게이트용 컬럼 샘플 통계).

Revision ID: 0014
Revises: 0013
Create Date: 2026-08-07

게이트는 TOP 200 샘플의 distinct 비율로 m:n 페어를 전수 containment 전에 걸러낸다.
샘플 통계는 페어가 아니라 컬럼의 속성이므로 컬럼에 캐시한다 — 같은 컬럼을 다른 상대와
재검증할 때 재쿼리가 없다. distinct_count(전수, T2 관측)와 축이 다르다: 이쪽은 표본이다.
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0014"
down_revision: Union[str, None] = "0013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("columns", sa.Column("sample_rows", sa.Integer(), nullable=True))
    op.add_column("columns", sa.Column("sample_distinct", sa.Integer(), nullable=True))
    op.add_column("columns", sa.Column("sampled_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("columns", "sampled_at")
    op.drop_column("columns", "sample_distinct")
    op.drop_column("columns", "sample_rows")
```

- [ ] **Step 2: 모델 필드 추가** — `backend/app/models/catalog.py`의 `CatalogColumn`, `masking_policy` 줄 아래:

```python
    # 게이트용 TOP-N 샘플 통계 — 컬럼 단위 캐시, 전수 distinct_count와 축이 다르다(표본)
    # / TOP-N sample stats cached per column for the join gate; a sample, not the full count
    sample_rows: Mapped[int | None] = mapped_column(Integer)
    sample_distinct: Mapped[int | None] = mapped_column(Integer)
    sampled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
```

(파일 상단 import에 `DateTime`, `datetime`이 이미 있는지 확인 — 없으면 추가.)

- [ ] **Step 3: 검증**

Run: `cd backend && .venv/bin/pytest tests/test_migrations.py -q`
Expected: PASS (compare_metadata drift 없음)

- [ ] **Step 4: 커밋** — PROGRESS.md에 브랜치 항목 신설(1줄) 후:

```bash
git add backend/alembic/versions/0014_column_sample_stats.py backend/app/models/catalog.py PROGRESS.md
git commit -m "feat(gate): add per-column sample stats fields — 게이트 캐시용 컬럼 샘플 통계 필드"
git push
```

---

### Task 2: Settings — 게이트 튜닝 값

**Files:**
- Modify: `backend/app/config.py` (`low_cardinality_min_distinct` 근처)
- Modify: `.env.example` (`LOW_CARDINALITY_MIN_DISTINCT` 근처)

**Interfaces:**
- Produces: `settings.gate_sample_top: int` (기본 200), `settings.gate_distinct_ratio: float` (기본 0.9) — Task 6에서 소비.

- [ ] **Step 1: Settings 필드 추가**

```python
    # 조인 게이트 — TOP-N 샘플 크기와 유니크니스 임계. 양쪽 모두 distinct/rows가 임계
    # 미만이면(둘 다 중복투성이 = m:n 추정) 전수 containment 전에 차단한다.
    gate_sample_top: int = 200
    gate_distinct_ratio: float = 0.9
```

- [ ] **Step 2: .env.example 항목 추가**

```bash
# 조인 게이트 샘플 크기(TOP N)와 유니크니스 임계(0~1). 임계를 낮추면 게이트가 관대해진다.
GATE_SAMPLE_TOP=200
GATE_DISTINCT_RATIO=0.9
```

- [ ] **Step 3: 검증** — `cd backend && .venv/bin/pytest tests/test_migrations.py -q` (Settings 임포트 스모크). Expected: PASS

- [ ] **Step 4: 커밋**

```bash
git add backend/app/config.py .env.example PROGRESS.md
git commit -m "feat(gate): add gate tuning settings — 게이트 샘플 크기·임계 설정"
git push
```

---

### Task 3: scoring.get_type_family

**Files:**
- Modify: `backend/app/domain/scoring.py` (`is_type_compatible` 아래)
- Test: `backend/tests/test_scoring.py` (파일 끝에 추가)

**Interfaces:**
- Produces: `get_type_family(data_type: str) -> str` — int 패밀리는 `"int"`, char 패밀리는 `"char"`, 그 외는 데이터타입 그대로. Task 6에서 소비.

- [ ] **Step 1: 실패하는 테스트 작성** — `backend/tests/test_scoring.py` 끝에:

```python
def test_type_family_groups_int_and_char_variants():
    from app.domain.scoring import get_type_family

    assert get_type_family("int") == get_type_family("bigint") == "int"
    assert get_type_family("varchar") == get_type_family("nchar") == "char"
    # 패밀리 밖은 타입명 그대로 — 같은 타입끼리만 같은 패밀리
    assert get_type_family("datetime2") == "datetime2"
    assert get_type_family("int") != get_type_family("varchar")
```

- [ ] **Step 2: 실패 확인**

Run: `cd backend && .venv/bin/pytest tests/test_scoring.py::test_type_family_groups_int_and_char_variants -q`
Expected: FAIL — ImportError (`get_type_family` 미정의)

- [ ] **Step 3: 구현** — `scoring.py`의 `is_type_compatible` 아래:

```python
def get_type_family(data_type: str) -> str:
    """게이트용 타입 패밀리 — 다른 패밀리는 조인 후보에서 즉시 차단 (스펙 §게이트)."""
    if data_type in _INT_FAMILY:
        return "int"
    if data_type in _CHAR_FAMILY:
        return "char"
    return data_type
```

- [ ] **Step 4: 통과 확인** — 같은 명령. Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add backend/app/domain/scoring.py backend/tests/test_scoring.py PROGRESS.md
git commit -m "feat(gate): add type family lookup — 게이트용 타입 패밀리 판정"
git push
```

---

### Task 4: JoinValidator.sample_stats — Protocol + Fake + n8n 어댑터

**Files:**
- Modify: `backend/app/domain/validation.py` (JoinValidator Protocol)
- Modify: `backend/app/adapters/fake_validator.py`
- Modify: `backend/app/adapters/n8n_query.py` (N8nJoinValidator)
- Test: `backend/tests/test_validators.py`, `backend/tests/test_n8n_query.py`

**Interfaces:**
- Produces: `sample_stats(self, ref: ColumnRef, top: int) -> tuple[int, int]` — `(sample_rows, sample_distinct)`. n8n 요청 kind는 `"sample_distinct"`, 파라미터 `{schema, table, column, top}`, 응답 1행 `{sample_rows, sample_distinct}`. Task 5(W2)·Task 6(gate)에서 소비.

- [ ] **Step 1: 실패하는 테스트 — Fake** (`backend/tests/test_validators.py` 끝에; 이 파일의 기존 임포트/픽스처 관용을 따른다):

```python
def test_fake_sample_stats_approximates_top_n(tmp_path):
    import json

    from app.adapters.fake_validator import FakeJoinValidator
    from app.domain.validation import ColumnRef

    path = tmp_path / "value_sets.json"
    path.write_text(json.dumps({"columns": [
        {"object": "dbo.BIG", "column": "EMP_NO",
         "values": ["a", "b"], "row_count": 5000, "distinct_count": 2},
        {"object": "dbo.SMALL", "column": "EMP_NO",
         "values": ["a", "b", "c"], "row_count": 3, "distinct_count": 3},
    ]}))
    v = FakeJoinValidator(path)

    # 표본은 TOP N로 절단 — 행 수는 min(top, row_count), distinct는 표본을 못 넘는다
    assert v.sample_stats(ColumnRef("dbo", "BIG", "EMP_NO"), 200) == (200, 2)
    assert v.sample_stats(ColumnRef("dbo", "SMALL", "EMP_NO"), 200) == (3, 3)
```

- [ ] **Step 2: 실패 확인**

Run: `cd backend && .venv/bin/pytest tests/test_validators.py::test_fake_sample_stats_approximates_top_n -q`
Expected: FAIL — AttributeError (`sample_stats` 없음)

- [ ] **Step 3: Protocol + Fake 구현**

`backend/app/domain/validation.py`의 `JoinValidator` Protocol에 (containment 아래):

```python
    def sample_stats(self, ref: ColumnRef, top: int) -> tuple[int, int]:
        """TOP-N 샘플의 (행 수, distinct 수) — 게이트 전용, 원본 값 비노출."""
        ...
```

`backend/app/adapters/fake_validator.py`의 `containment` 아래:

```python
    def sample_stats(self, ref: ColumnRef, top: int) -> tuple[int, int]:
        """TOP-N 샘플 통계 근사 — 값 집합의 전수 통계를 표본 크기로 절단."""
        entry = self._entry(ref)
        rows = min(top, entry["row_count"])
        return rows, min(entry["distinct_count"], rows)
```

- [ ] **Step 4: Fake 테스트 통과 확인** — Step 2 명령. Expected: PASS

- [ ] **Step 5: 실패하는 테스트 — n8n 어댑터** (`backend/tests/test_n8n_query.py`, 기존 `captured` 픽스처 재사용):

```python
def test_sample_stats_sends_kind_and_parses_counts(captured):
    captured["response"] = [{"sample_rows": 200, "sample_distinct": 187}]
    validator = N8nJoinValidator("http://n8n/webhook/", timeout=30)

    rows, distinct = validator.sample_stats(SRC, 200)

    body = captured["bodies"][0]
    assert body["kind"] == "sample_distinct"
    assert (body["schema"], body["table"], body["column"]) == ("dbo", "ORD_SO_HDR", "EMP_NO")
    assert body["top"] == 200
    assert (rows, distinct) == (200, 187)


def test_sample_stats_without_rows_raises(captured):
    captured["response"] = []
    validator = N8nJoinValidator("http://n8n/webhook/", timeout=30)
    with pytest.raises(n8n_query.N8nQueryError):
        validator.sample_stats(SRC, 200)
```

- [ ] **Step 6: 실패 확인** — `pytest tests/test_n8n_query.py -q -k sample_stats`. Expected: FAIL

- [ ] **Step 7: n8n 어댑터 구현** — `N8nJoinValidator.containment` 아래:

```python
    def sample_stats(self, ref: ColumnRef, top: int) -> tuple[int, int]:
        rows, _ = _post_query(self._base, {
            "kind": "sample_distinct", "top": top,
            "schema": ref.schema, "table": ref.table, "column": ref.column,
        }, self._timeout)
        if not rows:
            # 집계 쿼리는 항상 1행이다 — 0행이면 실행되지 않았다는 뜻 (containment와 동일)
            raise N8nQueryError(
                "n8n returned no rows for the sample_distinct aggregate — the W2 query "
                f"did not run ({ref.schema}.{ref.table}.{ref.column})"
            )
        row = rows[0]
        return int(row["sample_rows"]), int(row["sample_distinct"])
```

- [ ] **Step 8: 전체 확인**

Run: `cd backend && .venv/bin/pytest tests/test_validators.py tests/test_n8n_query.py -q`
Expected: PASS

- [ ] **Step 9: 커밋**

```bash
git add backend/app/domain/validation.py backend/app/adapters/fake_validator.py backend/app/adapters/n8n_query.py backend/tests/test_validators.py backend/tests/test_n8n_query.py PROGRESS.md
git commit -m "feat(gate): add sample_stats to the validator boundary — 검증기에 TOP-N 샘플 통계 추가"
git push
```

---

### Task 5: n8n W2 — sample_distinct 쿼리 kind

**Files:**
- Modify: `tools/build_n8n_workflow.py` (`BUILD_QUERY_JS`의 kind 분기 + W2 notes 문자열)
- Modify(재생성): `n8n/workflows/w2_query_executor.json`
- Test: `backend/tests/test_n8n_workflow.py` (커밋본==재생성본 강제 — 기존 테스트가 검증)

**Interfaces:**
- Consumes: Task 4의 요청 형식 `{kind: "sample_distinct", schema, table, column, top}`.
- Produces: W2가 1행 `{sample_rows, sample_distinct}` 반환.

- [ ] **Step 1: 실패 확인 (드리프트)** — 먼저 JS 분기를 추가한 뒤 재생성 전 테스트를 돌리면 FAIL이 정상. `BUILD_QUERY_JS`의 `'multi_join_preview'` 분기 **앞**(`join_preview` 분기 뒤)에:

```js
} else if (b.kind === 'sample_distinct') {
  // 게이트 전용 — 서브쿼리 TOP N 표본의 행 수·distinct만 집계, 원본 값은 반환하지 않는다
  // gate-only aggregate over a TOP-N sample; never returns raw values
  const top = Math.min(Math.max(parseInt(b.top, 10) || 200, 1), 1000);
  const tbl = esc(b.schema) + '.' + esc(b.table);
  const c = esc(b.column);
  query = `SELECT COUNT(*) AS sample_rows, COUNT(DISTINCT ${c}) AS sample_distinct ` +
    `FROM (SELECT TOP ${top} ${c} FROM ${tbl}) s`;
}
```

W2 notes 문자열(`"T2 검증·미리보기의 live 실행기 — FastAPI가 kind(containment/join_preview/multi_join_preview/table_preview)..."`)에 `sample_distinct` 추가:
`kind(containment/sample_distinct/join_preview/multi_join_preview/table_preview)`

Run: `cd backend && .venv/bin/pytest tests/test_n8n_workflow.py -q`
Expected: FAIL — 커밋된 JSON과 불일치

- [ ] **Step 2: 워크플로 재생성**

Run: `python3 tools/build_n8n_workflow.py`
Expected: `n8n/workflows/*.json` 갱신 (w2만 diff)

- [ ] **Step 3: 통과 확인** — `cd backend && .venv/bin/pytest tests/test_n8n_workflow.py -q`. Expected: PASS

- [ ] **Step 4: 커밋**

```bash
git add tools/build_n8n_workflow.py n8n/workflows/w2_query_executor.json PROGRESS.md
git commit -m "feat(gate): add the sample_distinct kind to W2 — W2에 TOP-N 표본 집계 쿼리 추가"
git push
```

---

### Task 6: POST /api/validate/gate

**Files:**
- Modify: `backend/app/api/validate.py` (`run_containment` 위에 추가)
- Test: `backend/tests/test_validate_api.py`

**Interfaces:**
- Consumes: `resolve_column_ref`, `ensure_not_hidden`, `get_join_validator`(이상 validate.py 기존), `scoring.get_type_family`(Task 3), `validator.sample_stats`(Task 4), `settings.gate_sample_top`/`gate_distinct_ratio`(Task 2), `CatalogColumn.sample_*`(Task 1).
- Produces: `POST /api/validate/gate` — 요청 `{src_column_id: int, tgt_column_id: int}`, 응답:

```json
{
  "verdict": "pass" | "blocked",
  "reason": null | "type_mismatch" | "both_low_distinct",
  "threshold": 0.9,
  "src": {"qname": "dbo.ORD_SO_HDR", "column": "EMP_NO", "data_type": "varchar",
           "family": "char", "sample_rows": 200, "sample_distinct": 187,
           "ratio": 0.935, "cached": false},
  "tgt": { ...같은 형태... }
}
```
타입 차단 시 `src`/`tgt`의 `sample_*`·`ratio`는 `null`, `cached`는 `false` (샘플 미조회). Task 10(프론트 API)에서 소비.

- [ ] **Step 1: 실패하는 테스트 작성** — `backend/tests/test_validate_api.py` 끝에. 게이트 테스트는 표본 프로필을 통제해야 하므로 **테스트가 직접 쓴 value_sets**로 Fake를 주입한다:

```python
import json as _json


def _gate_client(client, tmp_path, entries):
    """게이트 전용 클라이언트 — 표본 프로필을 직접 쓴 value_sets로 Fake 주입."""
    path = tmp_path / "gate_value_sets.json"
    path.write_text(_json.dumps({"columns": entries}))
    client.app.dependency_overrides[get_join_validator] = (
        lambda: FakeJoinValidator(path)
    )
    return client


def _typed_column_id(engine, families: tuple[str, ...]) -> tuple[int, str, str]:
    """지정 타입의 아무 테이블 컬럼 하나 — (column_id, qname, column)."""
    obj_t, col_t = Base.metadata.tables["objects"], Base.metadata.tables["columns"]
    with engine.connect() as conn:
        row = conn.execute(
            sa.select(col_t.c.id, obj_t.c.schema, obj_t.c.name, col_t.c.name)
            .join(obj_t, col_t.c.object_id == obj_t.c.id)
            .where(col_t.c.data_type.in_(families), obj_t.c.type == "table")
            .limit(1)
        ).one()
    return row[0], f"{row[1]}.{row[2]}", row[3]


def test_gate_blocks_type_mismatch_without_sampling(vclient, migrated_engine, load_fixture, tmp_path):
    _seed(vclient, load_fixture)
    int_id, _, _ = _typed_column_id(migrated_engine, ("int", "bigint"))
    chr_id, _, _ = _typed_column_id(migrated_engine, ("varchar", "nvarchar", "char", "nchar"))
    client = _gate_client(vclient, tmp_path, [])  # 값 집합 없음 — 샘플 조회가 없어야 통과

    body = client.post("/api/validate/gate",
                       json={"src_column_id": int_id, "tgt_column_id": chr_id}).json()

    assert body["verdict"] == "blocked"
    assert body["reason"] == "type_mismatch"
    assert body["src"]["sample_rows"] is None  # n8n 도달 전 차단 — 샘플 미조회


def test_gate_blocks_when_both_sides_are_dup_heavy(vclient, migrated_engine, load_fixture, tmp_path):
    _seed(vclient, load_fixture)
    rel = _pick_relation(load_fixture, kind="real_no_fk", orphan_count=0)
    src_id = _column_id(migrated_engine, rel["src_object"], rel["src_column"])
    tgt_id = _column_id(migrated_engine, rel["tgt_object"], rel["tgt_column"])
    client = _gate_client(vclient, tmp_path, [
        {"object": rel["src_object"], "column": rel["src_column"],
         "values": [], "row_count": 500, "distinct_count": 4},
        {"object": rel["tgt_object"], "column": rel["tgt_column"],
         "values": [], "row_count": 500, "distinct_count": 9},
    ])

    body = client.post("/api/validate/gate",
                       json={"src_column_id": src_id, "tgt_column_id": tgt_id}).json()

    assert body["verdict"] == "blocked"
    assert body["reason"] == "both_low_distinct"
    assert body["src"]["ratio"] < 0.9 and body["tgt"]["ratio"] < 0.9


def test_gate_passes_when_one_side_is_unique_and_caches(vclient, migrated_engine, load_fixture, tmp_path):
    _seed(vclient, load_fixture)
    rel = _pick_relation(load_fixture, kind="real_no_fk", orphan_count=0)
    src_id = _column_id(migrated_engine, rel["src_object"], rel["src_column"])
    tgt_id = _column_id(migrated_engine, rel["tgt_object"], rel["tgt_column"])
    client = _gate_client(vclient, tmp_path, [
        {"object": rel["src_object"], "column": rel["src_column"],
         "values": [], "row_count": 500, "distinct_count": 4},     # 중복투성이
        {"object": rel["tgt_object"], "column": rel["tgt_column"],
         "values": [], "row_count": 150, "distinct_count": 150},   # 유니크(1:N의 1)
    ])

    first = client.post("/api/validate/gate",
                        json={"src_column_id": src_id, "tgt_column_id": tgt_id}).json()
    assert first["verdict"] == "pass"
    assert first["reason"] is None
    assert first["tgt"]["cached"] is False

    # 두 번째 호출은 캐시 적중 — Fake를 빈 값 집합으로 갈아끼워도 성공해야 한다
    recached = _gate_client(client, tmp_path / "empty", [])
    second = recached.post("/api/validate/gate",
                           json={"src_column_id": src_id, "tgt_column_id": tgt_id}).json()
    assert second["verdict"] == "pass"
    assert second["src"]["cached"] is True and second["tgt"]["cached"] is True
```

(`_gate_client`의 두 번째 호출은 `tmp_path / "empty"`가 디렉터리로 없으므로 `path.write_text` 전에 `path.parent.mkdir(parents=True, exist_ok=True)`를 헬퍼에 넣는다.)

- [ ] **Step 2: 실패 확인**

Run: `cd backend && .venv/bin/pytest tests/test_validate_api.py -q -k gate`
Expected: FAIL — 404 (라우트 없음)

- [ ] **Step 3: 구현** — `backend/app/api/validate.py`. 임포트에 `from app.domain import scoring` 추가. `run_containment` 위에:

```python
class GateRequest(BaseModel):
    src_column_id: int
    tgt_column_id: int


def _build_gate_side(
    ref: ColumnRef, col: CatalogColumn, family: str, cached: bool
) -> dict:
    ratio = None
    if col.sample_rows is not None and col.sample_distinct is not None:
        # 빈 표본은 중복의 증거가 없다 — 차단 근거로 쓰지 않는다 (ratio 1.0)
        ratio = (col.sample_distinct / col.sample_rows) if col.sample_rows else 1.0
    return {
        "qname": ref.object_qname, "column": ref.column,
        "data_type": col.data_type, "family": family,
        "sample_rows": col.sample_rows, "sample_distinct": col.sample_distinct,
        "ratio": ratio, "cached": cached,
    }


def _ensure_sample_stats(
    col: CatalogColumn, ref: ColumnRef, validator: JoinValidator, top: int
) -> bool:
    """샘플 통계 확보 — 캐시 적중이면 True. 미스면 조회해 컬럼에 기록."""
    if col.sample_rows is not None and col.sample_distinct is not None:
        return True
    col.sample_rows, col.sample_distinct = validator.sample_stats(ref, top)
    col.sampled_at = datetime.now(UTC)
    return False


@router.post("/gate")
def run_gate(
    req: GateRequest,
    db: Session = Depends(get_db),
    validator: JoinValidator = Depends(get_join_validator),
) -> dict:
    """조인 사전 게이트 — 타입 패밀리(쿼리 0회) → TOP-N 유니크니스(캐시) 순 차단.

    값 겹침은 판정하지 않는다: TOP-N은 클러스터드 인덱스 순서라 실제로 조인되는
    페어도 표본끼리는 안 겹칠 수 있다 (스펙 §게이트). 원본 값 비노출 — 감사 대상 아님.
    """
    src_ref, src_col = resolve_column_ref(db, req.src_column_id)
    tgt_ref, tgt_col = resolve_column_ref(db, req.tgt_column_id)
    ensure_not_hidden(src_ref, tgt_ref)
    settings = get_settings()

    src_family = scoring.get_type_family(src_col.data_type)
    tgt_family = scoring.get_type_family(tgt_col.data_type)
    if src_family != tgt_family:
        return {
            "verdict": "blocked", "reason": "type_mismatch",
            "threshold": settings.gate_distinct_ratio,
            "src": _build_gate_side(src_ref, src_col, src_family, cached=False),
            "tgt": _build_gate_side(tgt_ref, tgt_col, tgt_family, cached=False),
        }

    try:
        src_cached = _ensure_sample_stats(src_col, src_ref, validator, settings.gate_sample_top)
        tgt_cached = _ensure_sample_stats(tgt_col, tgt_ref, validator, settings.gate_sample_top)
    except ValidationDataMissing as e:
        raise HTTPException(
            404, {"message": "no value data for column", "context": {"column": str(e.ref)}}
        ) from e
    db.flush()

    src_side = _build_gate_side(src_ref, src_col, src_family, src_cached)
    tgt_side = _build_gate_side(tgt_ref, tgt_col, tgt_family, tgt_cached)
    threshold = settings.gate_distinct_ratio
    both_low = src_side["ratio"] < threshold and tgt_side["ratio"] < threshold
    return {
        "verdict": "blocked" if both_low else "pass",
        "reason": "both_low_distinct" if both_low else None,
        "threshold": threshold,
        "src": src_side, "tgt": tgt_side,
    }
```

`config.py`의 `get_settings` 임포트는 validate.py에 이미 있다.

- [ ] **Step 4: 통과 확인** — Step 2 명령. Expected: PASS. 이어서 `pytest tests/test_validate_api.py -q` 전체. Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add backend/app/api/validate.py backend/tests/test_validate_api.py PROGRESS.md
git commit -m "feat(gate): add the join pre-gate endpoint — 조인 사전 게이트 API"
git push
```

---

### Task 7: GET /api/validate/pair-candidates

**Files:**
- Modify: `backend/app/api/validate.py` (파일 끝에 추가)
- Test: `backend/tests/test_validate_api.py`

**Interfaces:**
- Consumes: `load_scoring_columns`, `load_pair_sets`(services/catalog_queries.py), `scoring.score_candidates`, `resolve_snapshot`(api/objects.py), `settings.low_cardinality_min_distinct`/`low_cardinality_blacklist`(기존 — 정확한 필드명은 config.py에서 확인해 그대로 사용).
- Produces: `GET /api/validate/pair-candidates?src_object_id=&tgt_object_id=` — 응답:

```json
{"items": [{"src_column_id": 1, "src_column": "EMP_NO", "src_data_type": "varchar",
             "tgt_column_id": 9, "tgt_column": "EMP_NO", "tgt_data_type": "varchar",
             "tgt_is_pk": true, "score": 60, "signals": {"naming": 40, "key": 20}}]}
```
점수 내림차순, 상위 20개. Task 10에서 소비.

- [ ] **Step 1: 실패하는 테스트 작성** — `backend/tests/test_validate_api.py` 끝에:

```python
def test_pair_candidates_ranks_matching_columns(vclient, migrated_engine, load_fixture):
    _seed(vclient, load_fixture)
    rel = _pick_relation(load_fixture, kind="real_no_fk", orphan_count=0)
    src_schema, src_name = rel["src_object"].split(".", 1)
    tgt_schema, tgt_name = rel["tgt_object"].split(".", 1)
    obj_t = Base.metadata.tables["objects"]
    with migrated_engine.connect() as conn:
        src_oid = conn.execute(sa.select(obj_t.c.id).where(
            obj_t.c.schema == src_schema, obj_t.c.name == src_name)).scalar_one()
        tgt_oid = conn.execute(sa.select(obj_t.c.id).where(
            obj_t.c.schema == tgt_schema, obj_t.c.name == tgt_name)).scalar_one()

    body = vclient.get("/api/validate/pair-candidates",
                       params={"src_object_id": src_oid, "tgt_object_id": tgt_oid}).json()

    pairs = [(i["src_column"], i["tgt_column"]) for i in body["items"]]
    assert (rel["src_column"], rel["tgt_column"]) in pairs  # 알려진 관계가 후보로 떠야 한다
    scores = [i["score"] for i in body["items"]]
    assert scores == sorted(scores, reverse=True)


def test_pair_candidates_missing_object_is_404(vclient, load_fixture):
    _seed(vclient, load_fixture)
    resp = vclient.get("/api/validate/pair-candidates",
                       params={"src_object_id": 999999, "tgt_object_id": 999998})
    assert resp.status_code == 404
```

- [ ] **Step 2: 실패 확인** — `pytest tests/test_validate_api.py -q -k pair_candidates`. Expected: FAIL (404 라우트 없음 — 첫 테스트는 items 파싱에서 실패)

- [ ] **Step 3: 구현** — validate.py 끝에. 임포트 추가: `from app.services.catalog_queries import load_pair_sets, load_scoring_columns`, `from app.api.objects import resolve_snapshot` 은 **순환 임포트**가 되므로 (objects→...→validate 여부 확인) 안전하게 `CatalogObject` 직접 조회로 스냅샷을 얻는다:

```python
PAIR_CANDIDATE_LIMIT = 20  # 상위 페어 수 — UI 한 화면 분량


@router.get("/pair-candidates")
def list_pair_candidates(
    src_object_id: int,
    tgt_object_id: int,
    db: Session = Depends(get_db),
) -> dict:
    """두 테이블 간 후보 컬럼 페어 — 카탈로그 신호만, 쿼리 0회 (스펙 §컬럼 선택)."""
    src_obj = db.get(CatalogObject, src_object_id)
    tgt_obj = db.get(CatalogObject, tgt_object_id)
    if src_obj is None or tgt_obj is None:
        missing = src_object_id if src_obj is None else tgt_object_id
        raise HTTPException(404, {"message": "object not found",
                                  "context": {"object_id": missing}})
    for obj in (src_obj, tgt_obj):
        if is_schema_hidden(obj.schema):
            raise HTTPException(403, {
                "message": "this schema is hidden (HIDDEN_SCHEMAS)",
                "context": {"object": f"{obj.schema}.{obj.name}"},
            })

    settings = get_settings()
    columns = load_scoring_columns(db, src_obj.snapshot_id)
    view_pairs, fk_pairs = load_pair_sets(db, src_obj.snapshot_id)
    src_qname = f"{src_obj.schema}.{src_obj.name}"
    tgt_qname = f"{tgt_obj.schema}.{tgt_obj.name}"
    targets = [c for c in columns.values() if c.object_qname == tgt_qname]

    items = []
    for src in columns.values():
        if src.object_qname != src_qname:
            continue
        for cand in scoring.score_candidates(
            src, targets, view_pairs, fk_pairs,
            settings.low_cardinality_min_distinct,
            set(settings.low_cardinality_blacklist),
        ):
            items.append({
                "src_column_id": src.column_id, "src_column": src.name,
                "src_data_type": src.data_type,
                "tgt_column_id": cand.target.column_id, "tgt_column": cand.target.name,
                "tgt_data_type": cand.target.data_type,
                "tgt_is_pk": cand.target.is_pk,
                "score": cand.score, "signals": cand.signals,
            })
    items.sort(key=lambda i: (-i["score"], i["src_column"], i["tgt_column"]))
    return {"items": items[:PAIR_CANDIDATE_LIMIT]}
```

`low_cardinality_blacklist`의 실제 Settings 필드명·타입(list 또는 str)은 `config.py`를 열어 확인하고 기존 사용처(join_check.py 등)의 접근 방식을 그대로 복사한다.

- [ ] **Step 4: 통과 확인** — Step 2 명령 → PASS. `pytest tests/test_validate_api.py -q` 전체 → PASS

- [ ] **Step 5: 커밋**

```bash
git add backend/app/api/validate.py backend/tests/test_validate_api.py PROGRESS.md
git commit -m "feat(verify): add pair-candidate ranking for two tables — 두 테이블 간 후보 페어 API"
git push
```

---

### Task 8: GET /api/relations/pending — 검증 대기 후보 목록

**Files:**
- Modify: `backend/app/api/relations.py`
- Test: `backend/tests/test_preview_confirm.py` (관계 상태 테스트가 모여 있는 파일 — 파일 끝에 추가)

**Interfaces:**
- Produces: `GET /api/relations/pending` — status가 `candidate`/`validated`인 관계 + 현재 스냅샷의 프리필용 id 매핑:

```json
{"items": [{"id": 3, "status": "candidate", "origin": "ai", "confidence": null,
             "reason": "same code pattern", "src_object": "dbo.A", "src_column": "EMP_NO",
             "tgt_object": "dbo.B", "tgt_column": "EMP_NO",
             "src_object_id": 12, "src_column_id": 77,
             "tgt_object_id": 15, "tgt_column_id": 91}],
 "total": 1}
```
객체가 현 스냅샷에 없으면 `*_id`는 `null`. 감춘 스키마의 관계는 제외. Task 10에서 소비.

- [ ] **Step 1: 실패하는 테스트 작성** — `backend/tests/test_preview_confirm.py` 끝에 (이 파일의 기존 시드·헬퍼 관용을 따른다; `_seed`/`_column_id`류 헬퍼가 없으면 test_validate_api.py의 것을 복제):

```python
def test_pending_lists_candidates_and_maps_ids(vclient, migrated_engine, load_fixture):
    _seed(vclient, load_fixture)
    rel = _pick_relation(load_fixture, kind="real_no_fk", orphan_count=0)
    src_id = _column_id(migrated_engine, rel["src_object"], rel["src_column"])
    tgt_id = _column_id(migrated_engine, rel["tgt_object"], rel["tgt_column"])
    # T2 실행 → status=validated 관계가 생긴다 (기존 containment 플로우 재사용)
    vclient.post("/api/validate/containment",
                 json={"src_column_id": src_id, "tgt_column_id": tgt_id})

    body = vclient.get("/api/relations/pending").json()

    assert body["total"] >= 1
    entry = next(i for i in body["items"]
                 if (i["src_object"], i["src_column"]) == (rel["src_object"], rel["src_column"]))
    assert entry["status"] == "validated"
    assert entry["src_column_id"] == src_id and entry["tgt_column_id"] == tgt_id


def test_pending_excludes_confirmed(vclient, migrated_engine, load_fixture):
    _seed(vclient, load_fixture)
    rel = _pick_relation(load_fixture, kind="real_no_fk", orphan_count=0)
    src_id = _column_id(migrated_engine, rel["src_object"], rel["src_column"])
    tgt_id = _column_id(migrated_engine, rel["tgt_object"], rel["tgt_column"])
    vclient.post("/api/validate/containment",
                 json={"src_column_id": src_id, "tgt_column_id": tgt_id})
    vclient.post("/api/relations/confirm",
                 json={"src_column_id": src_id, "tgt_column_id": tgt_id})

    body = vclient.get("/api/relations/pending").json()
    pairs = [(i["src_object"], i["src_column"]) for i in body["items"]]
    assert (rel["src_object"], rel["src_column"]) not in pairs
```

(이 파일에 `vclient` 픽스처가 없으면 test_validate_api.py와 동일하게 정의해 추가.)

- [ ] **Step 2: 실패 확인** — `pytest tests/test_preview_confirm.py -q -k pending`. Expected: FAIL

- [ ] **Step 3: 구현** — relations.py에. 임포트 추가: `from sqlalchemy import func, select` (select는 이미 있음), `from app.models import CatalogColumn, CatalogObject`, `from app.services.schema_visibility import is_schema_hidden`:

```python
PENDING_LIMIT = 100  # 대기 목록 한 화면 상한 — total로 절단 여부를 드러낸다


@router.get("/pending")
def list_pending_relations(db: Session = Depends(get_db)) -> dict:
    """검증 대기 관계 — candidate(제안)·validated(T2 통과, 미확정) (스펙 §/verify)."""
    rows = db.execute(
        select(Relation)
        .where(Relation.status.in_(("candidate", "validated")))
        .order_by(Relation.created_at.desc())
    ).scalars().all()
    rows = [r for r in rows
            if not is_schema_hidden(r.src_object.split(".", 1)[0])
            and not is_schema_hidden(r.tgt_object.split(".", 1)[0])]

    # 프리필용 현 스냅샷 id 매핑 — 관계는 텍스트 식별자라 스냅샷 교체에도 산다
    latest_sid = db.execute(
        select(func.max(CatalogObject.snapshot_id))
    ).scalar_one_or_none()
    obj_ids: dict[str, int] = {}
    col_ids: dict[tuple[str, str], int] = {}
    if latest_sid is not None:
        for oid, schema, name in db.execute(
            select(CatalogObject.id, CatalogObject.schema, CatalogObject.name)
            .where(CatalogObject.snapshot_id == latest_sid)
        ):
            obj_ids[f"{schema}.{name}"] = oid
        for cid, oid, cname in db.execute(
            select(CatalogColumn.id, CatalogColumn.object_id, CatalogColumn.name)
            .join(CatalogObject, CatalogColumn.object_id == CatalogObject.id)
            .where(CatalogObject.snapshot_id == latest_sid)
        ):
            col_ids[(oid, cname)] = cid

    def _resolve(qname: str, column: str) -> tuple[int | None, int | None]:
        oid = obj_ids.get(qname)
        return oid, (col_ids.get((oid, column)) if oid is not None else None)

    items = []
    for r in rows[:PENDING_LIMIT]:
        src_oid, src_cid = _resolve(r.src_object, r.src_column)
        tgt_oid, tgt_cid = _resolve(r.tgt_object, r.tgt_column)
        items.append({
            "id": r.id, "status": r.status, "origin": r.origin,
            "confidence": r.confidence, "reason": r.reason,
            "src_object": r.src_object, "src_column": r.src_column,
            "tgt_object": r.tgt_object, "tgt_column": r.tgt_column,
            "src_object_id": src_oid, "src_column_id": src_cid,
            "tgt_object_id": tgt_oid, "tgt_column_id": tgt_cid,
        })
    return {"items": items, "total": len(rows)}
```

- [ ] **Step 4: 통과 확인** — Step 2 명령 → PASS. `pytest tests/test_preview_confirm.py -q` → PASS

- [ ] **Step 5: 커밋**

```bash
git add backend/app/api/relations.py backend/tests/test_preview_confirm.py PROGRESS.md
git commit -m "feat(verify): add the pending-relations list — 검증 대기 관계 목록 API"
git push
```

---

### Task 9: GET /api/erd — confirmed+FK 전체 그래프

**Files:**
- Create: `backend/app/api/erd.py`
- Create: `backend/tests/test_erd_api.py`
- Modify: `backend/app/main.py` (라우터 등록, user_gate)

**Interfaces:**
- Consumes: `objects._load_fk_edges(db, sid)`(기존 — 시그니처는 objects.py에서 확인), `Relation`(status=="confirmed"), `AiSummary`.
- Produces: `GET /api/erd` — 응답 (노드 형태는 기존 그래프 노드와 동일 키 — 프론트 `GraphNode` 재사용):

```json
{"snapshot_id": 3,
 "nodes": [{"id": 1, "schema": "dbo", "name": "HR_EMP", "type": "table",
             "row_count": 340, "dmv_unresolved": false, "lineage_flag": null,
             "unresolved_dep_count": 0, "ai_summary": null,
             "columns": [{"id": 9, "name": "EMP_NO", "data_type": "varchar",
                           "is_pk": true, "is_nullable": false, "is_computed": false}]}],
 "edges": [{"id": "rel-3", "kind": "confirmed", "src_object_id": 2, "tgt_object_id": 1,
             "columns": [{"src_column": "EMP_NO", "tgt_column": "EMP_NO"}],
             "confidence": 1.0, "cardinality": "N:1", "last_verified_at": "..."}]}
```
엣지 kind는 `"fk"`·`"confirmed"`만. Task 10·13에서 소비.

- [ ] **Step 1: 실패하는 테스트 작성** — `backend/tests/test_erd_api.py` 신설:

```python
"""Read-only ERD graph endpoint tests. / 읽기 전용 ERD 그래프 테스트."""

import pytest
import sqlalchemy as sa

from app.adapters.fake_validator import FakeJoinValidator
from app.api.validate import get_join_validator
from app.models import Base


@pytest.fixture()
def vclient(client, fixture_dir):
    client.app.dependency_overrides[get_join_validator] = lambda: FakeJoinValidator(
        fixture_dir / "value_sets.json"
    )
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
            sa.select(col_t.c.id).join(obj_t, col_t.c.object_id == obj_t.c.id)
            .where(obj_t.c.schema == schema, obj_t.c.name == table, col_t.c.name == column)
        ).scalar_one()


def _pick_relation(load_fixture, **filters):
    for rel in load_fixture("expected/relations.json")["rows"]:
        if all(rel[k] == v for k, v in filters.items()):
            return rel
    raise AssertionError(f"no relation matching {filters}")


def test_erd_serves_fk_and_confirmed_edges_only(vclient, migrated_engine, load_fixture):
    _seed(vclient, load_fixture)
    rel = _pick_relation(load_fixture, kind="real_no_fk", orphan_count=0)
    src_id = _column_id(migrated_engine, rel["src_object"], rel["src_column"])
    tgt_id = _column_id(migrated_engine, rel["tgt_object"], rel["tgt_column"])
    vclient.post("/api/validate/containment",
                 json={"src_column_id": src_id, "tgt_column_id": tgt_id})

    before = vclient.get("/api/erd").json()
    assert all(e["kind"] == "fk" for e in before["edges"])  # validated는 아직 미등장

    vclient.post("/api/relations/confirm",
                 json={"src_column_id": src_id, "tgt_column_id": tgt_id})
    after = vclient.get("/api/erd").json()

    kinds = {e["kind"] for e in after["edges"]}
    assert kinds <= {"fk", "confirmed"}
    assert "confirmed" in kinds
    # 노드는 엣지 참여 테이블만 — 뷰·고립 테이블 없음
    edge_ids = {e["src_object_id"] for e in after["edges"]} | {
        e["tgt_object_id"] for e in after["edges"]}
    assert {n["id"] for n in after["nodes"]} == edge_ids
    assert all(n["type"] == "table" for n in after["nodes"])


def test_erd_excludes_hidden_schemas(vclient, load_fixture, monkeypatch):
    from app.config import get_settings

    _seed(vclient, load_fixture)
    monkeypatch.setenv("HIDDEN_SCHEMAS", "dbo")
    get_settings.cache_clear()
    try:
        body = vclient.get("/api/erd").json()
        assert body["nodes"] == [] and body["edges"] == []  # dbo가 유일 스키마
    finally:
        monkeypatch.delenv("HIDDEN_SCHEMAS", raising=False)
        get_settings.cache_clear()


def test_erd_empty_catalog_is_empty_graph(client):
    body = client.get("/api/erd").json()
    assert body == {"snapshot_id": None, "nodes": [], "edges": []}
```

- [ ] **Step 2: 실패 확인** — `pytest tests/test_erd_api.py -q`. Expected: FAIL (404)

- [ ] **Step 3: 구현** — `backend/app/api/erd.py` 신설:

```python
"""Read-only ERD graph — confirmed relations and real FKs only. / 읽기 전용 ERD 그래프.

앵커·depth가 없다: 검증된 관계만 그리므로 그래프가 작고(FK 13 + 확정 관계),
전체를 한 번에 내려 클라이언트가 연결요소별로 배치한다 (스펙 §ERD).
"""

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.objects import _load_fk_edges
from app.db import get_db
from app.models import AiSummary, CatalogColumn, CatalogObject, Relation
from app.services.schema_visibility import get_hidden_schemas

router = APIRouter(prefix="/api/erd", tags=["erd"])


@router.get("")
def get_erd_graph(db: Session = Depends(get_db)) -> dict:
    sid = db.execute(select(func.max(CatalogObject.snapshot_id))).scalar_one_or_none()
    if sid is None:
        return {"snapshot_id": None, "nodes": [], "edges": []}

    hidden = get_hidden_schemas()
    qname_to_id = {
        f"{schema}.{name}": oid
        for oid, schema, name in db.execute(
            select(CatalogObject.id, CatalogObject.schema, CatalogObject.name)
            .where(CatalogObject.snapshot_id == sid)
        )
        if schema.lower() not in hidden
    }
    visible_ids = set(qname_to_id.values())

    edges = [e for e in _load_fk_edges(db, sid)
             if e["src_object_id"] in visible_ids and e["tgt_object_id"] in visible_ids]
    for rel in db.execute(
        select(Relation).where(Relation.status == "confirmed")
    ).scalars():
        src = qname_to_id.get(rel.src_object)
        tgt = qname_to_id.get(rel.tgt_object)
        if src is None or tgt is None:
            continue  # 현 스냅샷에 없는 객체 / object absent from this snapshot
        edges.append({
            "id": f"rel-{rel.id}", "kind": "confirmed",
            "src_object_id": src, "tgt_object_id": tgt,
            "columns": [{"src_column": rel.src_column, "tgt_column": rel.tgt_column}],
            "confidence": rel.confidence, "cardinality": rel.cardinality,
            "last_verified_at": (
                rel.last_verified_at.isoformat() if rel.last_verified_at else None
            ),
        })

    included = {e["src_object_id"] for e in edges} | {e["tgt_object_id"] for e in edges}
    columns_by_object: dict[int, list[dict]] = {}
    for col in db.execute(
        select(CatalogColumn)
        .where(CatalogColumn.object_id.in_(included))
        .order_by(CatalogColumn.object_id, CatalogColumn.ordinal)
    ).scalars():
        columns_by_object.setdefault(col.object_id, []).append({
            "id": col.id, "name": col.name, "data_type": col.data_type,
            "is_pk": col.is_pk, "is_nullable": col.is_nullable,
            "is_computed": col.is_computed,
        })

    id_to_qname = {oid: q for q, oid in qname_to_id.items()}
    summaries = {
        s.object_qname: s.summary
        for s in db.execute(
            select(AiSummary).where(
                AiSummary.object_qname.in_([id_to_qname[i] for i in included])
            )
        ).scalars()
    } if included else {}

    nodes = [
        {
            "id": obj.id, "schema": obj.schema, "name": obj.name, "type": obj.type,
            "row_count": obj.row_count, "dmv_unresolved": obj.dmv_unresolved,
            # 읽기 전용 ERD는 뷰가 없어 lineage 개념이 없다 — 노드 형태만 기존과 맞춘다
            "lineage_flag": None, "unresolved_dep_count": 0,
            "ai_summary": summaries.get(f"{obj.schema}.{obj.name}"),
            "columns": columns_by_object.get(obj.id, []),
        }
        for obj in db.execute(
            select(CatalogObject).where(CatalogObject.id.in_(included))
            .order_by(CatalogObject.schema, CatalogObject.name)
        ).scalars()
    ]
    return {"snapshot_id": sid, "nodes": nodes, "edges": edges}
```

`main.py`: `from app.api import ... erd ...` 임포트에 추가하고, `app.include_router(objects.router, ...)` 근처에 `app.include_router(erd.router, dependencies=user_gate)` 추가.

`_load_fk_edges` 시그니처가 위 가정(`(db, sid) -> list[dict]`)과 다르면 objects.py의 실제 정의를 따른다. 사용하는 dict 키(kind·src_object_id·tgt_object_id 등)는 objects.py의 생성부와 동일해야 한다.

- [ ] **Step 4: 통과 확인** — `pytest tests/test_erd_api.py -q` → PASS. 이어서 백엔드 전체: `pytest -q` → PASS

- [ ] **Step 5: 커밋**

```bash
git add backend/app/api/erd.py backend/tests/test_erd_api.py backend/app/main.py PROGRESS.md
git commit -m "feat(erd): add the confirmed+FK whole-graph endpoint — 읽기 전용 ERD 그래프 API"
git push
```

---

## Phase 2 — /verify 페이지

### Task 10: 프론트 API 레이어 + verify-flow 상태머신

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Create: `frontend/src/lib/verify-flow.ts`
- Test: `frontend/src/lib/verify-flow.test.ts`

**Interfaces:**
- Consumes: Task 6~9의 응답 형태.
- Produces (api.ts — 기존 `getJson`/`postJson` 관용):

```typescript
export interface GateSide {
  qname: string; column: string; data_type: string; family: string;
  sample_rows: number | null; sample_distinct: number | null;
  ratio: number | null; cached: boolean;
}
export interface GateResult {
  verdict: "pass" | "blocked";
  reason: "type_mismatch" | "both_low_distinct" | null;
  threshold: number; src: GateSide; tgt: GateSide;
}
export function runGate(srcColumnId: number, tgtColumnId: number): Promise<GateResult> {
  return postJson("/api/validate/gate",
    { src_column_id: srcColumnId, tgt_column_id: tgtColumnId });
}

export interface PairCandidate {
  src_column_id: number; src_column: string; src_data_type: string;
  tgt_column_id: number; tgt_column: string; tgt_data_type: string;
  tgt_is_pk: boolean; score: number; signals: Record<string, number>;
}
export function fetchPairCandidates(
  srcObjectId: number, tgtObjectId: number,
): Promise<{ items: PairCandidate[] }> {
  return getJson(`/api/validate/pair-candidates?src_object_id=${srcObjectId}&tgt_object_id=${tgtObjectId}`);
}

export interface PendingRelation {
  id: number; status: "candidate" | "validated"; origin: string;
  confidence: number | null; reason: string | null;
  src_object: string; src_column: string; tgt_object: string; tgt_column: string;
  src_object_id: number | null; src_column_id: number | null;
  tgt_object_id: number | null; tgt_column_id: number | null;
}
export function fetchPendingRelations(): Promise<{ items: PendingRelation[]; total: number }> {
  return getJson("/api/relations/pending");
}

export interface JoinSamplePreview {
  src: string; tgt: string; rows: Record<string, unknown>[];
  limit: number; masked_columns: string[]; observed_at: string;
}
export function runValidatePreview(
  srcColumnId: number, tgtColumnId: number,
): Promise<JoinSamplePreview> {
  return postJson("/api/validate/preview",
    { src_column_id: srcColumnId, tgt_column_id: tgtColumnId, requested_by: "ui" });
}

export function fetchErdGraph(): Promise<ErdResponse> {
  return getJson("/api/erd");
}
```

`ErdResponse`는 `frontend/src/lib/types.ts`에 추가:

```typescript
export interface ErdResponse {
  snapshot_id: number | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
```

- Produces (`verify-flow.ts`) — 단계 상태머신 (page가 소비):

```typescript
export type VerifyStep = "pick" | "gated" | "validated" | "confirmed";
export interface VerifyState {
  step: VerifyStep;
  gate: GateResult | null;
  containment: ContainmentResponse | null;
}
export function createInitialState(): VerifyState;
export function applyGateResult(state: VerifyState, gate: GateResult): VerifyState;
export function applyContainment(state: VerifyState, result: ContainmentResponse): VerifyState;
export function applyConfirm(state: VerifyState): VerifyState;
export function resetForNewPair(): VerifyState;   // 페어 변경 → 처음부터
export function canRunContainment(state: VerifyState): boolean; // gate pass 후에만
export function canConfirm(state: VerifyState): boolean;        // containment 후에만
```

- [ ] **Step 1: 실패하는 테스트 작성** — `frontend/src/lib/verify-flow.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import type { ContainmentResponse } from "./types";
import type { GateResult } from "./api";
import {
  applyConfirm, applyContainment, applyGateResult,
  canConfirm, canRunContainment, createInitialState, resetForNewPair,
} from "./verify-flow";

const passGate: GateResult = {
  verdict: "pass", reason: null, threshold: 0.9,
  src: { qname: "dbo.A", column: "X", data_type: "int", family: "int",
         sample_rows: 200, sample_distinct: 40, ratio: 0.2, cached: false },
  tgt: { qname: "dbo.B", column: "X", data_type: "int", family: "int",
         sample_rows: 150, sample_distinct: 150, ratio: 1, cached: false },
};
const blockedGate: GateResult = { ...passGate, verdict: "blocked", reason: "type_mismatch" };
const containment = { containment: 1, cardinality: "N:1" } as ContainmentResponse;

describe("verify flow", () => {
  it("starts at pick and blocks containment until the gate passes", () => {
    const s0 = createInitialState();
    expect(s0.step).toBe("pick");
    expect(canRunContainment(s0)).toBe(false);

    const blocked = applyGateResult(s0, blockedGate);
    expect(blocked.step).toBe("gated");
    expect(canRunContainment(blocked)).toBe(false); // 차단 게이트는 진행 불가

    const passed = applyGateResult(s0, passGate);
    expect(canRunContainment(passed)).toBe(true);
    expect(canConfirm(passed)).toBe(false);
  });

  it("walks gate -> containment -> confirm in order", () => {
    const validated = applyContainment(applyGateResult(createInitialState(), passGate), containment);
    expect(validated.step).toBe("validated");
    expect(canConfirm(validated)).toBe(true);
    expect(applyConfirm(validated).step).toBe("confirmed");
  });

  it("resets everything when the pair changes", () => {
    const validated = applyContainment(applyGateResult(createInitialState(), passGate), containment);
    expect(resetForNewPair()).toEqual(createInitialState());
    expect(validated.containment).not.toBeNull(); // 원본 불변
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/lib/verify-flow.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현** — `frontend/src/lib/verify-flow.ts`:

```typescript
/** /verify 단계 상태머신 — 게이트 통과 전 containment·확정 진입을 막는다. */

import type { GateResult } from "./api";
import type { ContainmentResponse } from "./types";

export type VerifyStep = "pick" | "gated" | "validated" | "confirmed";

export interface VerifyState {
  step: VerifyStep;
  gate: GateResult | null;
  containment: ContainmentResponse | null;
}

export function createInitialState(): VerifyState {
  return { step: "pick", gate: null, containment: null };
}

export function applyGateResult(state: VerifyState, gate: GateResult): VerifyState {
  return { ...state, step: "gated", gate, containment: null };
}

export function applyContainment(
  state: VerifyState, result: ContainmentResponse,
): VerifyState {
  return { ...state, step: "validated", containment: result };
}

export function applyConfirm(state: VerifyState): VerifyState {
  return { ...state, step: "confirmed" };
}

export function resetForNewPair(): VerifyState {
  return createInitialState();
}

export function canRunContainment(state: VerifyState): boolean {
  return state.gate?.verdict === "pass";
}

export function canConfirm(state: VerifyState): boolean {
  return state.step === "validated" && state.containment !== null;
}
```

api.ts·types.ts에 위 Interfaces 블록의 함수·타입 추가 (`ContainmentResponse`는 types.ts에 이미 있음 — api.ts의 함수가 그것을 반환하도록 기존 `runContainment` 그대로 재사용).

- [ ] **Step 4: 통과 확인** — Step 2 명령 → PASS. `npx tsc --noEmit` → 에러 없음

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/lib/api.ts frontend/src/lib/types.ts frontend/src/lib/verify-flow.ts frontend/src/lib/verify-flow.test.ts PROGRESS.md
git commit -m "feat(verify): add the client API layer and step machine — 검증 페이지 API·단계 상태머신"
git push
```

---

### Task 11: /verify 페이지 — 컴포넌트·i18n·헤더 탭

**Files:**
- Create: `frontend/src/app/verify/page.tsx`
- Create: `frontend/src/components/verify/TablePickerPanel.tsx`
- Create: `frontend/src/components/verify/PairCandidateList.tsx`
- Create: `frontend/src/components/verify/GateCard.tsx`
- Create: `frontend/src/components/verify/ContainmentCard.tsx`
- Create: `frontend/src/components/verify/JoinPreviewCard.tsx`
- Create: `frontend/src/components/verify/PendingList.tsx`
- Modify: `frontend/src/lib/i18n.ts` (verify.* 키), `frontend/src/components/AppHeader.tsx` (탭 2개)

**Interfaces:**
- Consumes: Task 10의 api 함수·verify-flow, 기존 `searchObjects`·`fetchObjectDetail`·`fetchObjectPreview`·`runContainment`·`confirmRelation`·`startAiSuggest`·`fetchAiJob`·`fetchPreviewAllowlist`, `getJoinVerdict`(join-verdict.ts), `ObjectSummary`·`ContainmentResponse`(types.ts).
- Produces: `/verify` 라우트. URL 프리필 계약(Task 14·15가 소비):
  `/verify?src=<objectId>&srcLabel=<schema.name>&srcCol=<columnId>&tgt=<objectId>&tgtLabel=<schema.name>&tgtCol=<columnId>` — 전부 선택적, label만 있으면 `searchObjects`로 id 해석.

구현 요지 (컴포넌트별 책임):

- **TablePickerPanel** — props `{ side: "src" | "tgt", selected: ObjectSummary | null, onSelect(obj: ObjectSummary | null): void }`. 검색 인풋(`searchObjects(q, "table")` 디바운스 300ms) + 결과 리스트 + 선택 해제. `data-testid="TablePickerPanel-searchInput-${side}"`, `TablePickerPanel-item-${obj.id}`.
- **PairCandidateList** — props `{ srcObjectId, tgtObjectId, selectedPair, onPick(pair: PairCandidate): void }`. 마운트·프롭 변경 시 `fetchPairCandidates`; 점수·신호 배지(naming/view_join/key); 수동 선택용으로 양쪽 `fetchObjectDetail`의 컬럼 드롭다운 2개 병행. `PairCandidateList-item-${src_column_id}-${tgt_column_id}`, `PairCandidateList-srcColumnSelect`, `PairCandidateList-tgtColumnSelect`.
- **GateCard** — props `{ gate: GateResult | null, busy: boolean, onRun(): void }`. 실행 버튼 + 결과: 양측 타입 배지(family 불일치 시 붉게), distinct 비율 바(`ratio`를 0~1 가로 바 — width %), 판정 문구. 차단 사유 i18n: `verify.gate.typeMismatch` "타입 불일치 ({src} vs {tgt}) — 조인 불가", `verify.gate.bothLowDistinct` "양측 모두 중복 심함 (m:n 추정) — 다른 컬럼을 선택하세요". `GateCard-runButton`, `GateCard-verdict`.
- **ContainmentCard** — props `{ result: ContainmentResponse | null, busy, enabled, onRun(): void }`. `getJoinVerdict(result, null)`로 판정 색·문구, containment %·cardinality·orphan 수치. `ContainmentCard-runButton`, `ContainmentCard-verdict`.
- **JoinPreviewCard** — props `{ srcColumnId, tgtColumnId, allowed: boolean, srcObjectId, tgtObjectId }`. `runValidatePreview` 결과 테이블(마스킹 컬럼 ●●● 표기는 서버가 처리) + 좌우 테이블 Top 200 샘플 온디맨드 버튼(`fetchObjectPreview(objectId, undefined, 200)`) — allowlist 미허용이면 안내 문구만(`verify.preview.notAllowed`). `JoinPreviewCard-joinButton`, `JoinPreviewCard-srcSampleButton`, `JoinPreviewCard-tgtSampleButton`.
- **PendingList** — props `{ onPick(rel: PendingRelation): void }`. `fetchPendingRelations` 목록(origin·status 배지, confidence) + AI 제안 실행 버튼(기존 erd/page.tsx의 `startAiSuggest`+`fetchAiJob` 1.5s 폴링 로직을 그대로 이식). `PendingList-item-${rel.id}`, `PendingList-aiSuggestButton`.
- **page.tsx** — 상태 소유: `src`/`tgt`(ObjectSummary), `pair`(선택 페어), `VerifyState`(verify-flow), 프리필 파싱(Suspense + useSearchParams — erd/page.tsx의 `anchorFromParams` 패턴 복제). 레이아웃: 좌(피커 2 + 후보) / 중(게이트→containment→프리뷰→확정 카드 세로) / 우(PendingList). 확정 버튼은 `canConfirm` 시 활성 → `confirmRelation` → `applyConfirm` + PendingList 갱신.

i18n 키(전부 ko/en 쌍): `nav.verify`("조인 검증"/"Join Verify"), `verify.startHint`, `verify.gate.run`, `verify.gate.pass`, `verify.gate.typeMismatch`, `verify.gate.bothLowDistinct`, `verify.gate.ratioLabel`, `verify.containment.run`, `verify.confirm.button`("키 확정"/"Confirm key"), `verify.confirm.done`, `verify.preview.join`, `verify.preview.sample`, `verify.preview.notAllowed`, `verify.pending.title`, `verify.pending.empty`, `verify.pending.aiSuggest`.

AppHeader: `LINKS` 배열을 다음으로 교체(제거 사유 주석도 함께 삭제):

```typescript
const LINKS = [
  { href: "/", key: "nav.tables" as const },
  { href: "/verify", key: "nav.verify" as const },
  { href: "/erd", key: "nav.erd" as const },
  { href: "/parsing", key: "nav.parsing" as const },
];
```

`nav.erd` 키는 i18n에 이미 있으면 재사용, 삭제됐으면 `{ ko: "ERD", en: "ERD" }`로 추가.

- [ ] **Step 1: 컴포넌트·페이지·i18n·헤더 구현** (위 요지대로; 파일당 하나의 export, verb 네이밍, 카드 시인성: 수치는 `text-2xl` 급 크게·바는 `h-2` 게이지·판정은 배경색 배지)
- [ ] **Step 2: 타입·린트 확인** — `cd frontend && npx tsc --noEmit && npx next lint`. Expected: 에러 0
- [ ] **Step 3: 기존 스위트 확인** — `npx vitest run`. Expected: PASS (기존 80+신규)
- [ ] **Step 4: 수동 스모크** — `npm run dev` + 백엔드 fixture 모드 기동, `/verify`에서 픽스처 테이블 2개 선택 → 후보 클릭 → 게이트 → containment → 확정까지 1회 완주. 결과를 보고에 명시.
- [ ] **Step 5: 커밋**

```bash
git add frontend/src/app/verify frontend/src/components/verify frontend/src/lib/i18n.ts frontend/src/components/AppHeader.tsx PROGRESS.md
git commit -m "feat(verify): add the 1:1 join verification page — 1:1 조인 검증 페이지 신설"
git push
```

---

## Phase 3 — 읽기 전용 ERD

### Task 12: lib/erd-graph.ts — 연결요소 그룹핑

**Files:**
- Create: `frontend/src/lib/erd-graph.ts`
- Test: `frontend/src/lib/erd-graph.test.ts`

**Interfaces:**
- Consumes: `GraphNode`·`GraphEdge`(types.ts).
- Produces: `groupConnectedComponents(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[][]` — 연결요소별 노드 배열, **크기 내림차순 → 최소 노드 id 오름차순**(결정적). Task 13이 소비.

- [ ] **Step 1: 실패하는 테스트 작성** — `frontend/src/lib/erd-graph.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import type { GraphEdge, GraphNode } from "./types";
import { groupConnectedComponents } from "./erd-graph";

function makeNode(id: number): GraphNode {
  return {
    id, schema: "dbo", name: `T${id}`, type: "table", row_count: 0,
    dmv_unresolved: false, lineage_flag: null, unresolved_dep_count: 0, columns: [],
  } as GraphNode;
}

function makeEdge(id: string, src: number, tgt: number): GraphEdge {
  return { id, kind: "fk", src_object_id: src, tgt_object_id: tgt, columns: [] } as GraphEdge;
}

describe("groupConnectedComponents", () => {
  it("splits disconnected clusters and sorts big-first, then by min id", () => {
    const nodes = [1, 2, 3, 4, 5, 6].map(makeNode);
    const edges = [makeEdge("a", 5, 6), makeEdge("b", 1, 2), makeEdge("c", 2, 3)];

    const groups = groupConnectedComponents(nodes, edges);

    expect(groups.map((g) => g.map((n) => n.id).sort((x, y) => x - y)))
      .toEqual([[1, 2, 3], [5, 6], [4]]); // 크기 3 → 2 → 고립 1
  });

  it("keeps an empty graph empty", () => {
    expect(groupConnectedComponents([], [])).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/lib/erd-graph.test.ts`. Expected: FAIL

- [ ] **Step 3: 구현** — `frontend/src/lib/erd-graph.ts`:

```typescript
/** 읽기 전용 ERD의 연결요소 그룹핑 — 클러스터 정렬용 순수 로직. */

import type { GraphEdge, GraphNode } from "./types";

export function groupConnectedComponents(
  nodes: GraphNode[], edges: GraphEdge[],
): GraphNode[][] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    parent.set(x, root);
    return root;
  };
  for (const n of nodes) parent.set(n.id, n.id);
  for (const e of edges) {
    const a = find(e.src_object_id);
    const b = find(e.tgt_object_id);
    if (a !== b) parent.set(a, b);
  }

  const byRoot = new Map<number, GraphNode[]>();
  for (const n of nodes) {
    const root = find(n.id);
    const group = byRoot.get(root) ?? [];
    group.push(n);
    byRoot.set(root, group);
  }
  return [...byRoot.values()].sort((g1, g2) =>
    g2.length - g1.length
    || Math.min(...g1.map((n) => n.id)) - Math.min(...g2.map((n) => n.id)));
}
```

- [ ] **Step 4: 통과 확인** — Step 2 명령 → PASS

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/lib/erd-graph.ts frontend/src/lib/erd-graph.test.ts PROGRESS.md
git commit -m "feat(erd): add connected-component grouping — 연결요소 클러스터 정렬 로직"
git push
```

---

### Task 13: ErdViewer + /erd 페이지 재작성

**Files:**
- Create: `frontend/src/components/erd/ErdViewer.tsx`
- Rewrite: `frontend/src/app/erd/page.tsx`
- Modify: `frontend/src/components/erd/TableNode.tsx` (읽기 전용 대응 — 아래 참조)

**Interfaces:**
- Consumes: `fetchErdGraph`(Task 10), `groupConnectedComponents`(Task 12), 기존 `TableNode`/`TableFlowNode`·`Legend`·`CardinalityMarkers`·`edge-style`·`layoutGraph`/`estimateNodeSize`(layout.ts).
- Produces: `/erd?focus=<objectId>&label=<schema.name>` 라우트 (Task 14 딥링크가 소비). ErdViewer props: `{ focusId: number | null, focusLabel: string | null }`.

구현 요지:

- **TableNode 수정(소폭)**: `TableNodeData.onExpandNeighbors`를 `((id: number) => void) | null`로 완화, null이면 이웃 확장 버튼(`ErdNode-expandButton-*`)을 렌더하지 않는다. `onSelectColumn`·`onVisibleColumnsChange`는 no-op을 넘긴다(시그니처 유지). `isAnchor`는 focus 하이라이트로 재활용.
- **ErdViewer**: 마운트 시 `fetchErdGraph()` 1회 → `groupConnectedComponents`로 그룹핑 → 그룹별 `layoutGraph`(ELK)를 독립 실행해 세로로 적층(그룹 간 y 오프셋 = 이전 그룹 최대 y + 120px). 노드 접기/펴기(`expandedNodes` Set — ErdCanvas의 `toggleNode` 패턴 복제), 엣지 클릭 → 우하단 카드에 검증 근거(kind·columns·containment은 없으므로 confidence·cardinality·last_verified_at) 표시. 팬/줌은 React Flow 기본. `nodesDraggable={false}`, `nodesConnectable={false}`, `edgesFocusable={true}`. 빈 그래프면 가이드 문구(`erd.emptyReadOnly`: "검증된 관계가 아직 없습니다 — 조인 검증에서 키를 확정하면 여기 그려집니다" + `/verify` 링크 버튼). focus 대상이 그래프에 있으면 `setCenter`로 센터링+`isAnchor` 하이라이트, 없으면 상단 배너(`erd.focusMissing`: "{label}은 아직 검증되지 않았습니다" + `/verify?src=<id>&srcLabel=<label>` 링크). `data-testid`: `ErdViewer-canvas`, `ErdViewer-emptyState`, `ErdViewer-focusMissingBanner`, `ErdViewer-edgeDetail`.
- **erd/page.tsx**: AppHeader + ErdViewer만. `?focus`·`?label` 파싱(Suspense + useSearchParams). SearchPanel·AI 제안·anchor 로직 전부 제거. AI 폴링 로직은 Task 11에서 이미 PendingList로 이식됨.
- i18n 추가: `erd.emptyReadOnly`, `erd.focusMissing`, `erd.goVerify`("조인 검증으로"/"Open Join Verify"). 기존 `erd.startHint`·`erd.aiSuggest`·`erd.aiNotice`·`erd.showViews` 키는 Task 15에서 정리.

- [ ] **Step 1: 구현** (위 요지대로)
- [ ] **Step 2: 타입·린트** — `npx tsc --noEmit && npx next lint`. Expected: 에러 0 (이 시점에 ErdCanvas는 아직 존재 — import 충돌 없음)
- [ ] **Step 3: 기존 스위트** — `npx vitest run`. Expected: PASS
- [ ] **Step 4: 수동 스모크** — dev 서버에서 `/erd` 빈 상태 → `/verify`에서 확정 1건 → `/erd`에 노드·엣지 등장 + `?focus` 센터링 확인. 결과를 보고에 명시.
- [ ] **Step 5: 커밋**

```bash
git add frontend/src/components/erd/ErdViewer.tsx frontend/src/app/erd/page.tsx frontend/src/components/erd/TableNode.tsx frontend/src/lib/i18n.ts PROGRESS.md
git commit -m "feat(erd): rewrite the ERD as a read-only whole graph — ERD를 읽기 전용 전체 그래프로 재작성"
git push
```

---

## Phase 4 — 딥링크·삭제·정리

### Task 14: 딥링크 재편

**Files:**
- Modify: `frontend/src/app/page.tsx` (`handleOpenErd`·`handleOpenColumn`, 253·262행 부근)
- Modify: `frontend/src/components/ChatPanel.tsx` (59행 부근)

**Interfaces:**
- Consumes: Task 11의 `/verify` URL 계약, Task 13의 `/erd?focus` 계약.

- [ ] **Step 1: page.tsx 수정**

```typescript
  const handleOpenErd = useCallback(() => {
    if (!selected) return;
    router.push(`/erd?focus=${selected.id}&label=${selected.schema}.${selected.name}`);
  }, [router, selected]);

  // 컬럼 클릭 → 조인 검증 페이지로 직행 — 소스 테이블·컬럼 프리필, target이 실려 오면
  // (조인 체크 결과의 「검증에 추가」) 타깃까지 채워 게이트부터 시작한다
  const handleOpenColumn = useCallback(
    (
      columnId: number, columnName: string,
      target?: { qname: string; columnId: number; column: string },
    ) => {
      if (!selected) return;
      const label = `${selected.schema}.${selected.name}`;
      let url = `/verify?src=${selected.id}&srcLabel=${encodeURIComponent(label)}`
        + `&srcCol=${columnId}`;
      if (target) {
        url += `&tgtLabel=${encodeURIComponent(target.qname)}&tgtCol=${target.columnId}`;
      }
      router.push(url);
    },
    [router, selected],
  );
```

(`columnName`이 미사용이 되면 파라미터에서 제거하고 호출부(TableDetail 등)도 함께 정리 — 시그니처 전파는 `npx tsc --noEmit`가 잡는다.)

- [ ] **Step 2: ChatPanel.tsx 수정** — 59행: `router.push(\`/erd?anchor=...\`)` → `router.push(\`/erd?focus=${hit.id}&label=${qname}\`)`
- [ ] **Step 3: 확인** — `npx tsc --noEmit && npx next lint && npx vitest run`. Expected: 전부 통과
- [ ] **Step 4: 커밋**

```bash
git add frontend/src/app/page.tsx frontend/src/components/ChatPanel.tsx PROGRESS.md
git commit -m "refactor(verify): repoint deep links to verify and focus — 딥링크를 검증·포커스로 재편"
git push
```

---

### Task 15: 프론트 구 검증 UI 삭제

**Files:**
- Delete: `frontend/src/components/erd/ErdCanvas.tsx`, `frontend/src/components/erd/JoinBuilder.tsx`, `frontend/src/components/SearchPanel.tsx`
- Delete: `frontend/src/lib/join-draft.ts`, `frontend/src/lib/join-draft.test.ts`, `frontend/src/lib/graph-merge.ts`, `frontend/src/lib/graph-merge.test.ts`, `frontend/src/lib/edge-anchors.ts`, `frontend/src/lib/edge-anchors.test.ts`
- Modify: `frontend/src/lib/api.ts` (`fetchGraph`·`runJoinPreview` 제거), `frontend/src/lib/types.ts` (`GraphResponse`·`JoinPreviewResponse` 등 고아 타입 제거), `frontend/src/lib/i18n.ts` (고아 키 제거)

- [ ] **Step 1: 파일 삭제** — 위 Delete 목록 `git rm`. 삭제 전 `grep -rn "ErdCanvas\|JoinBuilder\|SearchPanel\|join-draft\|graph-merge\|edge-anchors\|fetchGraph\|runJoinPreview" frontend/src --include="*.ts*"`로 잔존 참조 0 확인 (Task 13·14가 선행됐으면 없어야 정상; 있으면 그 참조 먼저 정리).
- [ ] **Step 2: api·types·i18n 고아 정리** — `fetchGraph`·`runJoinPreview`·`JoinPreviewResponse`·`GraphResponse`(ErdResponse가 대체)와, i18n에서 `erd.aiSuggest`·`erd.aiNotice`·`erd.showViews`·`erd.startHint` 등 이번 삭제로 미사용이 된 키만 제거 — **grep으로 미사용 확인 후 지운다** (기존 미사용 키는 건드리지 않음). `GraphNode`·`GraphEdge`는 ErdResponse가 쓰므로 유지.
- [ ] **Step 3: 확인** — `npx tsc --noEmit && npx next lint && npx vitest run && npm run build`. Expected: 전부 통과
- [ ] **Step 4: 커밋**

```bash
git add -A frontend/src PROGRESS.md
git commit -m "refactor(erd): drop the canvas-era verification UI — 캔버스 검증 UI 일괄 삭제"
git push
```

---

### Task 16: 백엔드 anchor-graph 삭제

**Files:**
- Modify: `backend/app/api/objects.py` (`get_object_graph` 및 이 삭제로 고아가 되는 헬퍼만)
- Modify: `backend/tests/test_query_api.py` (graph 테스트 삭제), `backend/tests/test_hidden_schemas.py` (graph 관련 테스트를 `/api/erd` 기반으로 교체 또는 삭제 — 숨김 검증은 test_erd_api.py가 이미 커버)

- [ ] **Step 1: 엔드포인트 삭제** — `get_object_graph` 함수 제거. `_load_fk_edges`·`_load_lineage_edges`·`_load_relation_edges`는 다른 사용처(erd.py의 `_load_fk_edges` 포함)를 grep으로 확인해 **고아가 된 것만** 제거. `_load_fk_edges`는 erd.py가 쓰므로 유지.
- [ ] **Step 2: 테스트 정리** — test_query_api.py의 `test_graph_*` 삭제. test_hidden_schemas.py에서 `/graph`를 치는 테스트는 검증 의도(숨긴 스키마 403·노드 제외)가 test_erd_api.py에 있는지 대조 후 삭제.
- [ ] **Step 3: 확인** — `cd backend && .venv/bin/pytest -q`. Expected: 전부 PASS
- [ ] **Step 4: 커밋**

```bash
git add backend/app/api/objects.py backend/tests/test_query_api.py backend/tests/test_hidden_schemas.py PROGRESS.md
git commit -m "refactor(erd): drop the anchor-graph endpoint — 앵커 그래프 API 삭제 (읽기 전용 ERD가 대체)"
git push
```

---

### Task 17: README·최종 검증

**Files:**
- Modify: `README.md` (ERD 설명 — 앵커 확장 → 읽기 전용 confirmed+FK, 조인 검증 페이지 소개, `GATE_SAMPLE_TOP`/`GATE_DISTINCT_RATIO` 환경변수 표)
- Modify: `PROGRESS.md` (브랜치 항목 최종 정리 — 중간 기록 압축)

- [ ] **Step 1: README 갱신** — 기존 ERD·검증 흐름 설명 절을 스펙의 새 구조로 교체. 환경변수 표에 게이트 2종 추가.
- [ ] **Step 2: 전체 검증**

```bash
cd backend && .venv/bin/pytest -q
cd ../frontend && npx tsc --noEmit && npx next lint && npx vitest run && npm run build
```
Expected: 전부 통과 — 실패 시 보고하고 멈춘다.

- [ ] **Step 3: 커밋**

```bash
git add README.md PROGRESS.md
git commit -m "docs: describe the verify page and read-only ERD — 검증 페이지·읽기 전용 ERD 문서화"
git push
```

- [ ] **Step 4: 머지 준비** — superpowers:finishing-a-development-branch 스킬로 브랜치 정리(머지 시 PROGRESS 브랜치 항목을 요약 1건으로 압축 — `rules/common/git.md` On Branch Merge).

---

## 실행 메모

- 브랜치: `feature/verify-page-readonly-erd` — 실행 시작 시 superpowers:using-git-worktrees로 격리.
- Task 1~9(백엔드)와 10(프론트 lib)은 순차. 11 이후는 백엔드 완료를 전제.
- 수동 스모크(Task 11·13)는 fixture 모드 백엔드(`DATABASE_URL=sqlite:... .venv/bin/uvicorn app.main:app --port 8000`)로 수행 — 기존 `docs/local-test.md` 절차 참조.
- 스펙과 어긋나는 발견(예: `_load_fk_edges` 시그니처 상이)은 스펙이 아니라 **코드 현실**을 따르고 보고에 명시한다.
