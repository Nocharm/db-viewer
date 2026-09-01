# 멀티 소스 DB 조회 (PostgreSQL / SQLite) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 같은 서버의 다른 도커 서비스 DB(PostgreSQL / SQLite)를 db-viewer에 소스로 등록해
테이블·뷰 탐색, 행 미리보기, FK 기반 ERD를 기존 화면에서 그대로 본다.

**Architecture:** 카탈로그에 "소스(`data_sources`)" 축을 도입하고 스냅샷을 소스에 매단다.
엔진별 수집기가 **기존 `CatalogPayload` ingest 계약을 채우면** 하류(검색·ERD·미리보기
정책·스냅샷 diff)가 통째로 재사용된다. 사내 MSSQL은 n8n 경유를 그대로 두고, 신규 소스만
백엔드가 직결한다.

**Tech Stack:** FastAPI / SQLAlchemy 2.0 / Alembic / psycopg 3 / stdlib sqlite3 /
cryptography(Fernet) / Next.js 15 / TypeScript

**Spec:** `docs/superpowers/specs/2026-08-25-multi-source-db-design.md`

## Global Constraints

- **읽기 전용.** 소스를 향해 INSERT/UPDATE/DELETE/DDL을 만들지 않는다. 위반은 리뷰에서 반려.
- **백엔드 테스트는 SQLite에서 alembic 마이그레이션을 돌린다** (`backend/tests/conftest.py`의
  `migrated_engine`). 모든 마이그레이션은 PostgreSQL과 SQLite **양쪽에서** 동작해야 한다.
  PK 변경은 `create → copy → drop → rename`으로 명시적으로 쓴다 (SQLite는 ALTER로 PK를 못 바꾼다).
- **비밀은 절대 커밋하지 않는다.** 접속 비밀번호는 Fernet 암호문으로만 저장하고 API 응답에
  싣지 않는다.
- Python: 모든 시그니처에 타입 힌트, `X | None`(not `Optional`), `list[str]`(not `List`),
  함수명은 동사로 시작, import는 stdlib → third-party → local 그룹 분리.
- TypeScript: `strict`, `any` 금지, `const` 기본, named export, props는 `interface`,
  2-space 들여쓰기. 인터랙티브 요소에 `data-testid="ComponentName-role"`.
- 주석은 **왜**를 쓴다. 모든 파일 첫 줄에 한 줄 요약 docstring (`"""역할. / Role."""`).
- 커밋: `type(scope): English summary — 한국어 요약`. **커밋 직전 `PROGRESS.md` 갱신** (1–3줄).
- 테스트는 AAA(Arrange/Act/Assert). 외부 의존만 mock, 내부 로직은 mock 금지.

**검증 명령** (태스크마다 반복 등장):

```bash
cd backend && python -m pytest -q                  # 백엔드 전체
cd backend && ruff check app tests                 # 린트
cd frontend && npx tsc --noEmit && npm run lint && npx vitest run
```

**베이스라인:** 백엔드 335 passed / 1 skipped. 이 숫자가 줄면 회귀다.

---

## File Structure

**신규 (백엔드)**

| 파일 | 책임 |
|---|---|
| `backend/app/models/sources.py` | `DataSource` 모델 하나 |
| `backend/app/sources/crypto.py` | Fernet 암·복호화 + 키 설정 여부 |
| `backend/app/sources/registry.py` | 소스 조회 + SQLAlchemy URL 조립 |
| `backend/app/sources/connection.py` | 소스별 SQLAlchemy Engine 캐시 |
| `backend/app/sources/preview_sql.py` | 미리보기 SQL 빌더 (순수 함수, IO 없음) |
| `backend/app/sources/direct_preview.py` | `DirectTablePreview` — 빌더 결과 실행 |
| `backend/app/sources/pg_collector.py` | PostgreSQL → `CatalogPayload` |
| `backend/app/sources/sqlite_collector.py` | SQLite → `CatalogPayload` |
| `backend/app/sources/direct_runner.py` | `DirectCollectRunner` — 수집 잡 연동 |
| `backend/app/api/sources.py` | `/api/sources` CRUD + 연결 테스트 |
| `backend/alembic/versions/0015_data_sources.py` | 테이블 + seed |
| `backend/alembic/versions/0016_snapshot_source.py` | `snapshots.data_source_id` |
| `backend/alembic/versions/0017_policy_by_source.py` | allowlist·categories 소스 축 |

**신규 (프론트엔드)**

| 파일 | 책임 |
|---|---|
| `frontend/src/components/SourceSelector.tsx` | 헤더 소스 선택기 |
| `frontend/src/components/admin/DataSourcePanel.tsx` | 소스 등록·수정·연결 테스트 |

**수정**

`backend/app/models/__init__.py`, `backend/app/models/preview_policy.py`,
`backend/app/models/categories.py`, `backend/app/models/catalog.py`,
`backend/app/schemas/ingest.py`, `backend/app/adapters/__init__.py`,
`backend/app/api/ingest.py`, `backend/app/api/objects.py`, `backend/app/api/erd.py`,
`backend/app/api/collect.py`, `backend/app/api/admin.py`,
`backend/app/services/preview_policy.py`, `backend/app/config.py`,
`backend/requirements.txt`, `frontend/src/lib/api.ts`, `frontend/src/app/page.tsx`,
`frontend/src/app/erd/page.tsx`, `frontend/src/app/admin/page.tsx`,
`.env.example`, `docker-compose.yml`, `README.md`

---

## Phase 1 — 소스 축 도입 (Task 1–5)

이 페이즈가 끝나도 **화면은 아무것도 달라지지 않는다.** 성공 기준은 "기존 335 그린 +
MSSQL 동작 무변경"이다.

---

### Task 1: `DataSource` 모델 + 마이그레이션 0015

**Files:**
- Create: `backend/app/models/sources.py`
- Create: `backend/alembic/versions/0015_data_sources.py`
- Modify: `backend/app/models/__init__.py`
- Test: `backend/tests/test_data_sources.py`

**Interfaces:**
- Produces: `DataSource` (SQLAlchemy 모델). 필드 —
  `id:int`, `name:str`, `engine:str`, `access_mode:str`, `host:str|None`, `port:int|None`,
  `database:str|None`, `username:str|None`, `password_enc:str|None`, `file_path:str|None`,
  `is_enabled:bool`, `is_managed:bool`, `created_at:datetime`, `updated_at:datetime`,
  `last_ok_at:datetime|None`, `last_error:str|None`
- Produces: `MANAGED_MSSQL_SOURCE_ID = 1` (상수, `app/models/sources.py`)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/tests/test_data_sources.py`:

```python
"""data_sources 모델·시드 테스트. / DataSource model and seed row."""

from sqlalchemy.orm import sessionmaker

from app.models import DataSource
from app.models.sources import MANAGED_MSSQL_SOURCE_ID


def test_migration_seeds_managed_mssql_source(migrated_engine):
    # Arrange / Act
    with sessionmaker(bind=migrated_engine)() as db:
        source = db.get(DataSource, MANAGED_MSSQL_SOURCE_ID)

    # Assert: 기존 n8n MSSQL이 소스 1건으로 표현되고, UI가 못 건드리게 잠겨 있다
    assert source is not None
    assert source.engine == "mssql"
    assert source.access_mode == "n8n"
    assert source.is_managed is True
    assert source.is_enabled is True


def test_source_name_is_unique(migrated_engine):
    # Arrange
    from datetime import UTC, datetime

    import pytest
    from sqlalchemy.exc import IntegrityError

    now = datetime.now(UTC)
    with sessionmaker(bind=migrated_engine)() as db:
        db.add(DataSource(name="dup", engine="sqlite", access_mode="direct",
                          file_path="/tmp/a.db", is_enabled=True, is_managed=False,
                          created_at=now, updated_at=now))
        db.commit()

        # Act / Assert
        db.add(DataSource(name="dup", engine="sqlite", access_mode="direct",
                          file_path="/tmp/b.db", is_enabled=True, is_managed=False,
                          created_at=now, updated_at=now))
        with pytest.raises(IntegrityError):
            db.commit()
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd backend && python -m pytest tests/test_data_sources.py -q`
Expected: FAIL — `ImportError: cannot import name 'DataSource'`

- [ ] **Step 3: 모델을 쓴다**

`backend/app/models/sources.py`:

```python
"""Registered data sources. / 조회 대상 DB 소스 등록부.

한 소스 = 한 DB. 스냅샷이 여기에 매달리고, 수집기·미리보기 실행기 선택도 이 행이 정한다.
사내 MSSQL도 소스 1건으로 표현하되 접속정보는 여전히 .env/n8n에 있어 is_managed로 잠근다.
"""

from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.catalog import Base

# 마이그레이션이 시드하는 사내 MSSQL 소스 — 소스 미지정 요청의 기본값
MANAGED_MSSQL_SOURCE_ID = 1


class DataSource(Base):
    """조회 대상 DB 한 곳. / one registered database."""

    __tablename__ = "data_sources"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    engine: Mapped[str] = mapped_column(String(16))
    # n8n = 워크플로 경유(사내 MSSQL) / direct = 백엔드가 직접 접속
    access_mode: Mapped[str] = mapped_column(String(8))

    host: Mapped[str | None] = mapped_column(String(255))
    port: Mapped[int | None] = mapped_column(Integer)
    database: Mapped[str | None] = mapped_column(String(128))
    username: Mapped[str | None] = mapped_column(String(128))
    # Fernet 암호문만 저장 — 평문이 이 컬럼에 들어가는 경로는 없어야 한다
    password_enc: Mapped[str | None] = mapped_column(Text)
    # sqlite 전용 — 컨테이너 내부 경로 / container-side path for sqlite sources
    file_path: Mapped[str | None] = mapped_column(String(500))

    is_enabled: Mapped[bool] = mapped_column(Boolean)
    # true면 .env/n8n이 소유 — API가 수정·삭제를 거부한다
    is_managed: Mapped[bool] = mapped_column(Boolean)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_ok_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        CheckConstraint("engine IN ('mssql', 'postgres', 'sqlite')",
                        name="ck_data_sources_engine"),
        CheckConstraint("access_mode IN ('n8n', 'direct')",
                        name="ck_data_sources_access_mode"),
    )
```

- [ ] **Step 4: 모델을 export 한다**

`backend/app/models/__init__.py` — import 블록에 `from app.models.sources import DataSource`를
추가하고 `__all__`에 `"DataSource"`를 알파벳 순 위치(`"CollectJob"` 다음)에 넣는다.

- [ ] **Step 5: 마이그레이션을 쓴다**

`backend/alembic/versions/0015_data_sources.py`:

```python
"""Registered data sources (조회 대상 DB 소스 등록부).

Revision ID: 0015
Revises: 0014
Create Date: 2026-08-25

사내 MSSQL도 소스 1건(id=1, is_managed)으로 시드한다 — 소스별 분기에서 NULL 특례를
만들지 않기 위해서다. 접속정보는 여전히 .env/n8n에 있고 이 행은 라벨·라우팅 표식만 담는다.
"""

from datetime import UTC, datetime
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "0015"
down_revision: Union[str, None] = "0014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    sources = op.create_table(
        "data_sources",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False, unique=True),
        sa.Column("engine", sa.String(16), nullable=False),
        sa.Column("access_mode", sa.String(8), nullable=False),
        sa.Column("host", sa.String(255), nullable=True),
        sa.Column("port", sa.Integer(), nullable=True),
        sa.Column("database", sa.String(128), nullable=True),
        sa.Column("username", sa.String(128), nullable=True),
        sa.Column("password_enc", sa.Text(), nullable=True),
        sa.Column("file_path", sa.String(500), nullable=True),
        sa.Column("is_enabled", sa.Boolean(), nullable=False),
        sa.Column("is_managed", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_ok_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.CheckConstraint("engine IN ('mssql', 'postgres', 'sqlite')",
                           name="ck_data_sources_engine"),
        sa.CheckConstraint("access_mode IN ('n8n', 'direct')",
                           name="ck_data_sources_access_mode"),
    )
    now = datetime.now(UTC)
    op.bulk_insert(sources, [{
        "id": 1, "name": "사내 MSSQL", "engine": "mssql", "access_mode": "n8n",
        "host": None, "port": None, "database": None, "username": None,
        "password_enc": None, "file_path": None,
        "is_enabled": True, "is_managed": True,
        "created_at": now, "updated_at": now, "last_ok_at": None, "last_error": None,
    }])


def downgrade() -> None:
    op.drop_table("data_sources")
```

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run: `cd backend && python -m pytest tests/test_data_sources.py -q`
Expected: PASS (2 passed)

- [ ] **Step 7: 회귀 확인**

Run: `cd backend && python -m pytest -q && ruff check app tests`
Expected: 337 passed, 1 skipped / ruff 클린

- [ ] **Step 8: 커밋**

`PROGRESS.md`의 `## 2026-08-25` 절에 한 줄 추가한 뒤:

```bash
git add backend/app/models/sources.py backend/app/models/__init__.py \
        backend/alembic/versions/0015_data_sources.py \
        backend/tests/test_data_sources.py PROGRESS.md
git commit -m "feat(sources): data_sources table with managed MSSQL seed — 소스 등록부 도입"
```

---

### Task 2: 스냅샷에 소스 축 추가 (마이그레이션 0016)

**Files:**
- Create: `backend/alembic/versions/0016_snapshot_source.py`
- Modify: `backend/app/models/catalog.py` (`Snapshot`)
- Modify: `backend/app/api/objects.py:37-51` (`resolve_snapshot`)
- Test: `backend/tests/test_data_sources.py` (추가)

**Interfaces:**
- Consumes: `DataSource`, `MANAGED_MSSQL_SOURCE_ID` (Task 1)
- Produces: `Snapshot.data_source_id: int`
- Produces: `resolve_snapshot(db: Session, snapshot_id: int | None = None, source_id: int | None = None) -> Snapshot`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/tests/test_data_sources.py`에 이어붙인다:

```python
def _add_snapshot(db, source_id: int, status: str = "ready"):
    from datetime import UTC, datetime

    from app.models import Snapshot

    snap = Snapshot(collected_at=datetime.now(UTC), source_db="x",
                    status=status, data_source_id=source_id)
    db.add(snap)
    db.flush()
    return snap


