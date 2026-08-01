"""FastAPI app factory. / FastAPI 앱 팩토리."""

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api import ai, columns, ingest, objects, relations, scan, snapshots, validate, views


def create_app() -> FastAPI:
    app = FastAPI(title="db-viewer")
    app.include_router(ingest.router)
    app.include_router(objects.router)
    app.include_router(views.router)
    app.include_router(snapshots.router)
    app.include_router(columns.router)
    app.include_router(validate.router)
    app.include_router(relations.router)
    app.include_router(scan.router)
    app.include_router(ai.router)

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
