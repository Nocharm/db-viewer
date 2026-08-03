"""Ingest payload schemas — the fixture format IS the contract. / ingest 페이로드 스키마 — 픽스처 포맷이 곧 계약."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class RawObject(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    object_id: int
    # 'schema'는 BaseModel 예약 이름과 충돌해 alias 사용 / alias avoids BaseModel name clash
    schema_name: str = Field(alias="schema")
    name: str
    type: Literal["table", "view"]
    row_count: int | None = None


class RawColumn(BaseModel):
    object_id: int
    name: str
    ordinal: int
    data_type: str
    max_length: int
    is_nullable: bool
    is_computed: bool


class RawKeyConstraint(BaseModel):
    name: str
    type: Literal["pk", "uq"]
    object_id: int
    columns: list[str]


class RawFkPair(BaseModel):
    src_column: str
    tgt_column: str


class RawForeignKey(BaseModel):
    name: str
    src_object_id: int
    tgt_object_id: int
    columns: list[RawFkPair]


class RawViewDefinition(BaseModel):
    object_id: int
    definition: str | None


class CatalogPayload(BaseModel):
    """POST /api/ingest/catalog body — n8n W1 raw dump. / n8n W1이 보내는 원본 덤프."""

    source_db: str
    collected_at: datetime
    objects: list[RawObject]
    columns: list[RawColumn]
    key_constraints: list[RawKeyConstraint] = []
    foreign_keys: list[RawForeignKey] = []
    view_definitions: list[RawViewDefinition] = []
    # 버튼 트리거 수집 잡 연동 — n8n이 webhook body를 그대로 되돌려준다 / echoed from the trigger
    collect_job_id: int | None = None
    # 분할 전송 — 1/1이면 단일 페이로드(기존 계약) / chunked transport, 1/1 = legacy single
    chunk_index: int = Field(default=1, ge=1)
    chunk_total: int = Field(default=1, ge=1)


class RawDep(BaseModel):
    view_object_id: int
    referenced_object_id: int | None
    referenced_database: str | None = None
    referenced_name: str | None = None
    referenced_column: str | None = None
    is_resolved: bool


class RawUnresolvedObject(BaseModel):
    object_id: int
    reason: str


class ViewDepsPayload(BaseModel):
    """POST /api/ingest/view-deps body. / 뷰 의존성 적재 페이로드."""

    snapshot_id: int
    deps: list[RawDep]
    unresolved_objects: list[RawUnresolvedObject] = []
    collect_job_id: int | None = None
    # 분할 수집 — 마지막 청크에서만 lineage·파싱·ready 전환 / finalize on the last chunk only
    chunk_index: int = Field(default=1, ge=1)
    chunk_total: int = Field(default=1, ge=1)