def test_resolve_snapshot_picks_latest_ready_of_that_source(migrated_engine):
    # Arrange: 두 소스에 각각 ready 스냅샷
    from datetime import UTC, datetime

    from app.api.objects import resolve_snapshot
    from app.models import DataSource

    now = datetime.now(UTC)
    with sessionmaker(bind=migrated_engine)() as db:
        other = DataSource(name="svca", engine="postgres", access_mode="direct",
                           host="h", port=5432, database="d", username="u",
                           is_enabled=True, is_managed=False,
                           created_at=now, updated_at=now)
        db.add(other)
        db.flush()
        mssql_snap = _add_snapshot(db, MANAGED_MSSQL_SOURCE_ID)
        other_snap = _add_snapshot(db, other.id)
        db.commit()

        # Act / Assert: 소스를 지정하면 그 소스의 최신 ready
        assert resolve_snapshot(db, source_id=other.id).id == other_snap.id
        # 소스를 생략하면 기본 소스(사내 MSSQL) — 기존 호출자가 안 깨진다
        assert resolve_snapshot(db).id == mssql_snap.id
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd backend && python -m pytest tests/test_data_sources.py -q`
Expected: FAIL — `TypeError: 'data_source_id' is an invalid keyword argument for Snapshot`

- [ ] **Step 3: 마이그레이션을 쓴다**

`backend/alembic/versions/0016_snapshot_source.py`:

```python
"""Snapshots hang off a data source (스냅샷에 소스 축 추가).

Revision ID: 0016
Revises: 0015
Create Date: 2026-08-25

기존 스냅샷은 전부 시드된 사내 MSSQL 소스로 백필한다 — nullable로 추가 → 백필 →
NOT NULL 순서를 지켜야 기존 데이터가 있는 배포에서 마이그레이션이 통과한다.
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "0016"
down_revision: Union[str, None] = "0015"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

MANAGED_SOURCE_ID = 1


def upgrade() -> None:
    op.add_column("snapshots", sa.Column("data_source_id", sa.Integer(), nullable=True))
    op.execute(f"UPDATE snapshots SET data_source_id = {MANAGED_SOURCE_ID} "
               "WHERE data_source_id IS NULL")
    # SQLite는 ALTER로 nullable을 못 바꾼다 — batch로 테이블을 재작성한다
    with op.batch_alter_table("snapshots") as batch:
        batch.alter_column("data_source_id", existing_type=sa.Integer(), nullable=False)
        batch.create_foreign_key("fk_snapshots_data_source_id", "data_sources",
                                 ["data_source_id"], ["id"])
    op.create_index("ix_snapshots_source_status", "snapshots",
                    ["data_source_id", "status", "id"])


def downgrade() -> None:
    op.drop_index("ix_snapshots_source_status", table_name="snapshots")
    with op.batch_alter_table("snapshots") as batch:
        batch.drop_constraint("fk_snapshots_data_source_id", type_="foreignkey")
        batch.drop_column("data_source_id")
```

- [ ] **Step 4: 모델을 갱신한다**

`backend/app/models/catalog.py`의 `Snapshot`에 필드를 추가한다 (`status` 아래):

```python
    # 어느 소스의 스냅샷인가 — 소스별 "최신 ready" 해석의 축
    data_source_id: Mapped[int] = mapped_column(
        ForeignKey("data_sources.id", name="fk_snapshots_data_source_id")
    )
```

- [ ] **Step 5: `resolve_snapshot`을 소스 인지로 바꾼다**

`backend/app/api/objects.py`의 함수를 통째로 교체한다:

```python
def resolve_snapshot(
    db: Session, snapshot_id: int | None = None, source_id: int | None = None
) -> Snapshot:
    """지정 스냅샷, 없으면 그 소스의 최신 ready / requested snapshot or the source's latest ready.

    source_id를 생략하면 기본 소스(시드된 사내 MSSQL)로 본다 — 소스 개념이 없던
    기존 호출자가 그대로 동작해야 한다.
    """
    if snapshot_id is not None:
        snapshot = db.get(Snapshot, snapshot_id)
        if snapshot is None:
            raise HTTPException(404, {"message": "snapshot not found",
                                      "context": {"snapshot_id": snapshot_id}})
        return snapshot
    target = source_id if source_id is not None else MANAGED_MSSQL_SOURCE_ID
    snapshot = db.execute(
        select(Snapshot)
        .where(Snapshot.status == "ready", Snapshot.data_source_id == target)
        .order_by(Snapshot.id.desc()).limit(1)
    ).scalar_one_or_none()
    if snapshot is None:
        raise HTTPException(404, {"message": "no ready snapshot for this source",
                                  "context": {"source_id": target}})
    return snapshot
```

import 추가: `from app.models.sources import MANAGED_MSSQL_SOURCE_ID`

- [ ] **Step 6: 스냅샷을 만드는 기존 코드를 고친다**

`backend/app/api/ingest.py`의 `Snapshot(...)` 생성부에 `data_source_id`를 넘긴다.
`CatalogPayload`에 필드를 추가한다 (`backend/app/schemas/ingest.py`, `source_db` 아래):

```python
    # 어느 소스의 수집인가 — n8n(구 계약)은 안 보내므로 None이면 기본 소스
    data_source_id: int | None = None
```

`ingest_catalog`에서 스냅샷을 만들 때:

```python
    snapshot = Snapshot(
        collected_at=payload.collected_at, source_db=payload.source_db,
        status="collecting",
        data_source_id=payload.data_source_id or MANAGED_MSSQL_SOURCE_ID,
    )
```

- [ ] **Step 7: 테스트가 통과하는지 확인한다**

Run: `cd backend && python -m pytest -q`
Expected: 338 passed, 1 skipped

- [ ] **Step 8: 마이그레이션 왕복을 확인한다**

```bash
cd backend && python - <<'PY'
from tests.conftest import apply_migrations
import tempfile, pathlib
from alembic import command
from alembic.config import Config
d = tempfile.mkdtemp(); url = f"sqlite:///{d}/t.db"
apply_migrations(url)
cfg = Config("alembic.ini"); cfg.set_main_option("script_location", "alembic")
cfg.set_main_option("sqlalchemy.url", url)
command.downgrade(cfg, "0014"); command.upgrade(cfg, "head")
print("roundtrip ok")
PY
```
Expected: `roundtrip ok`

- [ ] **Step 9: 커밋**

```bash
git add backend/alembic/versions/0016_snapshot_source.py backend/app/models/catalog.py \
        backend/app/api/objects.py backend/app/api/ingest.py backend/app/schemas/ingest.py \
        backend/tests/test_data_sources.py PROGRESS.md
git commit -m "feat(sources): snapshots hang off a data source — 스냅샷 소스 축 + 백필"
```

---

### Task 3: 노출 정책을 소스별로 분리 (마이그레이션 0017)

소스가 여럿이면 A서비스의 `public` 허용이 B서비스의 `public`까지 여는 사고가 난다.
**이 태스크를 건너뛰면 보안 결함이다.**

**Files:**
- Create: `backend/alembic/versions/0017_policy_by_source.py`
- Modify: `backend/app/models/preview_policy.py`, `backend/app/models/categories.py`
- Modify: `backend/app/services/preview_policy.py`
- Modify: `backend/app/api/admin.py`, `backend/app/api/objects.py`, `backend/app/api/categories.py`
- Modify: `backend/tests/conftest.py` (`allow_preview` 픽스처)
- Test: `backend/tests/test_preview_policy_by_source.py`

**Interfaces:**
- Consumes: `DataSource`, `MANAGED_MSSQL_SOURCE_ID` (Task 1)
- Produces: `is_preview_allowed(db: Session, source_id: int, schema: str) -> bool`
- Produces: `list_allowed_schemas(db: Session, source_id: int) -> list[str]`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/tests/test_preview_policy_by_source.py`:

```python
"""미리보기 허용이 소스 경계를 넘지 않는지. / allowlist must not leak across sources."""

from datetime import UTC, datetime

from sqlalchemy.orm import sessionmaker

from app.models import DataSource, PreviewAllowlist
from app.models.sources import MANAGED_MSSQL_SOURCE_ID
from app.services.preview_policy import is_preview_allowed


def test_allowlist_does_not_leak_across_sources(migrated_engine):
    # Arrange: 소스 A에서만 'public'을 허용
    now = datetime.now(UTC)
    with sessionmaker(bind=migrated_engine)() as db:
        other = DataSource(name="svcb", engine="postgres", access_mode="direct",
                           host="h", port=5432, database="d", username="u",
                           is_enabled=True, is_managed=False,
                           created_at=now, updated_at=now)
        db.add(other)
        db.flush()
        db.add(PreviewAllowlist(data_source_id=MANAGED_MSSQL_SOURCE_ID, schema="public",
                                note=None, added_by="test", created_at=now))
        db.commit()

        # Act / Assert: 같은 이름이어도 다른 소스는 여전히 차단
        assert is_preview_allowed(db, MANAGED_MSSQL_SOURCE_ID, "public") is True
        assert is_preview_allowed(db, other.id, "public") is False
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd backend && python -m pytest tests/test_preview_policy_by_source.py -q`
Expected: FAIL — `TypeError: 'data_source_id' is an invalid keyword argument`

- [ ] **Step 3: 마이그레이션을 쓴다**

PK 변경이므로 `create → copy → drop → rename`을 명시적으로 쓴다. SQLite와 PostgreSQL
양쪽에서 같은 코드가 돈다.

`backend/alembic/versions/0017_policy_by_source.py`:

```python
"""Preview allowlist and schema categories become per-source (노출 정책 소스별 분리).

Revision ID: 0017
Revises: 0016
Create Date: 2026-08-25

같은 스키마명이 서로 다른 소스에 존재할 수 있다('public'). 소스 축이 없으면 한쪽을
허용한 것이 다른 쪽까지 여는 사고가 난다. PK 변경은 SQLite가 ALTER를 지원하지 않으므로
새 테이블 생성 → 복사 → 교체로 쓴다.
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "0017"
down_revision: Union[str, None] = "0016"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

MANAGED_SOURCE_ID = 1


