"""T3 exploratory scan jobs. / 탐색 스캔 백그라운드 작업 (계획 Phase 4)."""

from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.catalog import Base


class ScanJob(Base):
    """One column vs. all candidates — background with progress polling. / 한 컬럼 전수 탐색 작업."""

    __tablename__ = "scan_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    src_object: Mapped[str] = mapped_column(String(261))
    src_column: Mapped[str] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(16))
    progress_total: Mapped[int] = mapped_column(Integer)
    progress_done: Mapped[int] = mapped_column(Integer)
    night_only: Mapped[bool] = mapped_column(Boolean)
    # 야간 옵션 — 이 시각 전에는 기동하지 않는다 / job may not start before this
    not_before: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    triggered_by: Mapped[str] = mapped_column(String(64))
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(
            "status IN ('queued', 'running', 'done', 'failed')", name="ck_scan_jobs_status"
        ),
    )


class CollectJob(Base):
    """Button-triggered catalog collection with stage progress. / 버튼 트리거 수집 잡."""

    __tablename__ = "collect_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # step: 단계별 수동 진행 / full: 원버튼 전체 파이프라인
    mode: Mapped[str] = mapped_column(String(8))
    stage: Mapped[str] = mapped_column(String(20))
    # 스냅샷 삭제와 수명 분리 — FK 없이 참조만 / plain reference, survives snapshot deletes
    snapshot_id: Mapped[int | None] = mapped_column(Integer)
    # ingest 응답 counts를 JSON 문자열로 보존 / ingest counts as a JSON string
    counts: Mapped[str | None] = mapped_column(Text)
    triggered_by: Mapped[str] = mapped_column(String(64))
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(
            "stage IN ('catalog_running', 'catalog_done', 'deps_running', 'ready', 'failed')",
            name="ck_collect_jobs_stage",
        ),
        CheckConstraint("mode IN ('step', 'full')", name="ck_collect_jobs_mode"),
    )


class ScanResult(Base):
    """Ranked scan hits — sample pass plus full recheck. / 스캔 상위 결과 (샘플 + 풀 재검증)."""

    __tablename__ = "scan_results"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_id: Mapped[int] = mapped_column(
        ForeignKey("scan_jobs.id", ondelete="CASCADE", name="fk_scan_results_job_id")
    )
    tgt_object: Mapped[str] = mapped_column(String(261))
    tgt_column: Mapped[str] = mapped_column(String(128))
    containment_sample: Mapped[float] = mapped_column(Float)
    # 샘플 결과는 확정으로 쓰지 않는다 — 풀 재검증 값만 판정에 사용 (계획 §4)
    containment_full: Mapped[float | None] = mapped_column(Float)
    cardinality: Mapped[str | None] = mapped_column(String(8))
    rank: Mapped[int] = mapped_column(Integer)

    __table_args__ = (Index("ix_scan_results_job", "job_id"),)
