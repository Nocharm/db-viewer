"""FastAPI app factory. / FastAPI 앱 팩토리."""

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from fastapi import Depends

from app.api import (
    admin,
    ai,
    columns,
    ingest,
    join_check,
    keys,
    me,
    objects,
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
    app.include_router(join_check.router, dependencies=user_gate)
    app.include_router(views.router, dependencies=user_gate)
    app.include_router(snapshots.router, dependencies=user_gate)
    app.include_router(columns.router, dependencies=user_gate)
    app.include_router(validate.router, dependencies=user_gate)
    app.include_router(relations.router, dependencies=user_gate)
    app.include_router(scan.router, dependencies=user_gate)
    app.include_router(ai.router, dependencies=user_gate)
    app.include_router(keys.router, dependencies=user_gate)
    # me는 토큰만, admin은 자체 sysadmin 게이트 / me needs only a token
    app.include_router(me.router)
    app.include_router(admin.router)

    # 승인된 에러 규약: {"error": {code, message, context}} / approved error envelope
    @app.exception_handler(StarletteHTTPException)
    async def handle_http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        detail = exc.detail if isinstance(exc.detail, dict) else {"message": str(exc.detail)}
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.status_code, **detail}},
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

    return app


app = create_app()