def upgrade() -> None:
    op.create_table(
        "preview_allowlist_new",
        sa.Column("data_source_id", sa.Integer(), primary_key=True),
        sa.Column("schema", sa.String(128), primary_key=True),
        sa.Column("note", sa.String(300), nullable=True),
        sa.Column("added_by", sa.String(100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.execute(
        f'INSERT INTO preview_allowlist_new (data_source_id, "schema", note, added_by, created_at) '
        f'SELECT {MANAGED_SOURCE_ID}, "schema", note, added_by, created_at FROM preview_allowlist'
    )
    op.drop_table("preview_allowlist")
    op.rename_table("preview_allowlist_new", "preview_allowlist")

    op.create_table(
        "schema_categories_new",
        sa.Column("data_source_id", sa.Integer(), primary_key=True),
        sa.Column("schema_name", sa.String(128), primary_key=True),
        sa.Column("category", sa.String(100), nullable=False),
        sa.Column("updated_by", sa.String(100), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.execute(
        f"INSERT INTO schema_categories_new "
        f"(data_source_id, schema_name, category, updated_by, updated_at) "
        f"SELECT {MANAGED_SOURCE_ID}, schema_name, category, updated_by, updated_at "
        f"FROM schema_categories"
    )
    op.drop_table("schema_categories")
    op.rename_table("schema_categories_new", "schema_categories")


def downgrade() -> None:
    op.create_table(
        "preview_allowlist_old",
        sa.Column("schema", sa.String(128), primary_key=True),
        sa.Column("note", sa.String(300), nullable=True),
        sa.Column("added_by", sa.String(100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.execute(
        f'INSERT INTO preview_allowlist_old ("schema", note, added_by, created_at) '
        f'SELECT "schema", note, added_by, created_at FROM preview_allowlist '
        f"WHERE data_source_id = {MANAGED_SOURCE_ID}"
    )
    op.drop_table("preview_allowlist")
    op.rename_table("preview_allowlist_old", "preview_allowlist")

    op.create_table(
        "schema_categories_old",
        sa.Column("schema_name", sa.String(128), primary_key=True),
        sa.Column("category", sa.String(100), nullable=False),
        sa.Column("updated_by", sa.String(100), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.execute(
        f"INSERT INTO schema_categories_old (schema_name, category, updated_by, updated_at) "
        f"SELECT schema_name, category, updated_by, updated_at FROM schema_categories "
        f"WHERE data_source_id = {MANAGED_SOURCE_ID}"
    )
    op.drop_table("schema_categories")
    op.rename_table("schema_categories_old", "schema_categories")
```

- [ ] **Step 4: 모델에 PK 컬럼을 추가한다**

`backend/app/models/preview_policy.py`의 `PreviewAllowlist`에:

```python
    # 같은 스키마명이 여러 소스에 존재한다 — 소스가 PK의 일부여야 허용이 새지 않는다
    data_source_id: Mapped[int] = mapped_column(Integer, primary_key=True)
```
(`schema` 위에 두고, `from sqlalchemy import Integer`를 import에 추가)

`backend/app/models/categories.py`의 `SchemaCategory`에 같은 필드를 `schema_name` 위에 추가.

- [ ] **Step 5: 서비스 함수 시그니처를 바꾼다**

`backend/app/services/preview_policy.py`를 통째로 교체:

```python
"""Preview allowlist lookups. / 미리보기 허용 여부 조회.

정책은 한 줄이다: **그 소스에서 허용 목록에 오른 스키마의 객체만 미리보기가 열린다.**
목록이 비어 있으면 전부 차단 — 설정을 잊은 배포가 값 데이터를 여는 쪽으로 기울지 않게 한다.
소스가 키의 일부인 이유: 'public' 같은 흔한 스키마명이 여러 소스에 동시에 존재한다.
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import PreviewAllowlist


def list_allowed_schemas(db: Session, source_id: int) -> list[str]:
    return list(db.execute(
        select(PreviewAllowlist.schema)
        .where(PreviewAllowlist.data_source_id == source_id)
        .order_by(PreviewAllowlist.schema)
    ).scalars())


def is_preview_allowed(db: Session, source_id: int, schema: str) -> bool:
    return db.get(PreviewAllowlist, (source_id, schema)) is not None
```

- [ ] **Step 6: 호출부를 고친다**

- `backend/app/api/objects.py`의 `get_object_preview` — 객체 → 스냅샷 → `data_source_id`를
  얻어 넘긴다:
  ```python
      snapshot = db.get(Snapshot, obj.snapshot_id)
      source_id = snapshot.data_source_id if snapshot else MANAGED_MSSQL_SOURCE_ID
      if not is_preview_allowed(db, source_id, obj.schema):
  ```
- `backend/app/api/objects.py`의 `get_preview_allowlist` — `source_id: int | None = None`
  쿼리 파라미터를 받아 `list_allowed_schemas(db, source_id or MANAGED_MSSQL_SOURCE_ID)`.
- `backend/app/api/admin.py`의 `list_preview_allowlist` / `add_preview_allow` /
  `remove_preview_allow` — 각각 `source_id`(기본 `MANAGED_MSSQL_SOURCE_ID`)를 받아
  `PreviewAllowlist(data_source_id=..., ...)`, `db.get(PreviewAllowlist, (source_id, schema))`로 바꾼다.
  `add_preview_allow`의 "카탈로그에 있는 스키마인가" 검사도 그 소스의 스냅샷으로 좁힌다:
  ```python
      exists = db.execute(
          select(CatalogObject.id)
          .join(Snapshot, Snapshot.id == CatalogObject.snapshot_id)
          .where(CatalogObject.schema == schema, Snapshot.data_source_id == source_id)
          .limit(1)
      ).scalar_one_or_none()
  ```
- `backend/app/api/categories.py` — `SchemaCategory` 조회·저장에 `data_source_id`를 더한다.

- [ ] **Step 7: `allow_preview` 픽스처를 고친다**

`backend/tests/conftest.py`의 `allow_preview`를 소스 인지로 바꾼다:

```python
    def allow(*qnames: str, source_id: int = 1) -> None:
        with sessionmaker(bind=migrated_engine)() as db:
            for schema in {qname.split(".", 1)[0] for qname in qnames}:
                if db.get(PreviewAllowlist, (source_id, schema)) is not None:
                    continue
                db.add(PreviewAllowlist(data_source_id=source_id, schema=schema,
                                        note=None, added_by="test",
                                        created_at=datetime.now(UTC)))
            db.commit()
```

- [ ] **Step 8: 테스트가 통과하는지 확인한다**

Run: `cd backend && python -m pytest -q`
Expected: 339 passed, 1 skipped — 기존 allowlist 테스트가 전부 그대로 통과해야 한다

- [ ] **Step 9: 커밋**

```bash
git add backend/alembic/versions/0017_policy_by_source.py backend/app/models \
        backend/app/services/preview_policy.py backend/app/api backend/tests
git add PROGRESS.md
git commit -m "fix(sources): scope preview allowlist and categories per source — 노출 정책 소스별 분리"
```

---

### Task 4: 접속정보 암호화 + 설정

**Files:**
- Create: `backend/app/sources/__init__.py`, `backend/app/sources/crypto.py`
- Modify: `backend/app/config.py`, `backend/requirements.txt`
- Test: `backend/tests/test_source_crypto.py`

**Interfaces:**
- Produces: `is_crypto_configured() -> bool`
- Produces: `encrypt_secret(plain: str) -> str`
- Produces: `decrypt_secret(token: str) -> str`
- Produces: `CryptoNotConfigured(RuntimeError)`
- Produces: `Settings.source_secret_key: str`, `Settings.source_connect_timeout: int`,
  `Settings.source_query_timeout: int`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/tests/test_source_crypto.py`:

```python
"""소스 비밀번호 암·복호화. / source secret encryption."""

import pytest

from app.config import get_settings
from app.sources.crypto import (
    CryptoNotConfigured,
    decrypt_secret,
    encrypt_secret,
    is_crypto_configured,
)


@pytest.fixture()
def configured_key(monkeypatch):
    # Arrange: Fernet 키를 설정에 주입 (lru_cache된 settings를 비운다)
    from cryptography.fernet import Fernet

    monkeypatch.setenv("SOURCE_SECRET_KEY", Fernet.generate_key().decode())
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_encrypt_decrypt_roundtrip(configured_key):
    # Act
    token = encrypt_secret("hunter2")

    # Assert: 저장되는 값에 평문이 남지 않는다
    assert "hunter2" not in token
    assert decrypt_secret(token) == "hunter2"


def test_refuses_without_key(monkeypatch):
    # Arrange: 키 미설정
    monkeypatch.setenv("SOURCE_SECRET_KEY", "")
    get_settings.cache_clear()

    # Act / Assert: 평문 저장으로 흘러가는 대신 명시적으로 거부한다
    assert is_crypto_configured() is False
    with pytest.raises(CryptoNotConfigured):
        encrypt_secret("hunter2")
    get_settings.cache_clear()
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd backend && python -m pytest tests/test_source_crypto.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.sources'`

- [ ] **Step 3: 설정 필드를 추가한다**

`backend/app/config.py`의 `Settings`에 (`preview_admin_password` 아래):

```python
    # Environment: 소스 접속 비밀번호 암호화 키 (Fernet, urlsafe base64 32B).
    # 비어 있으면 소스 등록 자체가 503 — 평문 저장으로 흘러가는 경로를 만들지 않는다.
    source_secret_key: str = ""
    # Tuning: 직결 소스 연결/문장 타임아웃(초). 한 소스가 멎어도 요청이 붙잡히지 않게 한다.
    source_connect_timeout: int = 5
    source_query_timeout: int = 15
```

- [ ] **Step 4: 의존성을 명시한다**

`backend/requirements.txt`의 `pyjwt[crypto]==2.13.0` 아래에 추가:

```
# 소스 접속 비밀번호 Fernet 암호화 — pyjwt[crypto]로 이미 설치되지만 직접 쓰므로 명시한다
cryptography==44.0.0
```

Run: `cd backend && pip install -r requirements.txt` (또는 `uv pip install -r requirements.txt`)

- [ ] **Step 5: 구현한다**

`backend/app/sources/__init__.py`:

```python
"""Direct-connect data source support. / 직결 소스 지원 (수집·미리보기·연결)."""
```

`backend/app/sources/crypto.py`:

```python
"""Source secret encryption. / 소스 접속 비밀번호 암·복호화.

키가 없으면 암호화를 건너뛰고 평문을 저장하는 대신 **거부한다** — 조용한 평문 저장이
가장 나쁜 실패 모드다. 키는 배포마다 다르고 .env에만 있다.
"""

from cryptography.fernet import Fernet, InvalidToken

from app.config import get_settings


class CryptoNotConfigured(RuntimeError):
    """SOURCE_SECRET_KEY 미설정 — 소스 접속정보를 저장·복호화할 수 없다."""


def is_crypto_configured() -> bool:
    return bool(get_settings().source_secret_key)


def _get_cipher() -> Fernet:
    key = get_settings().source_secret_key
    if not key:
        raise CryptoNotConfigured(
            "SOURCE_SECRET_KEY is not configured — set it in .env and restart the "
            "backend to register data sources "
            "(generate: python -c \"from cryptography.fernet import Fernet; "
            "print(Fernet.generate_key().decode())\")"
        )
    return Fernet(key.encode())


def encrypt_secret(plain: str) -> str:
    return _get_cipher().encrypt(plain.encode()).decode()


def decrypt_secret(token: str) -> str:
    """복호화 실패는 키 교체를 뜻한다 — 조용히 빈 값을 돌려주지 않는다."""
    try:
        return _get_cipher().decrypt(token.encode()).decode()
    except InvalidToken as e:
        raise CryptoNotConfigured(
            "stored source secret could not be decrypted — SOURCE_SECRET_KEY was "
            "probably rotated; re-enter the password for this source"
        ) from e
```

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run: `cd backend && python -m pytest tests/test_source_crypto.py -q`
Expected: PASS (2 passed)

- [ ] **Step 7: 커밋**

```bash
git add backend/app/sources backend/app/config.py backend/requirements.txt \
        backend/tests/test_source_crypto.py PROGRESS.md
git commit -m "feat(sources): Fernet-encrypted source secrets — 접속정보 암호화 (키 없으면 거부)"
```

---

### Task 5: 소스 레지스트리 + 연결 캐시

**Files:**
- Create: `backend/app/sources/registry.py`, `backend/app/sources/connection.py`
- Test: `backend/tests/test_source_registry.py`

**Interfaces:**
- Consumes: `DataSource` (Task 1), `decrypt_secret` (Task 4)
- Produces: `build_sa_url(source: DataSource) -> str`
- Produces: `get_source(db: Session, source_id: int | None) -> DataSource`
- Produces: `get_sa_engine(source: DataSource) -> Engine`
- Produces: `clear_sa_engine(source_id: int) -> None`
- Produces: `UnsupportedSource(RuntimeError)`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/tests/test_source_registry.py`:

```python
"""소스 → 접속 URL 조립. / building a connection URL from a source row."""

from datetime import UTC, datetime

import pytest
from cryptography.fernet import Fernet

from app.config import get_settings
from app.models import DataSource
from app.sources.crypto import encrypt_secret
from app.sources.registry import UnsupportedSource, build_sa_url


@pytest.fixture()
def configured_key(monkeypatch):
    monkeypatch.setenv("SOURCE_SECRET_KEY", Fernet.generate_key().decode())
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _source(**kw) -> DataSource:
    now = datetime.now(UTC)
    base = dict(name="s", access_mode="direct", is_enabled=True, is_managed=False,
                created_at=now, updated_at=now)
    return DataSource(**{**base, **kw})


def test_builds_postgres_url_with_decrypted_password(configured_key):
    # Arrange
    source = _source(engine="postgres", host="svca-db", port=5432,
                     database="app", username="viewer",
                     password_enc=encrypt_secret("p@ss/word"))

    # Act
    url = build_sa_url(source)

    # Assert: 특수문자가 URL 인코딩되어야 파싱이 깨지지 않는다
    assert url == "postgresql+psycopg://viewer:p%40ss%2Fword@svca-db:5432/app"


def test_builds_sqlite_readonly_uri():
    # Arrange
    source = _source(engine="sqlite", file_path="/mnt/sources/svcc/app.db")

    # Act
    url = build_sa_url(source)

    # Assert: 읽기전용으로만 연다 — 볼륨 :ro와 이중으로 막는다
    assert url == "sqlite:///file:/mnt/sources/svcc/app.db?mode=ro&uri=true"


def test_rejects_n8n_source():
    # Arrange: n8n 소스는 백엔드가 직접 붙지 않는다
    source = _source(engine="mssql", access_mode="n8n")

    # Act / Assert
    with pytest.raises(UnsupportedSource):
        build_sa_url(source)
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd backend && python -m pytest tests/test_source_registry.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.sources.registry'`

- [ ] **Step 3: 구현한다**

`backend/app/sources/registry.py`:

```python
"""Source lookup and connection-URL assembly. / 소스 조회·접속 URL 조립."""

from urllib.parse import quote

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import DataSource
from app.models.sources import MANAGED_MSSQL_SOURCE_ID
from app.sources.crypto import decrypt_secret


class UnsupportedSource(RuntimeError):
    """직결로 붙을 수 없는 소스 — n8n 경유이거나 알 수 없는 엔진."""


def get_source(db: Session, source_id: int | None) -> DataSource:
    """소스 1건 — 생략하면 기본 소스(사내 MSSQL) / one source, default when omitted."""
    target = source_id if source_id is not None else MANAGED_MSSQL_SOURCE_ID
    source = db.get(DataSource, target)
    if source is None:
        raise HTTPException(404, {"message": "data source not found",
                                  "context": {"source_id": target}})
    return source


def list_sources(db: Session) -> list[DataSource]:
    return list(db.execute(
        select(DataSource).order_by(DataSource.is_managed.desc(), DataSource.name)
    ).scalars())


def build_sa_url(source: DataSource) -> str:
    """직결 소스의 SQLAlchemy URL / SQLAlchemy URL for a direct source.

    비밀번호에 `@`나 `/`가 들어가면 URL 파싱이 깨진다 — 사용자·비밀번호는 항상 인코딩한다.
    sqlite는 `mode=ro` URI로 연다: 볼륨 `:ro` 마운트와 이중으로 쓰기를 막는다.
    """
    if source.access_mode != "direct":
        raise UnsupportedSource(
            f"source {source.name!r} is served through n8n, not a direct connection")
    if source.engine == "postgres":
        user = quote(source.username or "", safe="")
        password = quote(decrypt_secret(source.password_enc), safe="") \
            if source.password_enc else ""
        auth = f"{user}:{password}" if password else user
        return f"postgresql+psycopg://{auth}@{source.host}:{source.port}/{source.database}"
    if source.engine == "sqlite":
        return f"sqlite:///file:{source.file_path}?mode=ro&uri=true"
    raise UnsupportedSource(f"unsupported engine: {source.engine}")
```

`backend/app/sources/connection.py`:

```python
"""Per-source SQLAlchemy engines. / 소스별 엔진 캐시.

요청마다 새 연결을 여는 것보다 작은 풀을 유지하는 편이 싸다. 소스 설정이 바뀌면
캐시를 비워야 낡은 접속정보로 계속 붙지 않는다.
"""

from sqlalchemy import Engine, create_engine

from app.config import get_settings
from app.models import DataSource
from app.sources.registry import build_sa_url

_engines: dict[int, Engine] = {}


def get_sa_engine(source: DataSource) -> Engine:
    cached = _engines.get(source.id)
    if cached is not None:
        return cached
    settings = get_settings()
    kwargs: dict = {"pool_pre_ping": True}
    if source.engine == "postgres":
        # 한 소스가 멎어도 요청이 무한정 붙잡히지 않게 연결·문장 양쪽에 상한을 건다
        kwargs["pool_size"] = 2
        kwargs["max_overflow"] = 1
        kwargs["connect_args"] = {
            "connect_timeout": settings.source_connect_timeout,
            "options": f"-c statement_timeout={settings.source_query_timeout * 1000}",
        }
    else:
        kwargs["connect_args"] = {"timeout": settings.source_connect_timeout,
                                  "check_same_thread": False}
    engine = create_engine(build_sa_url(source), **kwargs)
    _engines[source.id] = engine
    return engine


def clear_sa_engine(source_id: int) -> None:
    """소스 수정·삭제 후 호출 — 낡은 접속정보로 붙는 걸 막는다."""
    engine = _engines.pop(source_id, None)
    if engine is not None:
        engine.dispose()
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd backend && python -m pytest tests/test_source_registry.py -q`
Expected: PASS (3 passed)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/sources/registry.py backend/app/sources/connection.py \
        backend/tests/test_source_registry.py PROGRESS.md
git commit -m "feat(sources): source registry and per-source engine cache — 소스 조회·엔진 캐시"
```

---

## Phase 2 — 직결 미리보기 (Task 6–7)

---

### Task 6: 미리보기 SQL 빌더 (순수 함수)

이 태스크가 보안 경계다. **식별자 화이트리스트와 바인드 파라미터가 여기서 지켜진다.**

PostgreSQL과 SQLite는 이 용도에서 문법이 같다 — 둘 다 `"` 인용, `LIMIT n`,
`CAST(x AS TEXT)`, `UPPER`, `LIKE ... ESCAPE`를 지원한다. SQLAlchemy `text()`의
named 파라미터(`:p0`)를 쓰면 paramstyle 차이도 사라진다. 그래서 빌더는 **하나**다.

**Files:**
- Create: `backend/app/sources/preview_sql.py`
- Test: `backend/tests/test_preview_sql.py`

**Interfaces:**
- Produces: `UnknownIdentifier(ValueError)`
- Produces: `build_preview_sql(schema: str, table: str, column_names: list[str],
  filters: list[dict], limit: int, allowed_columns: set[str]) -> tuple[str, dict[str, str]]`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/tests/test_preview_sql.py`:

```python
"""미리보기 SQL 빌더 — 파라미터화·식별자 화이트리스트·op 의미.
/ preview SQL builder: parameterisation, identifier allowlist, operator semantics."""

import pytest

from app.sources.preview_sql import UnknownIdentifier, build_preview_sql

COLUMNS = ["id", "status", "name"]
ALLOWED = {"id", "status", "name"}


def test_builds_unfiltered_select():
    # Act
    sql, params = build_preview_sql("public", "orders", COLUMNS, [], 20, ALLOWED)

    # Assert
    assert sql == 'SELECT "id", "status", "name" FROM "public"."orders" LIMIT 20'
    assert params == {}


def test_contains_is_case_insensitive_and_parameterised():
    # Act
    sql, params = build_preview_sql(
        "public", "orders", COLUMNS,
        [{"column": "status", "op": "contains", "value": "paid"}], 20, ALLOWED)

    # Assert: 값은 파라미터로만 나간다 — SQL 텍스트에 사용자 값이 없다
    assert "paid" not in sql
    assert 'UPPER(CAST("status" AS TEXT)) LIKE UPPER(:p0)' in sql
    assert params == {"p0": "%paid%"}


def test_negative_ops_include_nulls():
    # Arrange/Act: fixture 구현이 NULL을 빈 문자열로 취급해 매칭시킨다 — 그 의미에 맞춘다
    sql, _ = build_preview_sql(
        "public", "orders", COLUMNS,
        [{"column": "status", "op": "not_contains", "value": "paid"}], 20, ALLOWED)

    # Assert
    assert sql.count('"status" IS NULL OR NOT (') == 1


def test_null_ops_take_no_parameter():
    # Act
    sql, params = build_preview_sql(
        "public", "orders", COLUMNS,
        [{"column": "status", "op": "is_null", "value": None}], 20, ALLOWED)

    # Assert
    assert '"status" IS NULL' in sql
    assert params == {}


def test_like_metacharacters_are_escaped():
    # Act: 사용자가 넣은 %는 와일드카드가 아니라 리터럴이어야 한다
    _, params = build_preview_sql(
        "public", "orders", COLUMNS,
        [{"column": "name", "op": "contains", "value": "50%_off"}], 20, ALLOWED)

    # Assert
    assert params == {"p0": r"%50\%\_off%"}


def test_multiple_conditions_are_and_combined():
    # Act
    sql, params = build_preview_sql(
        "public", "orders", COLUMNS,
        [{"column": "status", "op": "eq", "value": "paid"},
         {"column": "name", "op": "not_null", "value": None}], 20, ALLOWED)

    # Assert
    assert " AND " in sql
    assert params == {"p0": "paid"}


@pytest.mark.parametrize("bad", ["password", 'id" FROM secrets --', "ID"])
def test_rejects_columns_outside_the_catalog(bad):
    # Act / Assert: 카탈로그에 없는 이름은 식별자 자리에 절대 못 들어간다
    with pytest.raises(UnknownIdentifier):
        build_preview_sql("public", "orders", COLUMNS,
                          [{"column": bad, "op": "eq", "value": "x"}], 20, ALLOWED)


def test_rejects_select_columns_outside_the_catalog():
    # Act / Assert
    with pytest.raises(UnknownIdentifier):
        build_preview_sql("public", "orders", ["id", "evil"], [], 20, ALLOWED)
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd backend && python -m pytest tests/test_preview_sql.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.sources.preview_sql'`

- [ ] **Step 3: 구현한다**

`backend/app/sources/preview_sql.py`:

```python
"""Preview SQL builder for direct sources. / 직결 소스 미리보기 SQL 빌더.

여기가 보안 경계다. **식별자는 카탈로그에 실재하는 이름만** 통과하고, 값은 전부 바인드
파라미터로 나간다. 사용자 입력이 식별자 자리에 들어가는 경로는 존재하지 않는다.

PostgreSQL과 SQLite는 이 용도에서 문법이 같다("인용, LIMIT, CAST AS TEXT, LIKE ESCAPE).
SQLAlchemy text()의 named 파라미터를 쓰면 paramstyle 차이도 없어 빌더가 하나로 족하다.
"""

# 대소문자 무시 비교 — MSSQL 기본 collation이 CI라 화면 의미를 그쪽에 맞춘다
_CI = 'UPPER(CAST({col} AS TEXT))'
_LIKE_ESCAPE = "\\"


class UnknownIdentifier(ValueError):
    """카탈로그에 없는 스키마·테이블·컬럼 — 질의를 만들지 않는다."""


def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def escape_like(value: str) -> str:
    """LIKE 메타문자를 리터럴로 — 사용자가 넣은 %는 와일드카드가 아니다."""
    return (value.replace(_LIKE_ESCAPE, _LIKE_ESCAPE * 2)
            .replace("%", _LIKE_ESCAPE + "%")
            .replace("_", _LIKE_ESCAPE + "_"))


def _build_condition(cond: dict, index: int) -> tuple[str, dict[str, str]]:
    col = quote_ident(cond["column"])
    op = cond.get("op", "contains")
    if op == "is_null":
        return f"{col} IS NULL", {}
    if op == "not_null":
        return f"{col} IS NOT NULL", {}

    key = f"p{index}"
    holder = f":{key}"
    ci = _CI.format(col=col)
    value = cond.get("value") or ""
    if op == "eq":
        return f"{ci} = UPPER({holder})", {key: value}
    if op == "neq":
        # 부정 연산은 NULL 행도 포함한다 — fixture 구현이 NULL을 빈 문자열로 본다
        return f"({col} IS NULL OR {ci} <> UPPER({holder}))", {key: value}
    like = f"{ci} LIKE UPPER({holder}) ESCAPE '{_LIKE_ESCAPE}'"
    needle = f"%{escape_like(value)}%"
    if op == "contains":
        return like, {key: needle}
    if op == "not_contains":
        return f"({col} IS NULL OR NOT ({like}))", {key: needle}
    raise UnknownIdentifier(f"unsupported filter op: {op}")


def build_preview_sql(
    schema: str, table: str, column_names: list[str], filters: list[dict],
    limit: int, allowed_columns: set[str],
) -> tuple[str, dict[str, str]]:
    """미리보기 SELECT 문과 바인드 파라미터 / the preview SELECT and its bound params."""
    for name in column_names:
        if name not in allowed_columns:
            raise UnknownIdentifier(f"column not in the catalog: {name}")

    select_list = ", ".join(quote_ident(name) for name in column_names)
    sql = f"SELECT {select_list} FROM {quote_ident(schema)}.{quote_ident(table)}"

    params: dict[str, str] = {}
    clauses: list[str] = []
    for index, cond in enumerate(filters):
        if cond["column"] not in allowed_columns:
            raise UnknownIdentifier(f"column not in the catalog: {cond['column']}")
        clause, bound = _build_condition(cond, index)
        clauses.append(clause)
        params.update(bound)
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    return f"{sql} LIMIT {int(limit)}", params
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd backend && python -m pytest tests/test_preview_sql.py -q`
Expected: PASS (10 passed — parametrize 3건 포함)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/sources/preview_sql.py backend/tests/test_preview_sql.py PROGRESS.md
git commit -m "feat(sources): parameterised preview SQL builder — 미리보기 SQL 빌더 (식별자 화이트리스트)"
```

---

### Task 7: `DirectTablePreview` + 팩토리 라우팅

**Files:**
- Create: `backend/app/sources/direct_preview.py`
- Modify: `backend/app/adapters/__init__.py`, `backend/app/api/objects.py`
- Test: `backend/tests/test_direct_preview.py`

**Interfaces:**
- Consumes: `build_preview_sql` (Task 6), `get_sa_engine` (Task 5)
- Produces: `class DirectTablePreview` — `rows(qname: str, columns: list[dict],
  limit: int, filters: list[dict] | None = None) -> list[dict]`
  (기존 `N8nTablePreview.rows`와 **동일한 시그니처**)
- Produces: `create_table_preview(settings: Settings, source: DataSource)` — 소스 라우팅

- [ ] **Step 1: 실패하는 테스트를 쓴다**

실제 SQLite 파일을 만들어 왕복한다 — 추가 인프라가 필요 없다.

`backend/tests/test_direct_preview.py`:

```python
"""직결 미리보기 실행 — 실제 SQLite 파일로 왕복. / direct preview against a real SQLite file."""

import sqlite3
from datetime import UTC, datetime

import pytest
from sqlalchemy import create_engine

from app.models import DataSource
from app.sources.direct_preview import DirectTablePreview

COLUMNS = [{"name": "id", "data_type": "INTEGER"},
           {"name": "status", "data_type": "TEXT"}]


@pytest.fixture()
def sqlite_source(tmp_path):
    # Arrange: 실 데이터가 든 SQLite 파일
    path = tmp_path / "app.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT)")
    conn.executemany("INSERT INTO orders VALUES (?, ?)",
                     [(1, "PAID"), (2, "pending"), (3, None)])
    conn.commit()
    conn.close()
    now = datetime.now(UTC)
    source = DataSource(id=99, name="t", engine="sqlite", access_mode="direct",
                        file_path=str(path), is_enabled=True, is_managed=False,
                        created_at=now, updated_at=now)
    return source, create_engine(f"sqlite:///file:{path}?mode=ro&uri=true")


def test_returns_rows_without_filters(sqlite_source):
    # Arrange
    _, engine = sqlite_source
    preview = DirectTablePreview(engine)

    # Act
    rows = preview.rows("main.orders", COLUMNS, 20)

    # Assert
    assert [r["id"] for r in rows] == [1, 2, 3]


def test_filter_is_case_insensitive(sqlite_source):
    # Arrange
    _, engine = sqlite_source
    preview = DirectTablePreview(engine)

    # Act: 저장된 값은 'PAID', 입력은 소문자
    rows = preview.rows("main.orders", COLUMNS, 20,
                        filters=[{"column": "status", "op": "eq", "value": "paid"}])

    # Assert
    assert [r["id"] for r in rows] == [1]


def test_not_contains_includes_null_rows(sqlite_source):
    # Arrange
    _, engine = sqlite_source
    preview = DirectTablePreview(engine)

    # Act
    rows = preview.rows("main.orders", COLUMNS, 20,
                        filters=[{"column": "status", "op": "not_contains",
                                  "value": "paid"}])

    # Assert: NULL 행(3)이 빠지지 않는다 — fixture 의미와 동등
    assert [r["id"] for r in rows] == [2, 3]


def test_limit_is_applied(sqlite_source):
    # Arrange
    _, engine = sqlite_source
    preview = DirectTablePreview(engine)

    # Act
    rows = preview.rows("main.orders", COLUMNS, 2)

    # Assert
    assert len(rows) == 2
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd backend && python -m pytest tests/test_direct_preview.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.sources.direct_preview'`

- [ ] **Step 3: 구현한다**

`backend/app/sources/direct_preview.py`:

```python
"""Direct-connect table preview. / 직결 소스 테이블 미리보기 실행기.

N8nTablePreview와 같은 시그니처를 갖는다 — 호출부(api/objects.py)가 어느 쪽인지 몰라도 된다.
"""

import base64
import logging
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Engine, text

from app.sources.preview_sql import build_preview_sql

logger = logging.getLogger(__name__)


def _to_jsonable(value: object) -> object:
    """JSON으로 못 나가는 DB 타입을 문자열화 — 미리보기는 눈으로 보는 용도다."""
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, bytes | bytearray | memoryview):
        return base64.b64encode(bytes(value)).decode()
    return value


class DirectTablePreview:
    """소스 엔진에 SELECT 하나를 날린다 — 읽기 전용, 캐시 없음."""

    def __init__(self, sa_engine: Engine) -> None:
        self._engine = sa_engine

    def rows(
        self, qname: str, columns: list[dict], limit: int,
        filters: list[dict] | None = None,
    ) -> list[dict]:
        schema, table = qname.split(".", 1)
        names = [column["name"] for column in columns]
        sql, params = build_preview_sql(
            schema, table, names, filters or [], limit, set(names),
        )
        with self._engine.connect() as conn:
            result = conn.execute(text(sql), params)
            rows = [
                {key: _to_jsonable(value) for key, value in row._mapping.items()}
                for row in result
            ]
        logger.info("direct preview executed",
                    extra={"object": qname, "rows": len(rows),
                           "filters": len(filters or [])})
        return rows
```

- [ ] **Step 4: 팩토리를 소스 라우팅으로 바꾼다**

`backend/app/adapters/__init__.py`의 `create_table_preview`를 교체한다:

```python
def create_table_preview(settings: Settings, source: "DataSource | None" = None):
    """미리보기 실행기 — 소스가 정한다 / preview executor, chosen by the source.

    direct 소스는 SOURCE_MODE와 무관하게 항상 실데이터다. n8n 소스만 기존 게이트를
    그대로 통과한다 (live 전환은 배포 절차가 지킨다, docs/connect.md).
    """
    if source is not None and source.access_mode == "direct":
        from app.sources.connection import get_sa_engine
        from app.sources.direct_preview import DirectTablePreview

        return DirectTablePreview(get_sa_engine(source))
    if settings.source_mode == "live":
        ...  # 이하 기존 본문 그대로
```

`TYPE_CHECKING` 블록에 `from app.models import DataSource`를 추가한다.

- [ ] **Step 5: 미리보기 엔드포인트를 소스 인지로 바꾼다**

`backend/app/api/objects.py`의 `get_object_preview`에서:

```python
    snapshot = db.get(Snapshot, obj.snapshot_id)
    source = get_source(db, snapshot.data_source_id if snapshot else None)
    ...
    if not is_preview_allowed(db, source.id, obj.schema):
        ...
    try:
        preview = create_table_preview(settings, source)
    except SyntheticDataRefused as e:
        ...
```

응답의 `"source"` 필드도 소스를 반영한다 — 0행일 때 "원본이 비었다"와 "실행기가 안
붙었다"를 화면이 구분하는 값이다:

```python
        "source": ("live" if source.access_mode == "direct"
                   or settings.source_mode == "live" else "fixture"),
        "source_id": source.id,
        "source_name": source.name,
```

import 추가: `from app.sources.registry import get_source`

- [ ] **Step 6: 소스 실패를 그 소스에만 가둔다 (설계 §9)**

직결 실행이 터지면 지금은 500이 난다 — 원인이 어디인지 화면에서 알 수 없다. `preview.rows`
호출을 감싼다:

```python
    try:
        rows = preview.rows(qname, column_specs, limit,
                            filters=[c.model_dump() for c in conds])
    except SQLAlchemyError as e:
        # 자격증명은 절대 싣지 않는다 — 어느 소스가 왜 실패했는지까지만
        logger.warning("source preview failed",
                       extra={"source_id": source.id, "object": qname})
        raise HTTPException(502, {
            "message": "the data source could not be queried",
            "context": {"source": source.name, "object": qname,
                        "error": str(e)[:300]},
        }) from e
```

import 추가: `from sqlalchemy.exc import SQLAlchemyError`, `import logging` +
`logger = logging.getLogger(__name__)` (모듈 상단, 없으면 추가)

테스트를 하나 더한다 — `backend/tests/test_direct_preview.py`:

```python
def test_broken_source_returns_502_not_500(client, migrated_engine, tmp_path):
    # Arrange: 파일이 없는 sqlite 소스 + 그 소스의 스냅샷/객체/allowlist
    #   (seed 헬퍼는 tests/test_source_scoped_queries.py의 _seed 관용을 따른다)
    ...  # 소스·스냅샷·객체·allowlist를 만든 뒤 object_id를 얻는다

    # Act
    res = client.get(f"/api/objects/{object_id}/preview")

    # Assert: 다른 소스는 멀쩡하다 — 실패가 앱 전체로 번지지 않는다
    assert res.status_code == 502
    assert "could not be queried" in res.json()["detail"]["message"]
```

- [ ] **Step 7: 테스트가 통과하는지 확인한다**

Run: `cd backend && python -m pytest -q`
Expected: 354 passed, 1 skipped

- [ ] **Step 8: 커밋**

```bash
git add backend/app/sources/direct_preview.py backend/app/adapters/__init__.py \
        backend/app/api/objects.py backend/tests/test_direct_preview.py PROGRESS.md
git commit -m "feat(sources): direct table preview for postgres and sqlite — 직결 미리보기"
```

---

## Phase 3 — 수집 (Task 8–10)

---

### Task 8: PostgreSQL 수집기

**Files:**
- Create: `backend/app/sources/pg_collector.py`
- Test: `backend/tests/test_pg_collector.py`

**Interfaces:**
- Produces: `collect_postgres(sa_engine: Engine, source_db: str) -> CatalogPayload`

`object_id`는 `pg_class.oid`가 아니라 **스냅샷 내 일련번호**다 — oid는 unsigned 32bit라
`objects.object_id`(int4)를 넘길 수 있다. 수집 중에만 `oid → 일련번호` 사전을 든다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

로컬 PostgreSQL이 있을 때만 도는 통합 테스트 + 항상 도는 매핑 단위 테스트로 나눈다.

`backend/tests/test_pg_collector.py`:

```python
"""PostgreSQL 수집기 — oid 매핑과 실 DB 왕복.
/ Postgres collector: oid mapping and a live round-trip."""

import os

import pytest
from sqlalchemy import create_engine, text

from app.sources.pg_collector import collect_postgres, map_oids_to_object_ids

PG_URL = os.environ.get("TEST_POSTGRES_URL")
requires_pg = pytest.mark.skipif(not PG_URL, reason="TEST_POSTGRES_URL is not set")


def test_maps_oids_to_sequential_object_ids():
    # Arrange: oid는 int4를 넘길 수 있어 그대로 쓰지 않는다
    oids = [4294967290, 17, 999]

    # Act
    mapping = map_oids_to_object_ids(oids)

    # Assert: 1부터의 일련번호, 입력 순서 유지
    assert mapping == {4294967290: 1, 17: 2, 999: 3}


@requires_pg
def test_collects_tables_columns_and_fks():
    # Arrange
    engine = create_engine(PG_URL)
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA IF EXISTS collect_probe CASCADE"))
        conn.execute(text("CREATE SCHEMA collect_probe"))
        conn.execute(text("CREATE TABLE collect_probe.parent "
                          "(id integer PRIMARY KEY, label varchar(50))"))
        conn.execute(text("CREATE TABLE collect_probe.child "
                          "(id integer PRIMARY KEY, "
                          " parent_id integer REFERENCES collect_probe.parent(id))"))
        conn.execute(text("CREATE VIEW collect_probe.v_child AS "
                          "SELECT id FROM collect_probe.child"))

    # Act
    payload = collect_postgres(engine, "probe")

    # Assert
    names = {(o.schema_name, o.name, o.type) for o in payload.objects
             if o.schema_name == "collect_probe"}
    assert names == {("collect_probe", "parent", "table"),
                     ("collect_probe", "child", "table"),
                     ("collect_probe", "v_child", "view")}

    label = next(c for c in payload.columns
                 if c.name == "label" and c.object_id in
                 {o.object_id for o in payload.objects if o.name == "parent"})
    assert label.data_type == "character varying(50)"
    assert label.max_length == 50
    assert label.is_nullable is True

    fk = next(f for f in payload.foreign_keys)
    assert [(p.src_column, p.tgt_column) for p in fk.columns] == [("parent_id", "id")]

    view = next(o for o in payload.objects if o.name == "v_child")
    definition = next(d for d in payload.view_definitions
                      if d.object_id == view.object_id)
    assert "child" in (definition.definition or "")

    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA collect_probe CASCADE"))
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd backend && python -m pytest tests/test_pg_collector.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.sources.pg_collector'`

- [ ] **Step 3: 구현한다**

`backend/app/sources/pg_collector.py`:

```python
"""PostgreSQL catalog collector. / PostgreSQL 카탈로그 수집기.

기존 ingest 계약(CatalogPayload)을 그대로 채운다 — 하류(검색·ERD·정책)가 엔진을 모른다.
시스템 스키마는 제외한다: 사용자가 볼 대상이 아니고 수천 개 객체로 목록을 오염시킨다.
"""

from datetime import UTC, datetime

from sqlalchemy import Engine, text

from app.schemas.ingest import (
    CatalogPayload,
    RawColumn,
    RawForeignKey,
    RawFkPair,
    RawKeyConstraint,
    RawObject,
    RawViewDefinition,
)

_SCHEMA_FILTER = (
    "n.nspname NOT IN ('pg_catalog', 'information_schema') "
    "AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'"
)

_OBJECTS_SQL = f"""
SELECT c.oid AS oid, n.nspname AS schema_name, c.relname AS name,
       CASE WHEN c.relkind IN ('v', 'm') THEN 'view' ELSE 'table' END AS type,
       CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS row_count,
       CASE WHEN c.relkind IN ('v', 'm')
            THEN pg_get_viewdef(c.oid, true) END AS definition
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm') AND {_SCHEMA_FILTER}
ORDER BY n.nspname, c.relname
"""

# max_length는 varchar/char의 선언 길이만 의미가 있다 — 나머지는 MSSQL 관례대로 -1
_COLUMNS_SQL = f"""
SELECT a.attrelid AS oid, a.attname AS name, a.attnum AS ordinal,
       format_type(a.atttypid, a.atttypmod) AS data_type,
       CASE WHEN t.typname IN ('varchar', 'bpchar') AND a.atttypmod > 4
            THEN a.atttypmod - 4 ELSE -1 END AS max_length,
       NOT a.attnotnull AS is_nullable,
       a.attgenerated <> '' AS is_computed
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_type t ON t.oid = a.atttypid
WHERE a.attnum > 0 AND NOT a.attisdropped
  AND c.relkind IN ('r', 'p', 'v', 'm') AND {_SCHEMA_FILTER}
ORDER BY a.attrelid, a.attnum
"""

# conkey 순서가 곧 컬럼 순서다 — WITH ORDINALITY 없이는 복합키 순서가 뒤집힌다
_KEYS_SQL = f"""
SELECT c.conname AS name,
       CASE c.contype WHEN 'p' THEN 'pk' ELSE 'uq' END AS type,
       c.conrelid AS oid,
       ARRAY(SELECT a.attname
             FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
             ORDER BY u.ord) AS columns
FROM pg_constraint c
JOIN pg_class r ON r.oid = c.conrelid
JOIN pg_namespace n ON n.oid = r.relnamespace
WHERE c.contype IN ('p', 'u') AND {_SCHEMA_FILTER}
"""

_FKS_SQL = f"""
SELECT c.conname AS name, c.conrelid AS src_oid, c.confrelid AS tgt_oid,
       ARRAY(SELECT a.attname
             FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
             ORDER BY u.ord) AS src_columns,
       ARRAY(SELECT a.attname
             FROM unnest(c.confkey) WITH ORDINALITY AS u(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = u.attnum
             ORDER BY u.ord) AS tgt_columns
FROM pg_constraint c
JOIN pg_class r ON r.oid = c.conrelid
JOIN pg_namespace n ON n.oid = r.relnamespace
WHERE c.contype = 'f' AND {_SCHEMA_FILTER}
"""


def map_oids_to_object_ids(oids: list[int]) -> dict[int, int]:
    """oid → 스냅샷 내 일련번호 / oid to a per-snapshot sequential id.

    pg_class.oid는 unsigned 32bit(max 4,294,967,295)라 objects.object_id(int4)를 넘길 수
    있다. 계약이 요구하는 건 스냅샷 안에서의 유일성뿐이므로 일련번호로 충분하다.
    """
    return {oid: index for index, oid in enumerate(oids, start=1)}


def collect_postgres(sa_engine: Engine, source_db: str) -> CatalogPayload:
    """한 PostgreSQL DB의 카탈로그를 ingest 페이로드로 / one PG database as an ingest payload."""
    with sa_engine.connect() as conn:
        object_rows = conn.execute(text(_OBJECTS_SQL)).mappings().all()
        oid_map = map_oids_to_object_ids([row["oid"] for row in object_rows])

        objects = [
            RawObject(object_id=oid_map[row["oid"]], schema=row["schema_name"],
                      name=row["name"], type=row["type"], row_count=row["row_count"])
            for row in object_rows
        ]
        view_definitions = [
            RawViewDefinition(object_id=oid_map[row["oid"]], definition=row["definition"])
            for row in object_rows if row["type"] == "view"
        ]
        columns = [
            RawColumn(object_id=oid_map[row["oid"]], name=row["name"],
                      ordinal=row["ordinal"], data_type=row["data_type"],
                      max_length=row["max_length"], is_nullable=row["is_nullable"],
                      is_computed=row["is_computed"])
            for row in conn.execute(text(_COLUMNS_SQL)).mappings()
            if row["oid"] in oid_map
        ]
        key_constraints = [
            RawKeyConstraint(name=row["name"], type=row["type"],
                             object_id=oid_map[row["oid"]], columns=list(row["columns"]))
            for row in conn.execute(text(_KEYS_SQL)).mappings()
            if row["oid"] in oid_map
        ]
        foreign_keys = [
            RawForeignKey(
                name=row["name"], src_object_id=oid_map[row["src_oid"]],
                tgt_object_id=oid_map[row["tgt_oid"]],
                columns=[RawFkPair(src_column=src, tgt_column=tgt)
                         for src, tgt in zip(row["src_columns"], row["tgt_columns"],
                                             strict=True)],
            )
            # 제외된 스키마를 가리키는 FK는 버린다 — 없는 객체를 참조하면 적재가 터진다
            for row in conn.execute(text(_FKS_SQL)).mappings()
            if row["src_oid"] in oid_map and row["tgt_oid"] in oid_map
        ]

    return CatalogPayload(
        source_db=source_db, collected_at=datetime.now(UTC), objects=objects,
        columns=columns, key_constraints=key_constraints, foreign_keys=foreign_keys,
        view_definitions=view_definitions,
    )
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd backend && python -m pytest tests/test_pg_collector.py -q`
Expected: 1 passed, 1 skipped (PG 미설정 시)

로컬 PostgreSQL이 있으면 통합 테스트까지 돌린다:
```bash
cd backend && TEST_POSTGRES_URL=postgresql+psycopg://dbviewer:<pw>@localhost:5432/dbviewer \
  python -m pytest tests/test_pg_collector.py -q
```
Expected: 2 passed

- [ ] **Step 5: 커밋**

```bash
git add backend/app/sources/pg_collector.py backend/tests/test_pg_collector.py PROGRESS.md
git commit -m "feat(sources): postgres catalog collector — PG 수집기 (oid는 일련번호로 사상)"
```

---

### Task 9: SQLite 수집기

**Files:**
- Create: `backend/app/sources/sqlite_collector.py`
- Test: `backend/tests/test_sqlite_collector.py`

**Interfaces:**
- Produces: `collect_sqlite(sa_engine: Engine, source_db: str) -> CatalogPayload`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/tests/test_sqlite_collector.py`:

```python
"""SQLite 수집기 — 실제 파일로 왕복. / SQLite collector against a real file."""

import sqlite3

import pytest
from sqlalchemy import create_engine

from app.sources.sqlite_collector import collect_sqlite


@pytest.fixture()
def sample_db(tmp_path):
    # Arrange
    path = tmp_path / "app.db"
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE parent (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
        CREATE TABLE child (
            id INTEGER PRIMARY KEY,
            parent_id INTEGER REFERENCES parent(id)
        );
        CREATE VIEW v_child AS SELECT id FROM child;
        INSERT INTO parent VALUES (1, 'a'), (2, 'b');
    """)
    conn.commit()
    conn.close()
    return create_engine(f"sqlite:///file:{path}?mode=ro&uri=true")


def test_collects_objects_with_main_schema(sample_db):
    # Act
    payload = collect_sqlite(sample_db, "svcc")

    # Assert: SQLite에는 스키마가 없다 — 'main'으로 고정한다
    assert {(o.schema_name, o.name, o.type) for o in payload.objects} == {
        ("main", "parent", "table"), ("main", "child", "table"),
        ("main", "v_child", "view"),
    }
    parent = next(o for o in payload.objects if o.name == "parent")
    assert parent.row_count == 2


def test_collects_columns_and_primary_key(sample_db):
    # Act
    payload = collect_sqlite(sample_db, "svcc")
    parent_id = next(o.object_id for o in payload.objects if o.name == "parent")

    # Assert
    label = next(c for c in payload.columns
                 if c.object_id == parent_id and c.name == "label")
    assert label.data_type == "TEXT"
    assert label.is_nullable is False
    assert label.max_length == -1

    pk = next(k for k in payload.key_constraints if k.object_id == parent_id)
    assert pk.type == "pk"
    assert pk.columns == ["id"]


def test_resolves_implicit_fk_target_to_primary_key(sample_db):
    # Act: `REFERENCES parent(id)`가 아니라 컬럼이 생략된 경우도 PK로 해석돼야 한다
    payload = collect_sqlite(sample_db, "svcc")

    # Assert
    fk = next(iter(payload.foreign_keys))
    assert [(p.src_column, p.tgt_column) for p in fk.columns] == [("parent_id", "id")]
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd backend && python -m pytest tests/test_sqlite_collector.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.sources.sqlite_collector'`

- [ ] **Step 3: 구현한다**

`backend/app/sources/sqlite_collector.py`:

```python
"""SQLite catalog collector. / SQLite 카탈로그 수집기.

SQLite에는 스키마도 object_id도 없다 — 스키마는 'main' 고정, object_id는 스냅샷 내
일련번호로 만든다(계약은 스냅샷 안에서의 유일성만 요구한다).
PRAGMA는 바인드 파라미터를 못 받는다 — 이름은 sqlite_master에서 읽은 값이지만
그래도 식별자 인용으로 감싸 넣는다.
"""

from datetime import UTC, datetime

from sqlalchemy import Engine, text

from app.schemas.ingest import (
    CatalogPayload,
    RawColumn,
    RawForeignKey,
    RawFkPair,
    RawKeyConstraint,
    RawObject,
    RawViewDefinition,
)
from app.sources.preview_sql import quote_ident

SQLITE_SCHEMA = "main"

_OBJECTS_SQL = (
    "SELECT type, name, sql FROM sqlite_master "
    "WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' "
    "ORDER BY type, name"
)


def collect_sqlite(sa_engine: Engine, source_db: str) -> CatalogPayload:
    """한 SQLite 파일의 카탈로그를 ingest 페이로드로 / one SQLite file as an ingest payload."""
    objects: list[RawObject] = []
    columns: list[RawColumn] = []
    key_constraints: list[RawKeyConstraint] = []
    view_definitions: list[RawViewDefinition] = []
    pk_by_table: dict[str, list[str]] = {}
    id_by_table: dict[str, int] = {}
    fk_rows: list[tuple[str, list[tuple[str, str | None]]]] = []

    with sa_engine.connect() as conn:
        entries = conn.execute(text(_OBJECTS_SQL)).mappings().all()

        for index, entry in enumerate(entries, start=1):
            name = entry["name"]
            is_view = entry["type"] == "view"
            id_by_table[name] = index

            row_count = None if is_view else conn.execute(
                text(f"SELECT COUNT(*) FROM {quote_ident(name)}")).scalar_one()
            objects.append(RawObject(object_id=index, schema=SQLITE_SCHEMA, name=name,
                                     type="view" if is_view else "table",
                                     row_count=row_count))
            if is_view:
                view_definitions.append(
                    RawViewDefinition(object_id=index, definition=entry["sql"]))

            info = conn.execute(
                text(f"PRAGMA table_info({quote_ident(name)})")).mappings().all()
            pk_columns = [c["name"] for c in sorted(
                (c for c in info if c["pk"]), key=lambda c: c["pk"])]
            if pk_columns:
                pk_by_table[name] = pk_columns
                key_constraints.append(RawKeyConstraint(
                    name=f"pk_{name}", type="pk", object_id=index, columns=pk_columns))
            for column in info:
                columns.append(RawColumn(
                    object_id=index, name=column["name"], ordinal=column["cid"],
                    # 선언 타입이 비면 SQLite의 동적 타입 — BLOB으로 표기한다
                    data_type=column["type"] or "BLOB",
                    # SQLite는 길이 제약을 저장하지 않는다 (MSSQL의 MAX와 같은 -1)
                    max_length=-1,
                    is_nullable=not column["notnull"], is_computed=False,
                ))

            if not is_view:
                # PRAGMA는 복합 FK를 id로 묶고 seq로 컬럼 순서를 준다 — 둘 다 지켜야
                # 복합키 페어가 뒤집히지 않는다
                grouped: dict[int, list] = {}
                for fk in conn.execute(
                        text(f"PRAGMA foreign_key_list({quote_ident(name)})")).mappings():
                    grouped.setdefault(fk["id"], []).append(dict(fk))
                for fk_id, group in grouped.items():
                    target = group[0]["table"]
                    fk_rows.append((f"{name}_{target}_{fk_id}", [
                        (name, target, item["from"], item["to"])
                        for item in sorted(group, key=lambda item: item["seq"])
                    ]))

    foreign_keys: list[RawForeignKey] = []
    for fk_name, items in fk_rows:
        src_table = items[0][0]
        tgt_table = items[0][1]
        if tgt_table not in id_by_table:
            continue  # 존재하지 않는 테이블을 가리키는 FK는 버린다
        target_pk = pk_by_table.get(tgt_table, [])
        pairs = []
        for position, (_, _, src_column, tgt_column) in enumerate(items):
            # `to`가 NULL이면 대상의 PK를 같은 자리로 해석한다 (SQLite 암묵 참조)
            resolved = tgt_column or (target_pk[position]
                                      if position < len(target_pk) else None)
            if resolved is None:
                pairs = []
                break
            pairs.append(RawFkPair(src_column=src_column, tgt_column=resolved))
        if pairs:
            foreign_keys.append(RawForeignKey(
                name=fk_name, src_object_id=id_by_table[src_table],
                tgt_object_id=id_by_table[tgt_table], columns=pairs))

    return CatalogPayload(
        source_db=source_db, collected_at=datetime.now(UTC), objects=objects,
        columns=columns, key_constraints=key_constraints, foreign_keys=foreign_keys,
        view_definitions=view_definitions,
    )
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd backend && python -m pytest tests/test_sqlite_collector.py -q && ruff check app`
Expected: 3 passed / ruff 클린

- [ ] **Step 5: 커밋**

```bash
git add backend/app/sources/sqlite_collector.py backend/tests/test_sqlite_collector.py \
        PROGRESS.md
git commit -m "feat(sources): sqlite catalog collector — SQLite 수집기 (암묵 FK는 PK로 해석)"
```

---

### Task 10: `DirectCollectRunner` + Phase 2 게이트

**Files:**
- Create: `backend/app/sources/direct_runner.py`
- Modify: `backend/app/adapters/__init__.py`, `backend/app/api/collect.py`,
  `backend/app/api/ingest.py`
- Test: `backend/tests/test_direct_collect.py`

**Interfaces:**
- Consumes: `collect_postgres` (Task 8), `collect_sqlite` (Task 9)
- Produces: `class DirectCollectRunner` — `run_catalog(job_id: int) -> None`,
  `run_view_deps(job_id: int, snapshot_id: int) -> None` (`CollectRunner` 프로토콜 준수)
- Produces: `create_collect_runner(settings, session_factory, source)` — 소스 라우팅

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/tests/test_direct_collect.py`:

```python
"""직결 수집 왕복 — SQLite 파일 → 스냅샷. / direct collection: file to snapshot."""

import sqlite3
from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.models import CatalogObject, CollectJob, DataSource, Snapshot
from app.sources.direct_runner import DirectCollectRunner


@pytest.fixture()
def sqlite_source_row(tmp_path, migrated_engine):
    # Arrange: 실 SQLite 파일 + 등록된 소스 행
    path = tmp_path / "app.db"
    conn = sqlite3.connect(path)
    conn.executescript(
        "CREATE TABLE parent (id INTEGER PRIMARY KEY);"
        "CREATE TABLE child (id INTEGER PRIMARY KEY,"
        " parent_id INTEGER REFERENCES parent(id));"
    )
    conn.commit()
    conn.close()
    now = datetime.now(UTC)
    factory = sessionmaker(bind=migrated_engine)
    with factory() as db:
        source = DataSource(name="svcc", engine="sqlite", access_mode="direct",
                            file_path=str(path), is_enabled=True, is_managed=False,
                            created_at=now, updated_at=now)
        db.add(source)
        job = CollectJob(mode="step", stage="catalog_running", triggered_by="test",
                         created_at=now, updated_at=now)
        db.add(job)
        db.commit()
        return factory, source.id, job.id


def test_direct_collection_creates_a_ready_snapshot(sqlite_source_row):
    # Arrange
    factory, source_id, job_id = sqlite_source_row
    with factory() as db:
        source = db.get(DataSource, source_id)
        runner = DirectCollectRunner(source, factory)

    # Act
    runner.run_catalog(job_id)

    # Assert: 스냅샷이 그 소스에 매달리고 객체가 적재된다
    with factory() as db:
        snapshot = db.execute(
            select(Snapshot).where(Snapshot.data_source_id == source_id)
        ).scalar_one()
        names = set(db.execute(
            select(CatalogObject.name)
            .where(CatalogObject.snapshot_id == snapshot.id)).scalars())
    assert names == {"parent", "child"}


def test_view_deps_step_is_a_noop_for_direct_sources(sqlite_source_row):
    # Arrange: 비-MSSQL은 lineage를 만들지 않는다 (T-SQL 파서 대상이 아니다)
    factory, source_id, job_id = sqlite_source_row
    with factory() as db:
        runner = DirectCollectRunner(db.get(DataSource, source_id), factory)
    runner.run_catalog(job_id)

    with factory() as db:
        snapshot_id = db.execute(
            select(Snapshot.id).where(Snapshot.data_source_id == source_id)
        ).scalar_one()

    # Act
    runner.run_view_deps(job_id, snapshot_id)

    # Assert: 잡이 완료로 넘어가고 스냅샷이 조회 가능해진다
    with factory() as db:
        assert db.get(CollectJob, job_id).stage == "done"
        assert db.get(Snapshot, snapshot_id).status == "ready"
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd backend && python -m pytest tests/test_direct_collect.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.sources.direct_runner'`

- [ ] **Step 3: 구현한다**

`backend/app/sources/direct_runner.py`:

```python
"""Direct-connect collection runner. / 직결 소스 수집 러너.

FixtureCollectRunner와 같은 관용을 따른다 — 수집 결과를 ingest와 **같은 코드 경로**로
적재해 매핑·검증 로직이 갈라지지 않게 한다.
"""

from sqlalchemy.orm import sessionmaker

from app.models import DataSource, Snapshot
from app.sources.connection import get_sa_engine
from app.sources.registry import UnsupportedSource


class DirectCollectRunner:
    """소스에 직접 붙어 카탈로그를 읽고 ingest 경로로 적재한다."""

    def __init__(self, source: DataSource, session_factory: sessionmaker) -> None:
        self._source = source
        self._session_factory = session_factory

    def run_catalog(self, job_id: int) -> None:
        from app.api.ingest import ingest_catalog  # 순환 import 회피
        from app.sources.pg_collector import collect_postgres
        from app.sources.sqlite_collector import collect_sqlite

        engine = get_sa_engine(self._source)
        if self._source.engine == "postgres":
            payload = collect_postgres(engine, self._source.name)
        elif self._source.engine == "sqlite":
            payload = collect_sqlite(engine, self._source.name)
        else:
            raise UnsupportedSource(
                f"no direct collector for engine {self._source.engine!r}")

        payload.collect_job_id = job_id
        payload.data_source_id = self._source.id
        with self._session_factory() as db:
            ingest_catalog(payload, db)
            db.commit()

    def run_view_deps(self, job_id: int, snapshot_id: int) -> None:
        """비-MSSQL 소스에는 lineage 단계가 없다 — 스냅샷을 바로 조회 가능으로 넘긴다.

        뷰 의존성 역추적은 T-SQL 파서 기반이라 PG/SQLite DDL에 적용할 수 없다
        (설계 §2.3). 단계를 건너뛰되 잡·스냅샷 상태는 정상 종료로 맞춘다.
        """
        from app.api.ingest import update_collect_job

        with self._session_factory() as db:
            snapshot = db.get(Snapshot, snapshot_id)
            if snapshot is not None:
                snapshot.status = "ready"
            update_collect_job(db, job_id, "done", snapshot_id=snapshot_id)
            db.commit()
```

- [ ] **Step 4: Phase 2를 MSSQL로 게이트한다**

`backend/app/api/ingest.py`의 `ingest_view_deps`에서 `run_phase2` 호출 직전에:

```python
    # 뷰 파싱은 T-SQL 파서 기반이라 MSSQL 소스에서만 의미가 있다 (설계 §2.3)
    source = db.get(DataSource, snapshot.data_source_id)
    if source is not None and source.engine == "mssql":
        run_phase2(db, snapshot.id)
```

import 추가: `DataSource`를 `app.models` import 목록에.

- [ ] **Step 5: 수집 팩토리를 소스 라우팅으로 바꾼다**

`backend/app/adapters/__init__.py`:

```python
def create_collect_runner(
    settings: Settings, session_factory, source: "DataSource | None" = None,
) -> "CollectRunner":
    """수집 러너 — direct 소스는 백엔드 직결, 그 외는 기존 n8n/픽스처 경로."""
    if source is not None and source.access_mode == "direct":
        from app.sources.direct_runner import DirectCollectRunner

        return DirectCollectRunner(source, session_factory)
    ...  # 이하 기존 본문 그대로
```

`backend/app/api/collect.py`의 `get_collect_runner` 의존성을 소스 인지로 바꾼다:

```python
def get_collect_runner_for(source_id: int | None, db: Session) -> CollectRunner:
    """요청된 소스의 러너 — 테스트는 get_collect_runner를 오버라이드한다."""
    from app.sources.registry import get_source

    return create_collect_runner(get_settings(), get_session_factory(),
                                 get_source(db, source_id))
```

`TriggerRequest` / `StepRequest`에 `source_id: int | None = None`을 추가하고,
`trigger_catalog_step` / `trigger_view_deps_step` / full 트리거가 이를 넘기게 한다.
**기존 `get_collect_runner` 의존성은 남겨둔다** — 테스트가 오버라이드 지점으로 쓴다.

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run: `cd backend && python -m pytest -q && ruff check app tests`
Expected: 358 passed, 1 skipped / ruff 클린

- [ ] **Step 7: 커밋**

```bash
git add backend/app/sources/direct_runner.py backend/app/adapters/__init__.py \
        backend/app/api/collect.py backend/app/api/ingest.py \
        backend/tests/test_direct_collect.py PROGRESS.md
git commit -m "feat(sources): direct collection runner, phase2 gated to mssql — 직결 수집 + 파싱 게이트"
```

---

## Phase 4 — API와 화면 (Task 11–14)

---

### Task 11: `/api/sources` CRUD + 연결 테스트

**Files:**
- Create: `backend/app/api/sources.py`
- Modify: `backend/app/main.py` (라우터 등록)
- Test: `backend/tests/test_sources_api.py`

**Interfaces:**
- Consumes: `DataSource`, `encrypt_secret`, `is_crypto_configured`, `get_sa_engine`,
  `clear_sa_engine`
- Produces: HTTP — `GET/POST /api/sources`, `PATCH/DELETE /api/sources/{id}`,
  `POST /api/sources/{id}/test`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/tests/test_sources_api.py`:

```python
"""소스 관리 API — 비밀 미노출·게이트·보호. / source admin API."""

from cryptography.fernet import Fernet

from app.config import get_settings

HEADERS = {"X-Preview-Password": "secret", "X-Dev-User": "admin.user"}


def _configure(monkeypatch):
    monkeypatch.setenv("PREVIEW_ADMIN_PASSWORD", "secret")
    monkeypatch.setenv("SOURCE_SECRET_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("DBV_SYSADMINS", "admin.user")
    get_settings.cache_clear()


def test_create_source_never_returns_the_password(client, monkeypatch):
    # Arrange
    _configure(monkeypatch)

    # Act
    res = client.post("/api/sources", headers=HEADERS, json={
        "name": "svca", "engine": "postgres", "host": "svca-db", "port": 5432,
        "database": "app", "username": "viewer", "password": "hunter2",
    })

    # Assert
    assert res.status_code == 200
    assert "hunter2" not in res.text
    assert "password" not in res.json()
    listed = client.get("/api/sources", headers=HEADERS).json()["items"]
    assert "hunter2" not in str(listed)
    get_settings.cache_clear()


def test_create_is_refused_without_a_secret_key(client, monkeypatch):
    # Arrange: 키가 없으면 평문 저장 대신 거부한다
    monkeypatch.setenv("PREVIEW_ADMIN_PASSWORD", "secret")
    monkeypatch.setenv("SOURCE_SECRET_KEY", "")
    monkeypatch.setenv("DBV_SYSADMINS", "admin.user")
    get_settings.cache_clear()

    # Act
    res = client.post("/api/sources", headers=HEADERS, json={
        "name": "svca", "engine": "postgres", "host": "h", "port": 5432,
        "database": "d", "username": "u", "password": "p",
    })

    # Assert
    assert res.status_code == 503
    get_settings.cache_clear()


def test_managed_source_cannot_be_edited_or_deleted(client, monkeypatch):
    # Arrange
    _configure(monkeypatch)

    # Act / Assert: 사내 MSSQL은 .env/n8n이 소유한다
    assert client.patch("/api/sources/1", headers=HEADERS,
                        json={"name": "x"}).status_code == 409
    assert client.delete("/api/sources/1", headers=HEADERS).status_code == 409
    get_settings.cache_clear()


def test_edit_requires_the_admin_password(client, monkeypatch):
    # Arrange
    _configure(monkeypatch)
    created = client.post("/api/sources", headers=HEADERS, json={
        "name": "svca", "engine": "sqlite", "file_path": "/tmp/a.db"}).json()

    # Act: 비밀번호 헤더 없이
    res = client.patch(f"/api/sources/{created['id']}",
                       headers={"X-Dev-User": "admin.user"}, json={"name": "svcb"})

    # Assert
    assert res.status_code in (401, 403, 503)
    get_settings.cache_clear()
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd backend && python -m pytest tests/test_sources_api.py -q`
Expected: FAIL — 404 (라우터 없음)

- [ ] **Step 3: 구현한다**

`backend/app/api/sources.py`:

```python
"""Data source registry API. / 소스 등록·수정·연결 테스트 (sysadmin + 비밀번호 게이트)."""

import time
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.auth import require_preview_admin, require_sysadmin
from app.db import get_db
from app.models import AuditLog, DataSource, Snapshot
from app.sources.connection import clear_sa_engine, get_sa_engine
from app.sources.crypto import CryptoNotConfigured, encrypt_secret, is_crypto_configured
from app.sources.registry import list_sources

router = APIRouter(
    prefix="/api/sources", tags=["sources"], dependencies=[Depends(require_sysadmin)]
)


class SourceCreateRequest(BaseModel):
    name: str
    engine: str
    host: str | None = None
    port: int | None = None
    database: str | None = None
    username: str | None = None
    # 쓰기 전용 — 응답에는 절대 실리지 않는다 / write-only, never echoed
    password: str | None = None
    file_path: str | None = None


class SourceUpdateRequest(SourceCreateRequest):
    name: str | None = None       # type: ignore[assignment]
    engine: str | None = None     # type: ignore[assignment]
    is_enabled: bool | None = None


def _serialize(source: DataSource) -> dict:
    """비밀번호 컬럼은 여기서부터 존재하지 않는다 — 직렬화 지점을 하나로 묶는다."""
    return {
        "id": source.id, "name": source.name, "engine": source.engine,
        "access_mode": source.access_mode, "host": source.host, "port": source.port,
        "database": source.database, "username": source.username,
        "file_path": source.file_path, "has_password": bool(source.password_enc),
        "is_enabled": source.is_enabled, "is_managed": source.is_managed,
        "last_ok_at": source.last_ok_at.isoformat() if source.last_ok_at else None,
        "last_error": source.last_error,
    }


def _validate_shape(engine: str, req: SourceCreateRequest) -> None:
    if engine == "postgres" and not (req.host and req.port and req.database
                                     and req.username):
        raise HTTPException(400, {"message": "postgres source needs host, port, "
                                             "database and username", "context": {}})
    if engine == "sqlite" and not req.file_path:
        raise HTTPException(400, {"message": "sqlite source needs file_path",
                                  "context": {}})
    if engine not in ("postgres", "sqlite"):
        raise HTTPException(400, {"message": "engine must be postgres or sqlite",
                                  "context": {"engine": engine}})


def _get_editable(db: Session, source_id: int) -> DataSource:
    source = db.get(DataSource, source_id)
    if source is None:
        raise HTTPException(404, {"message": "data source not found",
                                  "context": {"source_id": source_id}})
    if source.is_managed:
        raise HTTPException(409, {
            "message": "this source is managed by deployment config (.env / n8n) and "
                       "cannot be edited here",
            "context": {"source_id": source_id, "name": source.name}})
    return source


@router.get("")
def list_data_sources(db: Session = Depends(get_db)) -> dict:
    return {
        "secret_key_configured": is_crypto_configured(),
        "items": [_serialize(source) for source in list_sources(db)],
    }


@router.post("", dependencies=[Depends(require_preview_admin)])
def create_data_source(
    req: SourceCreateRequest, db: Session = Depends(get_db),
    admin: str = Depends(require_sysadmin),
) -> dict:
    """소스 등록 — 접속정보가 늘면 값 노출 범위가 늘어난다. 비밀번호 게이트를 건다."""
    _validate_shape(req.engine, req)
    now = datetime.now(UTC)
    try:
        password_enc = encrypt_secret(req.password) if req.password else None
    except CryptoNotConfigured as e:
        raise HTTPException(503, {"message": str(e), "context": {}}) from e

    source = DataSource(
        name=req.name.strip(), engine=req.engine, access_mode="direct",
        host=req.host, port=req.port, database=req.database, username=req.username,
        password_enc=password_enc, file_path=req.file_path,
        is_enabled=True, is_managed=False, created_at=now, updated_at=now,
    )
    db.add(source)
    db.flush()
    db.add(AuditLog(action="source_create", detail=f"{source.name} ({source.engine})",
                    requested_by=admin, requested_at=now))
    return _serialize(source)


@router.patch("/{source_id}", dependencies=[Depends(require_preview_admin)])
def update_data_source(
    source_id: int, req: SourceUpdateRequest, db: Session = Depends(get_db),
    admin: str = Depends(require_sysadmin),
) -> dict:
    source = _get_editable(db, source_id)
    for field in ("name", "host", "port", "database", "username", "file_path",
                  "is_enabled"):
        value = getattr(req, field, None)
        if value is not None:
            setattr(source, field, value)
    if req.password:
        try:
            source.password_enc = encrypt_secret(req.password)
        except CryptoNotConfigured as e:
            raise HTTPException(503, {"message": str(e), "context": {}}) from e
    source.updated_at = datetime.now(UTC)
    # 낡은 접속정보로 계속 붙지 않게 캐시를 비운다
    clear_sa_engine(source.id)
    db.add(AuditLog(action="source_update", detail=source.name,
                    requested_by=admin, requested_at=source.updated_at))
    return _serialize(source)


@router.delete("/{source_id}", dependencies=[Depends(require_preview_admin)])
def delete_data_source(
    source_id: int, db: Session = Depends(get_db),
    admin: str = Depends(require_sysadmin),
) -> dict:
    """스냅샷이 있으면 거부한다 — 되돌릴 수 없는 삭제는 명시적으로만."""
    source = _get_editable(db, source_id)
    snapshots = db.execute(
        select(func.count()).select_from(Snapshot)
        .where(Snapshot.data_source_id == source_id)
    ).scalar_one()
    if snapshots:
        raise HTTPException(409, {
            "message": "this source has collected snapshots — disable it instead of "
                       "deleting, or the collection history and allowlist go with it",
            "context": {"source_id": source_id, "snapshots": snapshots}})
    name = source.name
    db.delete(source)
    clear_sa_engine(source_id)
    db.add(AuditLog(action="source_delete", detail=name, requested_by=admin,
                    requested_at=datetime.now(UTC)))
    return {"id": source_id, "removed": True}


@router.post("/{source_id}/test")
def test_data_source(source_id: int, db: Session = Depends(get_db)) -> dict:
    """실제로 붙은 DB의 이름·버전을 회신한다 — 흔한 컨테이너명 오접속을 눈으로 잡는다."""
    source = db.get(DataSource, source_id)
    if source is None:
        raise HTTPException(404, {"message": "data source not found",
                                  "context": {"source_id": source_id}})
    if source.access_mode != "direct":
        raise HTTPException(400, {"message": "this source is served through n8n",
                                  "context": {"source_id": source_id}})
    probe = ("SELECT version() AS version, current_database() AS database"
             if source.engine == "postgres"
             else "SELECT sqlite_version() AS version, 'main' AS database")
    started = time.monotonic()
    now = datetime.now(UTC)
    try:
        with get_sa_engine(source).connect() as conn:
            row = conn.execute(text(probe)).mappings().one()
    except Exception as e:
        source.last_error = str(e)[:500]
        source.updated_at = now
        # 자격증명은 메시지에 싣지 않는다 — 호스트·DB명까지만
        raise HTTPException(502, {
            "message": "could not connect to the data source",
            "context": {"source_id": source_id, "host": source.host,
                        "database": source.database, "error": str(e)[:300]}}) from e
    source.last_ok_at = now
    source.last_error = None
    source.updated_at = now
    return {"ok": True, "version": row["version"], "database": row["database"],
            "latency_ms": round((time.monotonic() - started) * 1000, 1)}
```

- [ ] **Step 4: 라우터를 등록한다**

`backend/app/main.py`의 `create_app`에서 다른 `include_router` 옆에:

```python
    from app.api import sources

    app.include_router(sources.router)
```

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `cd backend && python -m pytest tests/test_sources_api.py -q`
Expected: PASS (4 passed)

- [ ] **Step 6: 회귀 + 커밋**

Run: `cd backend && python -m pytest -q && ruff check app tests`
Expected: 362 passed, 1 skipped

```bash
git add backend/app/api/sources.py backend/app/main.py \
        backend/tests/test_sources_api.py PROGRESS.md
git commit -m "feat(sources): source registry API with write-only secrets — 소스 관리 API"
```

---

### Task 12: 조회 API에 `source_id` 파라미터

**Files:**
- Modify: `backend/app/api/objects.py`, `backend/app/api/erd.py`,
  `backend/app/api/snapshots.py`, `backend/app/api/categories.py`
- Test: `backend/tests/test_source_scoped_queries.py`

**Interfaces:**
- Consumes: `resolve_snapshot(db, snapshot_id, source_id)` (Task 2)
- Produces: `GET /api/objects?source_id=`, `/api/objects/columns-index?source_id=`,
  `/api/erd/*?source_id=`, `/api/snapshots?source_id=`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/tests/test_source_scoped_queries.py`:

```python
"""소스별 조회 격리 — 한 소스의 검색이 다른 소스 객체를 반환하지 않는다.
/ per-source isolation of catalog queries."""

from datetime import UTC, datetime

from sqlalchemy.orm import sessionmaker

from app.models import CatalogObject, DataSource, Snapshot
from app.models.sources import MANAGED_MSSQL_SOURCE_ID


def _seed(migrated_engine) -> int:
    now = datetime.now(UTC)
    with sessionmaker(bind=migrated_engine)() as db:
        other = DataSource(name="svca", engine="sqlite", access_mode="direct",
                           file_path="/tmp/a.db", is_enabled=True, is_managed=False,
                           created_at=now, updated_at=now)
        db.add(other)
        db.flush()
        for source_id, table in ((MANAGED_MSSQL_SOURCE_ID, "MSSQL_ONLY"),
                                 (other.id, "PG_ONLY")):
            snap = Snapshot(collected_at=now, source_db="x", status="ready",
                            data_source_id=source_id)
            db.add(snap)
            db.flush()
            db.add(CatalogObject(snapshot_id=snap.id, schema="dbo", name=table,
                                 type="table", object_id=1, dmv_unresolved=False))
        db.commit()
        return other.id


def test_search_is_scoped_to_the_requested_source(client, migrated_engine):
    # Arrange
    other_id = _seed(migrated_engine)

    # Act
    default = client.get("/api/objects").json()
    scoped = client.get(f"/api/objects?source_id={other_id}").json()

    # Assert
    assert [i["name"] for i in default["items"]] == ["MSSQL_ONLY"]
    assert [i["name"] for i in scoped["items"]] == ["PG_ONLY"]
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd backend && python -m pytest tests/test_source_scoped_queries.py -q`
Expected: FAIL — 두 응답이 같다 (source_id가 무시됨)

- [ ] **Step 3: 파라미터를 뚫는다**

각 엔드포인트에 `source_id: int | None = None`을 추가하고 `resolve_snapshot`에 넘긴다.

- `objects.py:search_objects` — `resolve_snapshot(db, snapshot_id, source_id)`
- `objects.py:get_columns_index` — 동일
- `objects.py:get_preview_allowlist` — `list_allowed_schemas(db, source_id or MANAGED_MSSQL_SOURCE_ID)`
- `erd.py`의 그래프·lineage 엔드포인트 — 동일
- `snapshots.py:list_snapshots` — `source_id`가 오면 `.where(Snapshot.data_source_id == source_id)`,
  응답 항목에 `"data_source_id": snap.data_source_id` 추가
- `categories.py` — 소스별 카테고리

응답에는 `"source_id"`를 함께 실어 화면이 무엇을 보고 있는지 확인할 수 있게 한다.

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd backend && python -m pytest -q`
Expected: 363 passed, 1 skipped

- [ ] **Step 5: 커밋**

```bash
git add backend/app/api backend/tests/test_source_scoped_queries.py PROGRESS.md
git commit -m "feat(sources): scope catalog queries by source_id — 조회 API 소스 파라미터"
```

---

### Task 13: 프론트엔드 소스 선택기

**Files:**
- Create: `frontend/src/components/SourceSelector.tsx`
- Modify: `frontend/src/lib/api.ts`, `frontend/src/app/page.tsx`,
  `frontend/src/app/erd/page.tsx`
- Test: `frontend/src/lib/source-param.test.ts`

**Interfaces:**
- Produces: `interface DataSourceItem { id: number; name: string; engine: string;
  access_mode: string; is_managed: boolean; is_enabled: boolean; }`
- Produces: `fetchDataSources(): Promise<{ items: DataSourceItem[];
  secret_key_configured: boolean }>`
- Produces: `readSourceId(search: string): number | null`
- Produces: `<SourceSelector value={number | null} onChange={(id: number | null) => void} />`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`frontend/src/lib/source-param.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { readSourceId, withSourceParam } from "./source-param";

describe("readSourceId", () => {
  it("reads a numeric source from the query string", () => {
    expect(readSourceId("?source=3")).toBe(3);
  });

  it("returns null when absent so the default source is used", () => {
    expect(readSourceId("")).toBeNull();
    expect(readSourceId("?q=abc")).toBeNull();
  });

  it("rejects non-numeric values instead of forwarding them to the API", () => {
    expect(readSourceId("?source=../admin")).toBeNull();
  });
});

describe("withSourceParam", () => {
  it("appends source_id when a source is selected", () => {
    expect(withSourceParam("/api/objects?q=a", 3)).toBe("/api/objects?q=a&source_id=3");
  });

  it("leaves the path untouched for the default source", () => {
    expect(withSourceParam("/api/objects", null)).toBe("/api/objects");
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd frontend && npx vitest run src/lib/source-param.test.ts`
Expected: FAIL — `Cannot find module './source-param'`

- [ ] **Step 3: 순수 헬퍼를 쓴다**

`frontend/src/lib/source-param.ts`:

```typescript
/** 소스 선택은 URL 쿼리에 실린다 — 링크 공유와 새로고침을 견디게.
 *  The selected source lives in the URL so links survive a reload. */

export function readSourceId(search: string): number | null {
  const raw = new URLSearchParams(search).get("source");
  if (raw === null) return null;
  // 숫자가 아니면 무시한다 — 검증되지 않은 값을 API로 흘려보내지 않는다
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function withSourceParam(path: string, sourceId: number | null): string {
  if (sourceId === null) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}source_id=${sourceId}`;
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd frontend && npx vitest run src/lib/source-param.test.ts`
Expected: PASS (5 passed)

- [ ] **Step 5: API 클라이언트를 확장한다**

`frontend/src/lib/api.ts`에 추가:

```typescript
export interface DataSourceItem {
  id: number;
  name: string;
  engine: string;
  access_mode: string;
  host: string | null;
  port: number | null;
  database: string | null;
  username: string | null;
  file_path: string | null;
  has_password: boolean;
  is_enabled: boolean;
  is_managed: boolean;
  last_ok_at: string | null;
  last_error: string | null;
}

export function fetchDataSources(): Promise<{
  items: DataSourceItem[];
  secret_key_configured: boolean;
}> {
  return request("/api/sources");
}
```

카탈로그를 읽는 기존 함수들(`searchObjects`, `fetchAllObjects`, `fetchErdGraph`,
컬럼 인덱스 조회)에 `sourceId: number | null = null` 인자를 더하고 `withSourceParam`으로
경로를 만든다.

- [ ] **Step 6: 선택기 컴포넌트를 쓴다**

`frontend/src/components/SourceSelector.tsx`:

```tsx
"use client";

/** 헤더 소스 선택기 — 브라우저와 ERD가 공유한다.
 *  Header source picker, shared by the browser and the ERD. */

import { useEffect, useState } from "react";

import { fetchDataSources, type DataSourceItem } from "@/lib/api";

interface SourceSelectorProps {
  value: number | null;
  onChange: (sourceId: number | null) => void;
}

export function SourceSelector({ value, onChange }: SourceSelectorProps) {
  const [sources, setSources] = useState<DataSourceItem[]>([]);

  useEffect(() => {
    fetchDataSources()
      .then((res) => setSources(res.items.filter((item) => item.is_enabled)))
      .catch(() => setSources([]));
  }, []);

  // 소스가 하나뿐이면 고를 것이 없다 — 화면을 어지럽히지 않는다
  if (sources.length <= 1) return null;

  return (
    <select
      data-testid="SourceSelector-select"
      className="rounded border px-2 py-1 text-sm"
      value={value ?? sources[0]?.id ?? ""}
      onChange={(event) => onChange(Number(event.target.value))}
    >
      {sources.map((source) => (
        <option key={source.id} value={source.id}>
          {source.name} ({source.engine})
        </option>
      ))}
    </select>
  );
}
```

- [ ] **Step 7: 페이지에 붙인다**

`frontend/src/app/page.tsx`와 `frontend/src/app/erd/page.tsx`에서:
- `readSourceId(window.location.search)`로 초기값을 읽는다
- `<SourceSelector>`를 헤더에 두고, `onChange`에서 `history.replaceState`로 `?source=`를
  갱신한 뒤 목록을 재조회한다
- 카탈로그 조회 호출에 선택된 `sourceId`를 넘긴다
- **검증(verify)·파싱 링크는 선택된 소스의 `engine === "mssql"`일 때만 렌더한다**

- [ ] **Step 8: 게이트**

Run: `cd frontend && npx tsc --noEmit && npm run lint && npx vitest run`
Expected: 전부 통과

- [ ] **Step 9: 커밋**

```bash
git add frontend/src/lib/source-param.ts frontend/src/lib/source-param.test.ts \
        frontend/src/components/SourceSelector.tsx frontend/src/lib/api.ts \
        frontend/src/app/page.tsx frontend/src/app/erd/page.tsx PROGRESS.md
git commit -m "feat(sources): source selector in browser and ERD — 소스 선택기 (URL 쿼리 유지)"
```

---

### Task 14: 관리자 소스 패널

**Files:**
- Create: `frontend/src/components/admin/DataSourcePanel.tsx`
- Modify: `frontend/src/app/admin/page.tsx`, `frontend/src/lib/api.ts`

**Interfaces:**
- Consumes: `fetchDataSources`, `DataSourceItem` (Task 13)
- Produces: `createDataSource`, `updateDataSource`, `deleteDataSource`, `testDataSource`

- [ ] **Step 1: API 클라이언트를 확장한다**

`frontend/src/lib/api.ts`:

```typescript
export interface DataSourceInput {
  name: string;
  engine: "postgres" | "sqlite";
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  file_path?: string;
}

export function createDataSource(
  input: DataSourceInput, password: string,
): Promise<DataSourceItem> {
  return request("/api/sources", {
    method: "POST",
    headers: { "X-Preview-Password": password },
    body: JSON.stringify(input),
  });
}

export function updateDataSource(
  id: number, input: Partial<DataSourceInput> & { is_enabled?: boolean },
  password: string,
): Promise<DataSourceItem> {
  return request(`/api/sources/${id}`, {
    method: "PATCH",
    headers: { "X-Preview-Password": password },
    body: JSON.stringify(input),
  });
}

export function deleteDataSource(id: number, password: string): Promise<{ removed: boolean }> {
  return request(`/api/sources/${id}`, {
    method: "DELETE",
    headers: { "X-Preview-Password": password },
  });
}

export function testDataSource(id: number): Promise<{
  ok: boolean; version: string; database: string; latency_ms: number;
}> {
  return request(`/api/sources/${id}/test`, { method: "POST" });
}
```

기존 `request` 헬퍼의 헤더 병합 방식을 그대로 따른다 (`PreviewAllowlistPanel`이 쓰는
`addPreviewAllow` 구현을 참고).

- [ ] **Step 2: 패널을 쓴다**

`frontend/src/components/admin/DataSourcePanel.tsx`:

```tsx
"use client";

/** 소스 등록·수정·연결 테스트 — 미리보기 허용 목록과 같은 비밀번호 게이트를 쓴다.
 *  Data source registry; edits reuse the preview-admin password gate. */

import { useCallback, useEffect, useState } from "react";

import {
  createDataSource,
  deleteDataSource,
  fetchDataSources,
  testDataSource,
  updateDataSource,
  type DataSourceItem,
} from "@/lib/api";

const EMPTY_FORM = {
  name: "", engine: "postgres" as const, host: "", port: 5432,
  database: "", username: "", password: "", file_path: "",
};

export function DataSourcePanel() {
  const [password, setPassword] = useState("");
  const [items, setItems] = useState<DataSourceItem[]>([]);
  const [keyConfigured, setKeyConfigured] = useState(true);
  const [form, setForm] = useState<typeof EMPTY_FORM>(EMPTY_FORM);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(
    () =>
      fetchDataSources()
        .then((res) => {
          setItems(res.items);
          setKeyConfigured(res.secret_key_configured);
        })
        .catch((e) => setError(e.message)),
    [],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  const canEdit = keyConfigured && password.length > 0;

  const run = (task: () => Promise<unknown>, done: string) => {
    setError(null);
    setMessage(null);
    task()
      .then(() => {
        setMessage(done);
        return reload();
      })
      .catch((e) => setError(e.message));
  };

  const handleCreate = () => {
    const input =
      form.engine === "sqlite"
        ? { name: form.name, engine: form.engine, file_path: form.file_path }
        : {
            name: form.name, engine: form.engine, host: form.host,
            port: Number(form.port), database: form.database,
            username: form.username, password: form.password,
          };
    run(() => createDataSource(input, password).then(() => setForm(EMPTY_FORM)),
        "소스를 등록했습니다");
  };

  return (
    <section data-testid="DataSourcePanel-root" className="space-y-4">
      <h2 className="text-lg font-semibold">데이터 소스</h2>

      {!keyConfigured && (
        <p data-testid="DataSourcePanel-keyMissing" className="text-sm text-red-600">
          SOURCE_SECRET_KEY가 설정되지 않아 소스를 등록할 수 없습니다. .env를 채우고
          백엔드를 재기동하세요.
        </p>
      )}

      <input
        data-testid="DataSourcePanel-passwordInput"
        type="password"
        placeholder="관리 비밀번호"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="rounded border px-2 py-1 text-sm"
      />

      <ul data-testid="DataSourcePanel-list" className="space-y-2">
        {items.map((item) => (
          <li
            key={item.id}
            data-testid={`DataSourcePanel-item-${item.id}`}
            className="flex items-center gap-3 rounded border p-2 text-sm"
          >
            <span className="font-medium">{item.name}</span>
            <span className="text-neutral-500">{item.engine}</span>
            <span className="text-neutral-500">
              {item.engine === "sqlite"
                ? item.file_path
                : `${item.host}:${item.port}/${item.database}`}
            </span>
            {item.last_error && (
              <span data-testid={`DataSourcePanel-error-${item.id}`} className="text-red-600">
                연결 실패
              </span>
            )}
            <button
              data-testid={`DataSourcePanel-testButton-${item.id}`}
              onClick={() =>
                run(
                  () =>
                    testDataSource(item.id).then((res) =>
                      setMessage(`연결 성공 — ${res.database} / ${res.version}`),
                    ),
                  "연결 확인",
                )
              }
              className="rounded border px-2 py-1"
            >
              연결 테스트
            </button>
            {!item.is_managed && (
              <>
                <button
                  data-testid={`DataSourcePanel-toggleButton-${item.id}`}
                  disabled={!canEdit}
                  onClick={() =>
                    run(
                      () => updateDataSource(item.id, { is_enabled: !item.is_enabled }, password),
                      item.is_enabled ? "비활성화했습니다" : "활성화했습니다",
                    )
                  }
                  className="rounded border px-2 py-1"
                >
                  {item.is_enabled ? "비활성화" : "활성화"}
                </button>
                <button
                  data-testid={`DataSourcePanel-deleteButton-${item.id}`}
                  disabled={!canEdit}
                  onClick={() =>
                    run(() => deleteDataSource(item.id, password), "삭제했습니다")
                  }
                  className="rounded border px-2 py-1"
                >
                  삭제
                </button>
              </>
            )}
          </li>
        ))}
      </ul>

      <div data-testid="DataSourcePanel-form" className="space-y-2 rounded border p-3">
        <input
          data-testid="DataSourcePanel-nameInput"
          placeholder="이름"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="rounded border px-2 py-1 text-sm"
        />
        <select
          data-testid="DataSourcePanel-engineSelect"
          value={form.engine}
          onChange={(e) =>
            setForm({ ...form, engine: e.target.value as "postgres" | "sqlite" })
          }
          className="rounded border px-2 py-1 text-sm"
        >
          <option value="postgres">PostgreSQL</option>
          <option value="sqlite">SQLite</option>
        </select>

        {form.engine === "sqlite" ? (
          <input
            data-testid="DataSourcePanel-filePathInput"
            placeholder="/mnt/sources/svcc/app.db"
            value={form.file_path}
            onChange={(e) => setForm({ ...form, file_path: e.target.value })}
            className="w-full rounded border px-2 py-1 text-sm"
          />
        ) : (
          <div className="flex gap-2">
            <input
              data-testid="DataSourcePanel-hostInput"
              placeholder="컨테이너 이름 또는 네트워크 별칭"
              value={form.host}
              onChange={(e) => setForm({ ...form, host: e.target.value })}
              className="rounded border px-2 py-1 text-sm"
            />
            <input
              data-testid="DataSourcePanel-portInput"
              type="number"
              value={form.port}
              onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
              className="w-24 rounded border px-2 py-1 text-sm"
            />
            <input
              data-testid="DataSourcePanel-databaseInput"
              placeholder="database"
              value={form.database}
              onChange={(e) => setForm({ ...form, database: e.target.value })}
              className="rounded border px-2 py-1 text-sm"
            />
            <input
              data-testid="DataSourcePanel-usernameInput"
              placeholder="읽기전용 계정"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              className="rounded border px-2 py-1 text-sm"
            />
            <input
              data-testid="DataSourcePanel-secretInput"
              type="password"
              placeholder="비밀번호"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className="rounded border px-2 py-1 text-sm"
            />
          </div>
        )}

        <button
          data-testid="DataSourcePanel-createButton"
          disabled={!canEdit || !form.name}
          onClick={handleCreate}
          className="rounded border px-3 py-1 text-sm"
        >
          등록
        </button>
      </div>

      {message && (
        <p data-testid="DataSourcePanel-message" className="text-sm text-green-700">
          {message}
        </p>
      )}
      {error && (
        <p data-testid="DataSourcePanel-errorMessage" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </section>
  );
}
```

- [ ] **Step 3: 관리 화면에 붙인다**

`frontend/src/app/admin/page.tsx`에서 `PreviewAllowlistPanel` 위에 `<DataSourcePanel />`를
렌더한다 (소스가 없으면 나머지 설정이 의미가 없으므로 첫 자리).

- [ ] **Step 4: 게이트**

Run: `cd frontend && npx tsc --noEmit && npm run lint && npx vitest run`
Expected: 전부 통과

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/components/admin/DataSourcePanel.tsx \
        frontend/src/app/admin/page.tsx frontend/src/lib/api.ts PROGRESS.md
git commit -m "feat(sources): admin panel for data sources — 소스 관리 패널 (쓰기 전용 비밀번호)"
```

---

## Phase 5 — 배포와 문서 (Task 15)

---

### Task 15: 설정 동기화 + 배포 문서 + 담당자 프롬프트

**Files:**
- Create: `docs/connect-sources.md`
- Create: `docs/handoff/service-owner-prompt.md`
- Modify: `.env.example`, `docker-compose.yml`, `README.md`

- [ ] **Step 1: `.env.example`에 신규 값을 넣는다**

파일 끝에:

```bash
# 소스 접속 비밀번호 암호화 키 (Fernet, urlsafe base64 32B). 비어 있으면 소스 등록이 503.
# 생성: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
SOURCE_SECRET_KEY=

# 직결 소스 연결/문장 타임아웃(초) — 한 소스가 멎어도 요청이 붙잡히지 않게 한다
SOURCE_CONNECT_TIMEOUT=5
SOURCE_QUERY_TIMEOUT=15
```

- [ ] **Step 2: `docker-compose.yml`에 환경변수와 네트워크 자리를 만든다**

`backend` 서비스의 `environment:`에:

```yaml
      SOURCE_SECRET_KEY: ${SOURCE_SECRET_KEY}
      SOURCE_CONNECT_TIMEOUT: ${SOURCE_CONNECT_TIMEOUT:-5}
      SOURCE_QUERY_TIMEOUT: ${SOURCE_QUERY_TIMEOUT:-15}
```

파일 하단에 주석으로 합류 방법을 남긴다 (실제 네트워크명은 배포마다 다르므로 예시로만):

```yaml
# 조회 대상 서비스마다 전용 브리지 네트워크를 외부에서 만들고(dbv-<서비스>) 여기에 합류한다.
# 대상 서비스의 기존 default 네트워크·subnet은 건드리지 않는다 — docs/connect-sources.md
#   backend:
#     networks: [dbviewer, dbv-svca]
#     volumes: [svcc_data:/mnt/sources/svcc:ro]
# networks:
#   dbv-svca: { external: true }
```

- [ ] **Step 3: 배포·연결 문서를 쓴다**

`docs/connect-sources.md` — 다음을 담는다:
1. 네트워크 B′ 생성 (`docker network create --subnet 172.50.<n>.0/24 dbv-<서비스>`)
2. **대상 DB 컨테이너 볼륨 사전 확인** (`docker inspect -f '{{range .Mounts}}...'`) —
   출력이 비면 그 서비스는 적용 금지
3. 대상 compose 수정 (default 정의는 그대로, 네트워크 항목만 추가 + 고유 alias)
4. `docker compose up -d`로 in-place 재생성 (**`down` 금지**)
5. 읽기전용 계정 발급 SQL (PostgreSQL):
   ```sql
   CREATE ROLE dbviewer_ro LOGIN PASSWORD '<강력한 값>';
   GRANT CONNECT ON DATABASE <db> TO dbviewer_ro;
   GRANT USAGE ON SCHEMA public TO dbviewer_ro;
   GRANT SELECT ON ALL TABLES IN SCHEMA public TO dbviewer_ro;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO dbviewer_ro;
   ```
6. db-viewer compose 수정 후 `docker compose up -d --build backend`
7. `/admin` → 소스 등록 → [연결 테스트] → [수집 실행] → 미리보기 allowlist 등록
8. 트러블슈팅 표 (연결 실패, 이름 충돌, `network not found`)

- [ ] **Step 4: 담당자 전달용 프롬프트를 쓴다**

`docs/handoff/service-owner-prompt.md` — 각 서비스 담당자가 자기 저장소에서 Claude Code에
그대로 붙여넣을 수 있는 프롬프트. 채워야 할 자리(`<서비스키>`, `<네트워크명>`, `<서브넷>`)를
표로 먼저 제시하고, 프롬프트 본문·사전 확인·완료 보고 양식을 담는다.

- [ ] **Step 5: README를 갱신한다**

`## 배포` 절에 소스 연결 문서 링크를, 트러블슈팅 표에 3행을 추가한다:

| 증상 | 확인 |
|---|---|
| 소스 등록이 503 | `SOURCE_SECRET_KEY` 미설정 — `.env` 채우고 backend 재기동 |
| 연결 테스트가 엉뚱한 DB를 회신 | 여러 서비스가 같은 컨테이너명(`postgres`)을 씀 — host를 네트워크 alias나 컨테이너 풀네임으로 |
| backend가 `network ... not found`로 기동 실패 | `dbv-<서비스>` 네트워크가 지워짐 — `docker network create`로 다시 만든다 |

- [ ] **Step 6: 전체 게이트**

```bash
cd backend && python -m pytest -q && ruff check app tests
cd ../frontend && npx tsc --noEmit && npm run lint && npx vitest run
```
Expected: 백엔드 363 passed / 1 skipped, 프론트 전부 통과

- [ ] **Step 7: 커밋**

```bash
git add .env.example docker-compose.yml README.md docs/connect-sources.md \
        docs/handoff/service-owner-prompt.md PROGRESS.md
git commit -m "docs(sources): deployment runbook and service-owner handoff — 소스 연결 문서"
```

---

## 완료 기준

- [ ] 백엔드 테스트 그린 (베이스라인 335 → 363 이상), ruff 클린
- [ ] 프론트엔드 tsc / eslint / vitest 그린
- [ ] 마이그레이션 `head → 0014 → head` 왕복이 SQLite에서 통과
- [ ] 사내 MSSQL 화면이 소스 선택 이전과 동일하게 동작 (수동 확인)
- [ ] 등록한 PostgreSQL 소스에서 목록 → 컬럼 → 미리보기 → ERD가 동작 (수동 확인)
- [ ] 소스 API 응답 어디에도 비밀번호가 없다 (`grep`으로 확인)
