"""Data source registry API. / 소스 등록·수정·연결 테스트 (sysadmin + 비밀번호 게이트)."""

import logging
import time
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError, DisconnectionError, IntegrityError
from sqlalchemy.exc import TimeoutError as SATimeoutError
from sqlalchemy.orm import Session

from app.auth import require_preview_admin, require_sysadmin
from app.db import get_db
from app.models import AuditLog, DataSource, PreviewAllowlist, SchemaCategory, Snapshot
from app.sources.connection import clear_sa_engine, get_sa_engine
from app.sources.crypto import CryptoNotConfigured, encrypt_secret, is_crypto_configured
from app.sources.registry import UnsupportedSource, get_source, list_sources

logger = logging.getLogger(__name__)

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


class SourceUpdateRequest(BaseModel):
    """SourceCreateRequest를 상속하지 않는다 — 독립 모델.

    상속으로 필수 필드를 옵셔널로 좁히면(부모가 요구하는 필드를 자식이 안 요구) LSP
    위반이라 pyright가 잡는다. engine은 여기 없다 — 만든 뒤 엔진을 바꾸는 건 host/port/
    file_path 등 나머지 필드 조합을 통째로 갈아치우는 변경이라 부분수정으로 안전하게
    표현할 수 없다(엔진을 바꾸려면 소스를 새로 만든다).
    """

    name: str | None = None
    host: str | None = None
    port: int | None = None
    database: str | None = None
    username: str | None = None
    password: str | None = None
    file_path: str | None = None
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
    """관리 API 전용 조회 — get_source와 달리 비활성 소스도 통과시킨다.

    수정·삭제는 비활성 소스를 다시 켜거나 정리하는 용도로도 쓰이므로, 여기서
    is_enabled를 막으면 한번 끈 소스를 API로 되살릴 방법이 없어진다.
    """
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
    try:
        db.flush()
    except IntegrityError as e:
        # 이름 UNIQUE 위반이 통상 원인이고, PK 충돌도 같은 예외로 온다 — 잡지 않으면
        # 운영자가 원인 없는 500만 보고 재시도한다. 드라이버 원문은 로그에만 남긴다
        # (test_data_source 502 핸들러와 같은 관용).
        # / a duplicate name is the usual cause; an unhandled flush would surface as a
        #   bare 500 with nothing actionable in it
        db.rollback()
        error_type = type(e).__name__
        # extra 키는 source_name — 'name'은 LogRecord 예약어라 덮어쓰면 로깅이 KeyError로
        # 죽는다(원래 예외를 가려버린다) / 'name' is a reserved LogRecord attribute
        logger.warning("data source create conflicted",
                       extra={"source_name": req.name.strip(),
                              "error_type": error_type},
                       exc_info=True)
        raise HTTPException(409, {
            # 이름 중복이 통상이지만 PK 충돌도 같은 예외라 원인을 단정하지 않는다 —
            # 조치 가능한 첫 수(이름 바꾸기)와 다음 확인처(로그)를 함께 준다
            "message": "could not register this data source — it conflicts with an "
                       "existing row (a duplicate name is the usual cause). Pick another "
                       "name; if the name is new, check the backend log for the "
                       "violated constraint.",
            "context": {"name": req.name.strip(), "error_type": error_type},
        }) from e
    db.add(AuditLog(action="source_create", detail=f"{source.name} ({source.engine})",
                    requested_by=admin, requested_at=now))
    return _serialize(source)


@router.patch("/{source_id}", dependencies=[Depends(require_preview_admin)])
def update_data_source(
    source_id: int, req: SourceUpdateRequest, db: Session = Depends(get_db),
    admin: str = Depends(require_sysadmin),
) -> dict:
    source = _get_editable(db, source_id)
    if req.name is not None:
        source.name = req.name.strip()
    for field in ("host", "port", "database", "username", "file_path", "is_enabled"):
        value = getattr(req, field)
        if value is not None:
            setattr(source, field, value)
    if req.password:
        try:
            source.password_enc = encrypt_secret(req.password)
        except CryptoNotConfigured as e:
            raise HTTPException(503, {"message": str(e), "context": {}}) from e
    source.updated_at = datetime.now(UTC)
    # 낡은 접속정보(host·비밀번호·파일경로)로 계속 붙지 않게 캐시를 비운다 (이월 4)
    clear_sa_engine(source.id)
    db.add(AuditLog(action="source_update", detail=source.name,
                    requested_by=admin, requested_at=source.updated_at))
    return _serialize(source)


