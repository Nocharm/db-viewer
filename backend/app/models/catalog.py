"""Phase 1 catalog schema — snapshots, objects, columns, constraints, lineage. / Phase 1 카탈로그 스키마."""

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    false,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    """Declarative base for all service-DB models. / 서비스 DB 모델 공통 베이스."""


class Snapshot(Base):
    """One catalog collection run — every catalog row hangs off a snapshot. / 카탈로그 수집 1회분 — 모든 행이 스냅샷에 종속 (버저닝·드리프트 감지 기반)."""

    __tablename__ = "snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    source_db: Mapped[str] = mapped_column(String(128))
    # collecting: ingest 진행 중 / ready: 조회 가능 / failed: 수집 실패
    status: Mapped[str] = mapped_column(String(16))

    __table_args__ = (
        CheckConstraint(
            "status IN ('collecting', 'ready', 'failed')", name="ck_snapshots_status"
        ),
    )


class CatalogObject(Base):
    """Table or view captured in a snapshot. / 스냅샷에 담긴 테이블·뷰."""

    __tablename__ = "objects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(
        ForeignKey("snapshots.id", ondelete="CASCADE", name="fk_objects_snapshot_id")
    )
    schema: Mapped[str] = mapped_column(String(128))
    name: Mapped[str] = mapped_column(String(128))
    type: Mapped[str] = mapped_column(String(8))
    # MSSQL 원본 object_id — 서비스 PK(id)와 다르다 / native MSSQL object_id, not the service PK
    object_id: Mapped[int] = mapped_column(Integer)
    row_count: Mapped[int | None] = mapped_column(BigInteger)
    # 뷰 DDL (sys.sql_modules) — NULL = 테이블이거나 VIEW DEFINITION 권한 차단
    # view DDL; NULL means table or permission-blocked definition
    definition: Mapped[str | None] = mapped_column(Text)
    # dm_sql_referenced_entities 실패 격리 플래그 (계획 §1.1) / DMV failure isolation flag
    dmv_unresolved: Mapped[bool] = mapped_column(Boolean, server_default=false())
    # Phase 2 파싱 상태 — NULL = 미파싱(테이블·definition 없음) / parse isolation status
    parse_status: Mapped[str | None] = mapped_column(String(16))
    parse_error: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        CheckConstraint("type IN ('table', 'view')", name="ck_objects_type"),
        CheckConstraint(
            "parse_status IN ('ok', 'partial', 'unsupported', 'parse_failed')",
            name="ck_objects_parse_status",
        ),
        UniqueConstraint("snapshot_id", "object_id", name="uq_objects_snapshot_object"),
        Index("ix_objects_snapshot_schema_name", "snapshot_id", "schema", "name"),
    )


class CatalogColumn(Base):
    """Column of a catalog object. / 카탈로그 객체의 컬럼."""

    __tablename__ = "columns"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # objects.id(서비스 PK) 참조 — MSSQL object_id 아님 / references service PK, not MSSQL object_id
    object_id: Mapped[int] = mapped_column(
        ForeignKey("objects.id", ondelete="CASCADE", name="fk_columns_object_id")
    )
    name: Mapped[str] = mapped_column(String(128))
    ordinal: Mapped[int] = mapped_column(Integer)
    data_type: Mapped[str] = mapped_column(String(128))
    # sys.columns.max_length 그대로 — varchar(max) 등은 -1 / -1 for MAX types, as in sys.columns
    max_length: Mapped[int] = mapped_column(Integer)
    is_nullable: Mapped[bool] = mapped_column(Boolean)
    is_pk: Mapped[bool] = mapped_column(Boolean)
    is_computed: Mapped[bool] = mapped_column(Boolean)
    # T2/T3 관측 후 채워진다 / filled after validation runs (Phase 3~4)
    distinct_count: Mapped[int | None] = mapped_column(BigInteger)
    null_ratio: Mapped[float | None] = mapped_column(Float)
    # 미리보기 마스킹 정책 (계획 §3.5 — 스키마에 선포함) / preview masking policy, reserved by plan §3.5
    masking_policy: Mapped[str | None] = mapped_column(String(32))
    # 게이트용 TOP-N 샘플 통계 — 컬럼 단위 캐시, 전수 distinct_count와 축이 다르다(표본)
    # / TOP-N sample stats cached per column for the join gate; a sample, not the full count
    sample_rows: Mapped[int | None] = mapped_column(Integer)
    sample_distinct: Mapped[int | None] = mapped_column(Integer)
    sampled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint("object_id", "name", name="uq_columns_object_name"),
    )


class CatalogConstraint(Base):
    """PK / UQ / FK constraint captured in a snapshot. / 스냅샷에 담긴 제약."""

    __tablename__ = "constraints"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(
        ForeignKey("snapshots.id", ondelete="CASCADE", name="fk_constraints_snapshot_id")
    )
    type: Mapped[str] = mapped_column(String(4))
    name: Mapped[str] = mapped_column(String(128))

    __table_args__ = (
        CheckConstraint("type IN ('pk', 'uq', 'fk')", name="ck_constraints_type"),
        Index("ix_constraints_snapshot", "snapshot_id"),
    )


