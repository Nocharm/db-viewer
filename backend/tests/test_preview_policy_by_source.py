"""미리보기 허용이 소스 경계를 넘지 않는지. / allowlist must not leak across sources.

서비스 계층의 불변식 1건 + 실값이 나가는 세 경로(테이블 미리보기·2-way 조인 샘플·N-way
조인 미리보기)가 **각자 객체의 소스로** 판정하는지. 세 경로 모두 클라이언트가 준 id를
그대로 해석하므로, 기본 소스로 하드코딩하면 소스 1의 허용이 소스 2를 열어버린다.
"""

from datetime import UTC, datetime

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker

from app.config import get_settings
from app.models import Base, DataSource, PreviewAllowlist
from app.models.sources import MANAGED_MSSQL_SOURCE_ID
from app.services.preview_policy import is_preview_allowed

PASSWORD = "s3cret-preview"


@pytest.fixture()
def preview_password(monkeypatch):
    monkeypatch.setenv("PREVIEW_ADMIN_PASSWORD", PASSWORD)
    get_settings.cache_clear()
    yield PASSWORD
    monkeypatch.delenv("PREVIEW_ADMIN_PASSWORD", raising=False)
    get_settings.cache_clear()


def _seed_source(client, load_fixture, data_source_id: int | None = None) -> int:
    """카탈로그 1세트를 한 소스로 적재하고 snapshot_id를 준다 / ingest one catalog per source."""
    payload = load_fixture("catalog.json")
    if data_source_id is not None:
        payload = {**payload, "data_source_id": data_source_id}
    sid = client.post("/api/ingest/catalog", json=payload).json()["snapshot_id"]
    client.post("/api/ingest/view-deps",
                json={**load_fixture("view_deps.json"), "snapshot_id": sid})
    return sid


def _create_source(engine, name: str) -> int:
    """직결 소스 1건 등록 — 같은 픽스처를 두 소스에 넣어 스키마명을 겹치게 만든다."""
    now = datetime.now(UTC)
    with sessionmaker(bind=engine)() as db:
        source = DataSource(name=name, engine="postgres", access_mode="direct",
                            host="h", port=5432, database="d", username="u",
                            is_enabled=True, is_managed=False,
                            created_at=now, updated_at=now)
        db.add(source)
        db.commit()
        return source.id


def _find_table(engine, snapshot_id: int) -> tuple[int, str]:
    """그 스냅샷의 테이블 1건 (id, schema)."""
    objects = Base.metadata.tables["objects"]
    with engine.connect() as conn:
        return conn.execute(
            sa.select(objects.c.id, objects.c.schema)
            .where(objects.c.snapshot_id == snapshot_id, objects.c.type == "table")
            .order_by(objects.c.id).limit(1)
        ).one()._tuple()


def _find_column(engine, snapshot_id: int, qname: str, column: str) -> int:
    """스냅샷 안에서 컬럼 id — 같은 qname이 두 소스에 있으므로 스냅샷으로 좁혀야 한다."""
    schema, table = qname.split(".", 1)
    objects, columns = Base.metadata.tables["objects"], Base.metadata.tables["columns"]
    with engine.connect() as conn:
        return conn.execute(
            sa.select(columns.c.id).join(objects, columns.c.object_id == objects.c.id)
            .where(objects.c.snapshot_id == snapshot_id, objects.c.schema == schema,
                   objects.c.name == table, columns.c.name == column)
        ).scalar_one()


def _allow(client, schema: str, source_id: int | None = None) -> None:
    body = {"schema": schema}
    if source_id is not None:
        body["source_id"] = source_id
    res = client.post("/api/admin/preview-allowlist",
                      headers={"X-Preview-Password": PASSWORD}, json=body)
    assert res.status_code == 200, res.json()


def _a_joinable_relation(load_fixture) -> dict:
    return next(r for r in load_fixture("expected/relations.json")["rows"]
                if r["kind"] == "real_no_fk" and r["orphan_count"] == 0)


def _use_fake_validator(client, fixture_dir) -> None:
    from app.adapters.fake_validator import FakeJoinValidator
    from app.api.validate import get_join_validator

    client.app.dependency_overrides[get_join_validator] = lambda: FakeJoinValidator(
        fixture_dir / "value_sets.json"
    )


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