@router.delete("/{source_id}", dependencies=[Depends(require_preview_admin)])
def delete_data_source(
    source_id: int, db: Session = Depends(get_db),
    admin: str = Depends(require_sysadmin),
) -> dict:
    """스냅샷 또는 정책 행(허용목록·카테고리)이 있으면 거부한다 (이월 2).

    preview_allowlist·schema_categories는 설계상 data_source_id가 FK가 아니다 — 지우면
    고아 행이 남고, id가 재사용되는 환경(테스트의 SQLite 등)에서는 낡은 허용이 새
    소스에 그대로 적용될 수 있다. 되돌릴 수 없는 삭제는 이 셋이 전부 비었을 때만.
    """
    source = _get_editable(db, source_id)
    snapshots = db.execute(
        select(func.count()).select_from(Snapshot)
        .where(Snapshot.data_source_id == source_id)
    ).scalar_one()
    allowlist_rows = db.execute(
        select(func.count()).select_from(PreviewAllowlist)
        .where(PreviewAllowlist.data_source_id == source_id)
    ).scalar_one()
    category_rows = db.execute(
        select(func.count()).select_from(SchemaCategory)
        .where(SchemaCategory.data_source_id == source_id)
    ).scalar_one()
    if snapshots or allowlist_rows or category_rows:
        raise HTTPException(409, {
            "message": "this source still has collected snapshots or schema policy "
                       "rows (preview allowlist / category) — disable it instead of "
                       "deleting, or remove those rows first",
            "context": {"source_id": source_id, "snapshots": snapshots,
                        "preview_allowlist": allowlist_rows,
                        "schema_categories": category_rows}})
    name = source.name
    db.delete(source)
    clear_sa_engine(source_id)  # 이월 4 — 낡은 캐시가 삭제된 소스를 계속 서빙하지 않게
    db.add(AuditLog(action="source_delete", detail=name, requested_by=admin,
                    requested_at=datetime.now(UTC)))
    return {"id": source_id, "removed": True}


@router.post("/{source_id}/test")
def test_data_source(source_id: int, db: Session = Depends(get_db)) -> dict:
    """실제로 붙은 DB의 이름·버전을 회신한다 — 흔한 컨테이너명 오접속을 눈으로 잡는다.

    get_source(allow_disabled=True)를 거친다 — 존재하지 않으면(404) 걸러지지만,
    비활성 소스는 여기서 막지 않는다: "자격증명을 고치고 → 테스트로 확인하고 →
    재활성화"가 정상 운영 순서라, 테스트까지 막으면 확인 없이 먼저 켜야 하는 반대
    순서를 강제하게 된다. 라이브 연결이 실제로 걸리는 미리보기·수집 트리거는 이
    예외 없이 여전히 막힌다(get_source 기본값).
    """
    source = get_source(db, source_id, allow_disabled=True)
    if source.access_mode != "direct":
        raise HTTPException(400, {"message": "this source is served through n8n",
                                  "context": {"source_id": source_id}})
    if source.engine == "postgres":
        probe = "SELECT version() AS version, current_database() AS database"
    elif source.engine == "sqlite":
        probe = "SELECT sqlite_version() AS version, 'main' AS database"
    else:
        # access_mode='direct'인데 엔진이 postgres/sqlite가 아닌 행 — API로는 못 만들지만
        # DB를 직접 편집하면 도달 가능. 붙어보지도 않고 여기서 명확히 거부한다
        raise HTTPException(400, {"message": "no connection test for this engine",
                                  "context": {"source_id": source_id,
                                              "engine": source.engine}})
    started = time.monotonic()
    now = datetime.now(UTC)
    try:
        with get_sa_engine(source).connect() as conn:
            row = conn.execute(text(probe)).mappings().one()
    except (CryptoNotConfigured, UnsupportedSource) as e:
        # 소스 장애가 아니라 이쪽 설정 문제(키 교체·미설정) 또는 조합 자체가 지원 안 됨 —
        # 메시지가 고정 문구뿐이라 str(e)를 그대로 노출해도 자격증명이 섞이지 않는다
        # (objects.py와 같은 관용). last_error도 갱신해 콘솔이 "마지막으로 성공"인 채
        # 낡지 않게 한다 — DBAPIError 분기와 같은 이유(이 함수에서 이미 한 번 겪은 버그)
        error_type = type(e).__name__
        logger.warning("source connection test misconfigured",
                       extra={"source_id": source.id, "error_type": error_type})
        source.last_error = error_type
        source.updated_at = now
        db.commit()
        raise HTTPException(503, {"message": str(e),
                                  "context": {"source": source.name}}) from e
    except (DBAPIError, SATimeoutError, DisconnectionError) as e:
        # 드라이버 원문(계정명·파일경로 등)은 절대 응답에 싣지 않는다 — 종류만.
        # 전문은 로그에만 exc_info=True로 남긴다 (objects.py 502 핸들러와 같은 관용,
        # Task 7 보안 지적 재발 방지)
        error_type = type(e).__name__
        logger.warning("source connection test failed",
                       extra={"source_id": source.id, "error_type": error_type},
                       exc_info=True)
        source.last_error = error_type
        source.updated_at = now
        # get_db는 라우트가 던진 예외를 받으면 세션을 롤백한다 — 실패 기록이 그
        # 롤백에 같이 쓸려가지 않도록 여기서 먼저 커밋해 둔다
        db.commit()
        raise HTTPException(502, {
            "message": "could not connect to the data source",
            "context": {"source_id": source_id, "host": source.host,
                        "database": source.database, "error_type": error_type},
        }) from e
    source.last_ok_at = now
    source.last_error = None
    source.updated_at = now
    return {"ok": True, "version": row["version"], "database": row["database"],
            "latency_ms": round((time.monotonic() - started) * 1000, 1)}
