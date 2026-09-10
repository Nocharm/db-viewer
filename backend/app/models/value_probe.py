"""Value probe jobs, planned targets and hits. / 값 추적 잡·대상·히트.

계획을 행으로 남긴다 — 진행률·heavy 목록·선택 실행·재시작 복원이 전부 대상 행에서 나온다.
값은 잡 행에 저장되므로 조회는 요청자 본인(또는 sysadmin)에게만 연다 (api/value_probe.py).
"""

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    false,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.catalog import Base


class ValueProbeJob(Base):
    """값 하나에 대한 추적 요청 1건 / one probe request."""

    __tablename__ = "value_probe_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    data_source_id: Mapped[int] = mapped_column(Integer)
    snapshot_id: Mapped[int] = mapped_column(Integer)
    value: Mapped[str] = mapped_column(String(100))
    mode: Mapped[str] = mapped_column(String(12))
    hint: Mapped[str | None] = mapped_column(String(128))
    # 요청 스키마 목록 JSON — 재시도·"나머지 스키마로 계속"의 기준 / JSON list of schemas
    schemas: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16))
    progress_total: Mapped[int] = mapped_column(Integer)
    progress_done: Mapped[int] = mapped_column(Integer)
    cancel_requested: Mapped[bool] = mapped_column(Boolean, server_default=false())
    # 연관 뷰 옵션 — 선택 스키마 밖에서 lineage로 찾아 자동 포함한 스키마와, 정책(숨김·허용 목록)
    # 때문에 제외한 뷰 목록(JSON). 실행 직전 게이트 재검사가 related_schemas까지 본다.
    # / related-view option: auto-included schemas and policy-skipped views (JSON)
    include_related_views: Mapped[bool] = mapped_column(Boolean, server_default=false())
    related_schemas: Mapped[str] = mapped_column(Text, server_default="[]")
    related_skipped: Mapped[str] = mapped_column(Text, server_default="[]")
    current_qname: Mapped[str | None] = mapped_column(String(261))
    triggered_by: Mapped[str] = mapped_column(String(64))
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(
            "status IN ('queued', 'running', 'done', 'failed', 'cancelled')",
            name="ck_value_probe_jobs_status",
        ),
        CheckConstraint(
            "mode IN ('normalized', 'exact', 'contains')", name="ck_value_probe_jobs_mode"
        ),
    )


class ValueProbeTarget(Base):
    """플래너가 뽑은 객체 1건 — 프로브 쿼리 1개에 대응 / one planned probe query."""

    __tablename__ = "value_probe_targets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_id: Mapped[int] = mapped_column(
        ForeignKey("value_probe_jobs.id", ondelete="CASCADE",
                   name="fk_value_probe_targets_job_id")
    )
    # objects.id(서비스 PK) — 미리보기 딥링크가 이 id로 연다 / service PK for the preview link
    object_id: Mapped[int] = mapped_column(Integer)
    qname: Mapped[str] = mapped_column(String(261))
    object_type: Mapped[str] = mapped_column(String(5))
    # ProbeColumn.to_dict() 목록 JSON / JSON list of ProbeColumn dicts
    columns: Mapped[str] = mapped_column(Text)
    tier: Mapped[str] = mapped_column(String(5))
    # heavy로 분류된 이유 — 승격 뒤에도 남겨 건수 쿼리 생략 판단에 쓴다 / kept after promotion
    heavy_reason: Mapped[str | None] = mapped_column(String(32))
    rank: Mapped[int] = mapped_column(Integer)
    est_rows: Mapped[int | None] = mapped_column(BigInteger)
    status: Mapped[str] = mapped_column(String(8))
    error: Mapped[str | None] = mapped_column(String(200))

    __table_args__ = (
        CheckConstraint("tier IN ('auto', 'heavy')", name="ck_value_probe_targets_tier"),
        CheckConstraint(
            "status IN ('pending', 'done', 'skipped', 'error', 'timeout')",
            name="ck_value_probe_targets_status",
        ),
        Index("ix_value_probe_targets_job_rank", "job_id", "rank"),
    )


class ValueProbeHit(Base):
    """맞은 컬럼 1건 / one matched column."""

    __tablename__ = "value_probe_hits"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_id: Mapped[int] = mapped_column(
        ForeignKey("value_probe_jobs.id", ondelete="CASCADE", name="fk_value_probe_hits_job_id")
    )
    target_id: Mapped[int] = mapped_column(
        ForeignKey("value_probe_targets.id", ondelete="CASCADE",
                   name="fk_value_probe_hits_target_id")
    )
    object_id: Mapped[int] = mapped_column(Integer)
    object_type: Mapped[str] = mapped_column(String(5))
    qname: Mapped[str] = mapped_column(String(261))
    column_name: Mapped[str] = mapped_column(String(128))
    # NULL = 건수 생략(heavy) / NULL when the count query was skipped
    match_count: Mapped[int | None] = mapped_column(Integer)
    count_capped: Mapped[bool] = mapped_column(Boolean, server_default=false())
    # 실제로 맞은 변형값 — 미리보기 필터에 이 값을 넣는다 / the variant that matched
    matched_variant: Mapped[str] = mapped_column(String(100))

    __table_args__ = (Index("ix_value_probe_hits_job", "job_id"),)