def test_table_preview_judges_by_the_objects_own_source(
    client, load_fixture, migrated_engine, preview_password
):
    """`/api/objects/{id}/preview` — 허용은 소스 1에만 줬는데 소스 2 객체가 열리면 안 된다."""
    # Arrange: 같은 카탈로그를 두 소스에 적재해 스키마명을 겹치게 한다
    managed_snapshot = _seed_source(client, load_fixture)
    other_id = _create_source(migrated_engine, "svcb")
    other_snapshot = _seed_source(client, load_fixture, data_source_id=other_id)
    managed_obj, schema = _find_table(migrated_engine, managed_snapshot)
    other_obj, other_schema = _find_table(migrated_engine, other_snapshot)
    assert other_schema == schema  # 이름이 겹쳐야 교차소스 누출을 시험할 수 있다
    _allow(client, schema)  # 소스 1에만 허용

    # Act
    managed = client.get(f"/api/objects/{managed_obj}/preview")
    other = client.get(f"/api/objects/{other_obj}/preview")

    # Assert: 허용을 준 소스만 열린다 (200이 함께 나와야 차단이 공허하지 않다)
    assert managed.status_code == 200
    assert other.status_code == 403
    assert "preview allowlist" in other.json()["error"]["message"]

    # 그 소스에 직접 허용을 주면 그때 열린다 — 게이트가 맞는 소스를 읽고 있다는 증거.
    # "svcb"는 존재하지 않는 host("h")를 가리키는 가짜 direct 소스라 실제 연결은 실패하지만
    # (502), 여기서 확인할 것은 allowlist 게이트가 더는 막지 않는다는 점(403 아님)이다 —
    # 아래 join 계열 두 테스트와 같은 패턴
    _allow(client, schema, source_id=other_id)
    assert client.get(f"/api/objects/{other_obj}/preview").status_code == 502


def test_join_sample_judges_by_the_columns_own_source(
    client, load_fixture, migrated_engine, fixture_dir, preview_password
):
    """`/api/validate/preview` — column_id는 클라이언트 값이라 어느 소스든 가리킬 수 있다."""
    # Arrange
    managed_snapshot = _seed_source(client, load_fixture)
    other_id = _create_source(migrated_engine, "svcb")
    other_snapshot = _seed_source(client, load_fixture, data_source_id=other_id)
    _use_fake_validator(client, fixture_dir)
    rel = _a_joinable_relation(load_fixture)
    _allow(client, rel["src_object"].split(".", 1)[0])  # 소스 1에만 허용

    def ids_for(snapshot_id: int) -> dict:
        return {
            "src_column_id": _find_column(migrated_engine, snapshot_id,
                                          rel["src_object"], rel["src_column"]),
            "tgt_column_id": _find_column(migrated_engine, snapshot_id,
                                          rel["tgt_object"], rel["tgt_column"]),
        }

    # Act
    managed = client.post("/api/validate/preview", json=ids_for(managed_snapshot))
    other = client.post("/api/validate/preview", json=ids_for(other_snapshot))

    # Assert: 허용된 소스는 통과(403 아님), 다른 소스는 같은 스키마명이어도 차단
    assert managed.status_code != 403
    assert other.status_code == 403
    assert other.json()["error"]["context"]["objects"] == [rel["src_object"],
                                                           rel["tgt_object"]]


def test_n_way_join_preview_judges_by_the_columns_own_source(
    client, load_fixture, migrated_engine, fixture_dir, preview_password
):
    """`/api/join/preview` — 조인 빌더가 실제로 쓰는 경로라 여기가 뚫리면 나머지가 무의미하다."""
    # Arrange
    managed_snapshot = _seed_source(client, load_fixture)
    other_id = _create_source(migrated_engine, "svcb")
    other_snapshot = _seed_source(client, load_fixture, data_source_id=other_id)
    _use_fake_validator(client, fixture_dir)
    rel = _a_joinable_relation(load_fixture)
    _allow(client, rel["src_object"].split(".", 1)[0])  # 소스 1에만 허용

    def body_for(snapshot_id: int) -> dict:
        return {"steps": [{
            "left_column_id": _find_column(migrated_engine, snapshot_id,
                                           rel["src_object"], rel["src_column"]),
            "right_column_id": _find_column(migrated_engine, snapshot_id,
                                            rel["tgt_object"], rel["tgt_column"]),
            "join_type": "inner",
        }]}

    # Act
    managed = client.post("/api/join/preview", json=body_for(managed_snapshot))
    other = client.post("/api/join/preview", json=body_for(other_snapshot))

    # Assert
    assert managed.status_code != 403
    assert other.status_code == 403
    assert other.json()["error"]["context"]["objects"] == [rel["src_object"],
                                                           rel["tgt_object"]]
