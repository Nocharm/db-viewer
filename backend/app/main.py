"""FastAPI app factory. / FastAPI 앱 팩토리."""

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import select
from starlette.exceptions import HTTPException as StarletteHTTPException

from fastapi import Depends

from app.adapters.llm_ai import AiUnavailableError
from app.adapters.n8n_query import N8nQueryError
from app.api import (
    admin,
    ai,
    categories,
    collect,
    columns,
    erd,
    ingest,
    join_check,
    join_preview,
    keys,
    me,
    objects,
    pg_admin,
    pg_source,
    relations,
    scan,
    snapshots,
    validate,
    views,
)
from app.auth import require_ingest_access, require_whitelisted


def create_app() -> FastAPI:
    app = FastAPI(title="db-viewer")

    # 인증 면제 헬스체크 — compose healthcheck·배포 검증용 (bpm 런북 패턴)
    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok"}
    # ingest는 머신 호출(n8n) — API 키 게이트 / machine gate for n8n
    app.include_router(ingest.router, dependencies=[Depends(require_ingest_access)])
    # 조회·검증·AI는 화이트리스트 사용자 게이트 / whitelist gate for humans
    user_gate = [Depends(require_whitelisted)]
    app.include_router(objects.router, dependencies=user_gate)
    app.include_router(erd.router, dependencies=user_gate)
    app.include_router(join_check.router, dependencies=user_gate)
    app.include_router(join_preview.router, dependencies=user_gate)
    app.include_router(views.router, dependencies=user_gate)
    app.include_router(snapshots.router, dependencies=user_gate)
    app.include_router(columns.router, dependencies=user_gate)
    app.include_router(validate.router, dependencies=user_gate)
    app.include_router(relations.router, dependencies=user_gate)
    app.include_router(scan.router, dependencies=user_gate)
    app.include_router(ai.router, dependencies=user_gate)
    app.include_router(keys.router, dependencies=user_gate)
    app.include_router(categories.router, dependencies=user_gate)
    app.include_router(pg_source.router, dependencies=user_gate)
    # 연결 관리는 자체 sysadmin + 비밀번호 게이트 / its own gates, like admin
    app.include_router(pg_admin.router)
    # me는 토큰만, admin은 자체 sysadmin 게이트 / me needs only a token
    app.include_router(me.router)
    app.include_router(admin.router)
    # 수집 트리거는 관리 작업 — 라우터 자체가 sysadmin 게이트를 갖는다
    app.include_router(collect.router)

    # 승인된 에러 규약: {"error": {code, message, context}} / approved error envelope
    @app.exception_handler(StarletteHTTPException)
    async def handle_http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        detail = exc.detail if isinstance(exc.detail, dict) else {"message": str(exc.detail)}
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.status_code, **detail}},
        )

    # AI 프로바이더 장애는 게이트웨이 오류로 — 조용한 폴백 없음 (스펙 §에러 처리)
    @app.exception_handler(AiUnavailableError)
    async def handle_ai_unavailable(request: Request, exc: AiUnavailableError) -> JSONResponse:
        return JSONResponse(
            status_code=502,
            content={"error": {"code": 502, "message": str(exc), "context": exc.context}},
        )

    # W2(n8n) 실행 실패도 게이트웨이 오류로 — 원인 문자열이 화면까지 가야 진단이 된다
    # (조용히 빈 표로 보이면 워크플로 비활성·자격증명 미연결을 구분할 수 없다)
    @app.exception_handler(N8nQueryError)
    async def handle_n8n_query_error(request: Request, exc: N8nQueryError) -> JSONResponse:
        return JSONResponse(
            status_code=502,
            content={"error": {"code": 502, "message": str(exc),
                               "context": {"executor": "n8n W2"}}},
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={"error": {
                "code": 422, "message": "request validation failed",
                "context": jsonable_encoder(exc.errors()[:5]),
            }},
        )

    @app.on_event("startup")
    def fail_orphaned_ai_jobs() -> None:
        """재기동으로 고아가 된 AI 잡 정리 — 실행 주체(BackgroundTasks)가 프로세스와 함께 죽는다."""
        from app.db import get_session_factory
        from app.models import AiJob

        with get_session_factory()() as db:
            for job in db.execute(
                select(AiJob).where(AiJob.status.in_(["queued", "running"]))
            ).scalars():
                job.status = "failed"
                job.error = "interrupted by restart"
            db.commit()

    return app


app = create_app()
