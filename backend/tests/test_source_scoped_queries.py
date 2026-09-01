"""소스별 조회 격리 — 한 소스의 검색이 다른 소스 객체를 반환하지 않는다.
/ per-source isolation of catalog queries."""

from datetime import UTC, datetime

from sqlalchemy.orm import sessionmaker

from app.models import (
    AiSummary,
    CatalogColumn,
    CatalogConstraint,
    CatalogObject,
    DataSource,
    FkColumn,
    Relation,
    Snapshot,
)
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


def _seed_erd(migrated_engine) -> int:
    """ERD는 FK/confirmed 관계로 연결된 노드만 그린다 — 소스별 2테이블 + 확정 관계로 시딩."""
    now = datetime.now(UTC)
    with sessionmaker(bind=migrated_engine)() as db:
        other = DataSource(name="svcb", engine="sqlite", access_mode="direct",
                           file_path="/tmp/b.db", is_enabled=True, is_managed=False,
                           created_at=now, updated_at=now)
        db.add(other)
        db.flush()
        for source_id, (t1, t2) in ((MANAGED_MSSQL_SOURCE_ID, ("MSSQL_A", "MSSQL_B")),
                                    (other.id, ("PG_A", "PG_B"))):
            snap = Snapshot(collected_at=now, source_db="x", status="ready",
                            data_source_id=source_id)
            db.add(snap)
            db.flush()
            db.add(CatalogObject(snapshot_id=snap.id, schema="dbo", name=t1,
                                 type="table", object_id=1, dmv_unresolved=False))
            db.add(CatalogObject(snapshot_id=snap.id, schema="dbo", name=t2,
                                 type="table", object_id=2, dmv_unresolved=False))
            db.add(Relation(src_object=f"dbo.{t1}", src_column="ID",
                            tgt_object=f"dbo.{t2}", tgt_column="ID",
                            status="confirmed", origin="user", created_at=now))
        db.commit()
        return other.id


def _seed_join_keys(migrated_engine) -> int:
    """조인키는 FK 컬럼 페어에서 나온다 — 소스별로 겹치지 않는 키 이름의 FK를 시딩."""
    now = datetime.now(UTC)
    with sessionmaker(bind=migrated_engine)() as db:
        other = DataSource(name="svcc", engine="sqlite", access_mode="direct",
                           file_path="/tmp/c.db", is_enabled=True, is_managed=False,
                           created_at=now, updated_at=now)
        db.add(other)
        db.flush()
        for source_id, key_name in ((MANAGED_MSSQL_SOURCE_ID, "MSSQL_KEY"),
                                    (other.id, "PG_KEY")):
            snap = Snapshot(collected_at=now, source_db="x", status="ready",
                            data_source_id=source_id)
            db.add(snap)
            db.flush()
            parent = CatalogObject(snapshot_id=snap.id, schema="dbo", name="PARENT",
                                   type="table", object_id=1, dmv_unresolved=False)
            child = CatalogObject(snapshot_id=snap.id, schema="dbo", name="CHILD",
                                  type="table", object_id=2, dmv_unresolved=False)
            db.add_all([parent, child])
            db.flush()
            parent_col = CatalogColumn(object_id=parent.id, name=key_name, ordinal=1,
                                       data_type="int", max_length=4, is_nullable=False,
                                       is_pk=True, is_computed=False)
            child_col = CatalogColumn(object_id=child.id, name=key_name, ordinal=1,
                                      data_type="int", max_length=4, is_nullable=False,
                                      is_pk=False, is_computed=False)
            db.add_all([parent_col, child_col])
            db.flush()
            constraint = CatalogConstraint(snapshot_id=snap.id, type="fk", name=f"FK_{key_name}")
            db.add(constraint)
            db.flush()
            db.add(FkColumn(constraint_id=constraint.id,
                            src_column_id=child_col.id, tgt_column_id=parent_col.id))
        db.commit()
        return other.id


def _seed_colliding_objects(migrated_engine) -> tuple[int, int]:
    """두 소스에 같은 `schema.name` 객체 + 그 qname의 확정 관계·AI 요약.

    relations·ai_summaries에는 소스 축이 없다(qname이 키) — 이름이 겹치면 다른 소스
    객체가 사내 MSSQL의 관계·요약을 자기 것처럼 달고 나온다. 반환: (mssql_obj, other_obj).
    """
    now = datetime.now(UTC)
    with sessionmaker(bind=migrated_engine)() as db:
        other = DataSource(name="svcd", engine="postgres", access_mode="direct",
                           host="h", port=5432, database="d", username="u",
                           is_enabled=True, is_managed=False,
                           created_at=now, updated_at=now)
        db.add(other)
        db.flush()
        object_ids: list[int] = []
        for source_id in (MANAGED_MSSQL_SOURCE_ID, other.id):
            snap = Snapshot(collected_at=now, source_db="x", status="ready",
                            data_source_id=source_id)
            db.add(snap)
            db.flush()
            obj = CatalogObject(snapshot_id=snap.id, schema="dbo", name="EMPLOYEE",
                                type="table", object_id=1, dmv_unresolved=False)
            db.add(obj)
            db.flush()
            object_ids.append(obj.id)
        db.add(Relation(src_object="dbo.EMPLOYEE", src_column="EMP_NO",
                        tgt_object="dbo.PEER", tgt_column="EMP_NO",
                        status="confirmed", origin="user", created_at=now))
        db.add(AiSummary(object_qname="dbo.EMPLOYEE", summary="직원 마스터",
                         created_at=now))
        db.commit()
        return object_ids[0], object_ids[1]


