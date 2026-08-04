"""Phase 3 relation state, validation history, audit. / 관계 상태·검증 이력·감사 로그.

식별자는 텍스트(schema.table.column) — 스냅샷 교체·삭제에도 이력이 살아남는다.
Textual identity survives snapshot churn and cascade deletes (계획 DDL의
column_id FK 대신 채택한 결정 — PROGRESS 참조).
"""

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Float,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.catalog import Base


class Relation(Base):
    """Inferred/confirmed relation state. / 추론·확정 관계의 현재 상태."""

    __tablename__ = "relations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    src_object: Mapped[str] = mapped_column(String(261))
    src_column: Mapped[str] = mapped_column(String(128))
    tgt_object: Mapped[str] = mapped_column(String(261))
    tgt_column: Mapped[str] = mapped_column(String(128))
    # candidate: 제안만 / validated: T2 통과 / confirmed: 사용자 확정 / rejected: 기각
    status: Mapped[str] = mapped_column(String(16))
    origin: Mapped[str] = mapped_column(String(16))
    confidence: Mapped[float | None] = mapped_column(Float)
    cardinality: Mapped[str | None] = mapped_column(String(8))
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # LLM 판정 근거 — 수용/기각 공용, 규칙·사용자 기원은 NULL / judge reason, AI rows only
    reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(
            "status IN ('candidate', 'validated', 'confirmed', 'rejected')",
            name="ck_relations_status",
        ),
        CheckConstraint(
            "origin IN ('rule', 'view_join', 'ai', 'user')", name="ck_relations_origin"
        ),
        UniqueConstraint(
            "src_object", "src_column", "tgt_object", "tgt_column",
            name="uq_relations_pair",
        ),
    )


class JoinValidationHistory(Base):
    """T2 observation log — the source of confidence (계획 §3.4). / T2 관측 이력."""

    __tablename__ = "join_validation_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    src_object: Mapped[str] = mapped_column(String(261))
    src_column: Mapped[str] = mapped_column(String(128))
    tgt_object: Mapped[str] = mapped_column(String(261))
    tgt_column: Mapped[str] = mapped_column(String(128))
    containment: Mapped[float] = mapped_column(Float)
    orphan_count: Mapped[int] = mapped_column(Integer)
    cardinality: Mapped[str] = mapped_column(String(8))
    src_row_count: Mapped[int] = mapped_column(BigInteger)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    triggered_by: Mapped[str] = mapped_column(String(64))

    __table_args__ = (
        Index("ix_jvh_pair", "src_object", "src_column", "tgt_object", "tgt_column"),
    )


class AiSummary(Base):
    """Cached AI table summary — ERD tooltip source (계획 §5.1-3). / AI 요약 캐시."""

    __tablename__ = "ai_summaries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    object_qname: Mapped[str] = mapped_column(String(261))
    summary: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint("object_qname", name="uq_ai_summaries_qname"),
    )


class AiEmbedding(Base):
    """Table embedding for semantic search. / 의미 검색용 테이블 임베딩 (사이클2 §3)."""

    __tablename__ = "ai_embeddings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    object_qname: Mapped[str] = mapped_column(String(261))
    model: Mapped[str] = mapped_column(String(128))
    # JSON 배열 텍스트 — pgvector 없이 파이썬 코사인 (2,342×768차원 ≈ 수십 ms)
    vector: Mapped[str] = mapped_column(Text)
    # 원문 해시 — 변경분만 재임베딩 / re-embed only when source text changes
    source_hash: Mapped[str] = mapped_column(String(64))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint("object_qname", name="uq_ai_embeddings_qname"),
    )


class AuditLog(Base):
    """Raw-value exposure audit — preview is the only exit point (계획 §3.5). / 원본 값 반출 감사."""

    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    action: Mapped[str] = mapped_column(String(32))
    detail: Mapped[str] = mapped_column(String(600))
    requested_by: Mapped[str] = mapped_column(String(64))
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