class FkColumn(Base):
    """Column pair of an FK constraint. / FK 제약의 컬럼 페어."""

    __tablename__ = "fk_columns"

    constraint_id: Mapped[int] = mapped_column(
        ForeignKey("constraints.id", ondelete="CASCADE", name="fk_fk_columns_constraint_id"),
        primary_key=True,
    )
    src_column_id: Mapped[int] = mapped_column(
        ForeignKey("columns.id", ondelete="CASCADE", name="fk_fk_columns_src_column_id"),
        primary_key=True,
    )
    tgt_column_id: Mapped[int] = mapped_column(
        ForeignKey("columns.id", ondelete="CASCADE", name="fk_fk_columns_tgt_column_id"),
        primary_key=True,
    )


class ViewJoin(Base):
    """JOIN condition extracted from a view — top relation signal (계획 §2.1). / 뷰에서 추출한 JOIN 조건."""

    __tablename__ = "view_joins"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(
        ForeignKey("snapshots.id", ondelete="CASCADE", name="fk_view_joins_snapshot_id")
    )
    view_object_id: Mapped[int] = mapped_column(
        ForeignKey("objects.id", ondelete="CASCADE", name="fk_view_joins_view_object_id")
    )
    left_column_id: Mapped[int] = mapped_column(
        ForeignKey("columns.id", ondelete="CASCADE", name="fk_view_joins_left_column_id")
    )
    right_column_id: Mapped[int] = mapped_column(
        ForeignKey("columns.id", ondelete="CASCADE", name="fk_view_joins_right_column_id")
    )
    join_type: Mapped[str] = mapped_column(String(16))
    # 같은 뷰 안에서 같은 페어가 반복 등장한 횟수 / repetitions of the pair within one view
    occurrence_count: Mapped[int] = mapped_column(Integer)

    __table_args__ = (
        Index("ix_view_joins_snapshot_view", "snapshot_id", "view_object_id"),
        Index("ix_view_joins_columns", "left_column_id", "right_column_id"),
    )


class ViewDep(Base):
    """Object-level dependency of a view (sys.sql_expression_dependencies). / 뷰의 객체 수준 의존성."""

    __tablename__ = "view_deps"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(
        ForeignKey("snapshots.id", ondelete="CASCADE", name="fk_view_deps_snapshot_id")
    )
    view_object_id: Mapped[int] = mapped_column(
        ForeignKey("objects.id", ondelete="CASCADE", name="fk_view_deps_view_object_id")
    )
    # NULL = 미해석 참조 (referenced_id IS NULL) — Phase 2로 이관 / NULL = unresolved, deferred to Phase 2
    referenced_object_id: Mapped[int | None] = mapped_column(
        ForeignKey("objects.id", name="fk_view_deps_referenced_object_id")
    )
    # 미해석·크로스 DB 참조의 텍스트 식별자 보존 — 없으면 Phase 2에서 재해석 불가
    # textual identity for unresolved / cross-DB refs; Phase 2 cannot re-resolve without it
    referenced_database: Mapped[str | None] = mapped_column(String(128))
    referenced_name: Mapped[str | None] = mapped_column(String(256))
    referenced_column: Mapped[str | None] = mapped_column(String(128))
    is_resolved: Mapped[bool] = mapped_column(Boolean)

    __table_args__ = (
        Index("ix_view_deps_snapshot_view", "snapshot_id", "view_object_id"),
    )


class ViewLineageFlat(Base):
    """Recursively flattened view→base-table lineage — the only lineage table the UI reads. / 재귀 전개된 lineage — UI가 읽는 유일한 lineage 테이블."""

    __tablename__ = "view_lineage_flat"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(
        ForeignKey("snapshots.id", ondelete="CASCADE", name="fk_vlf_snapshot_id")
    )
    view_object_id: Mapped[int] = mapped_column(
        ForeignKey("objects.id", ondelete="CASCADE", name="fk_vlf_view_object_id")
    )
    view_column: Mapped[str] = mapped_column(String(128))
    # cycle / depth_exceeded로 중단된 행은 base 없음 / NULL when expansion stopped by flag
    base_object_id: Mapped[int | None] = mapped_column(
        ForeignKey("objects.id", name="fk_vlf_base_object_id")
    )
    base_column: Mapped[str | None] = mapped_column(String(128))
    depth: Mapped[int] = mapped_column(Integer)
    # direct: 1:1 / set: 집합 수준 (Phase 1 기본) / derived: 계산식 — 관계 추론 제외
    mapping_kind: Mapped[str] = mapped_column(String(8))
    # 해석 중단 사유 (계획 §1.3) / why expansion stopped
    flag: Mapped[str | None] = mapped_column(String(16))

    __table_args__ = (
        CheckConstraint(
            "mapping_kind IN ('direct', 'set', 'derived')", name="ck_vlf_mapping_kind"
        ),
        CheckConstraint(
            "flag IN ('cycle', 'depth_exceeded')", name="ck_vlf_flag"
        ),
        Index("ix_vlf_snapshot_view", "snapshot_id", "view_object_id"),
        Index("ix_vlf_base_object", "base_object_id"),
    )