def test_detail_keeps_relations_and_ai_summary_inside_the_mssql_source(
    client, migrated_engine
):
    """상세 패널의 관계·AI 요약은 MSSQL 전용 개념이다 — 동명 PG 객체가 물려받으면 안 된다."""
    # Arrange
    mssql_object, other_object = _seed_colliding_objects(migrated_engine)

    # Act
    mssql = client.get(f"/api/objects/{mssql_object}/detail").json()
    other = client.get(f"/api/objects/{other_object}/detail").json()

    # Assert: MSSQL 쪽은 그대로 나와야 차단이 공허하지 않다
    assert [r["other"] for r in mssql["relations"]] == ["dbo.PEER"]
    assert mssql["ai_summary"] == "직원 마스터"
    assert other["relations"] == []
    assert other["ai_summary"] is None


def test_search_is_scoped_to_the_requested_source(client, migrated_engine):
    # Arrange
    other_id = _seed(migrated_engine)

    # Act
    default = client.get("/api/objects").json()
    scoped = client.get(f"/api/objects?source_id={other_id}").json()

    # Assert
    assert [i["name"] for i in default["items"]] == ["MSSQL_ONLY"]
    assert [i["name"] for i in scoped["items"]] == ["PG_ONLY"]
    # 화면이 지금 무엇을 보고 있는지 응답으로 확인할 수 있어야 한다
    assert default["source_id"] == MANAGED_MSSQL_SOURCE_ID
    assert scoped["source_id"] == other_id


def test_columns_index_is_scoped_to_the_requested_source(client, migrated_engine):
    # Arrange
    other_id = _seed(migrated_engine)

    # Act
    default = client.get("/api/objects/columns-index").json()
    scoped = client.get(f"/api/objects/columns-index?source_id={other_id}").json()

    # Assert — 서로 다른 스냅샷을 가리켜야 격리가 실제로 됐다는 증거
    assert default["snapshot_id"] != scoped["snapshot_id"]
    assert default["source_id"] == MANAGED_MSSQL_SOURCE_ID
    assert scoped["source_id"] == other_id


def test_erd_graph_is_scoped_to_the_requested_source(client, migrated_engine):
    # Arrange
    other_id = _seed_erd(migrated_engine)

    # Act
    default = client.get("/api/erd").json()
    scoped = client.get(f"/api/erd?source_id={other_id}").json()

    # Assert — 다른 소스 테이블이 섞여 들어오면 안 된다
    assert {n["name"] for n in default["nodes"]} == {"MSSQL_A", "MSSQL_B"}
    assert {n["name"] for n in scoped["nodes"]} == {"PG_A", "PG_B"}
    assert default["source_id"] == MANAGED_MSSQL_SOURCE_ID
    assert scoped["source_id"] == other_id


def test_snapshots_list_carries_data_source_id_and_filters_when_given(client, migrated_engine):
    # Arrange
    other_id = _seed(migrated_engine)

    # Act — source_id 생략 시 기존 동작(전체 이력) 유지, 지정 시 그 소스만
    all_items = client.get("/api/snapshots").json()["items"]
    scoped_items = client.get(f"/api/snapshots?source_id={other_id}").json()["items"]

    # Assert
    assert {i["data_source_id"] for i in all_items} == {MANAGED_MSSQL_SOURCE_ID, other_id}
    assert {i["data_source_id"] for i in scoped_items} == {other_id}


def test_join_keys_is_scoped_to_the_requested_source(client, migrated_engine):
    """메인 화면 조인키 필터 바 — 소스를 전환해도 다른 소스의 키가 섞이면 안 된다."""
    # Arrange
    other_id = _seed_join_keys(migrated_engine)

    # Act
    default = client.get("/api/join-keys").json()
    scoped = client.get(f"/api/join-keys?source_id={other_id}").json()

    # Assert
    assert {i["key"] for i in default["items"]} == {"MSSQL_KEY"}
    assert {i["key"] for i in scoped["items"]} == {"PG_KEY"}
    assert default["source_id"] == MANAGED_MSSQL_SOURCE_ID
    assert scoped["source_id"] == other_id
