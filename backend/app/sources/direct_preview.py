"""Direct-connect table preview. / 직결 소스 테이블 미리보기 실행기.

N8nTablePreview와 같은 시그니처를 갖는다 — 호출부(api/objects.py)가 어느 쪽인지 몰라도 된다.
"""

import base64
import logging
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Engine, text

from app.sources.preview_sql import build_preview_sql

logger = logging.getLogger(__name__)


def _to_jsonable(value: object) -> object:
    """JSON으로 못 나가는 DB 타입을 문자열화 — 미리보기는 눈으로 보는 용도다."""
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, Decimal):
        # float()은 정밀도를 잃고 NUMERIC 'NaN'은 float('nan')이 돼 Starlette JSONResponse
        # (allow_nan=False)를 500으로 터뜨린다 — str()은 두 문제를 한 번에 피한다
        return str(value)
    if isinstance(value, bytes | bytearray | memoryview):
        return base64.b64encode(bytes(value)).decode()
    return value


class DirectTablePreview:
    """소스 엔진에 SELECT 하나를 날린다 — 읽기 전용, 캐시 없음."""

    def __init__(self, sa_engine: Engine) -> None:
        self._engine = sa_engine

    def rows(
        self, qname: str, columns: list[dict], limit: int,
        filters: list[dict] | None = None,
    ) -> list[dict]:
        schema, table = qname.split(".", 1)
        names = [column["name"] for column in columns]
        sql, params = build_preview_sql(
            schema, table, names, filters or [], limit, set(names),
        )
        with self._engine.connect() as conn:
            result = conn.execute(text(sql), params)
            rows = [
                {key: _to_jsonable(value) for key, value in row._mapping.items()}
                for row in result
            ]
        logger.info("direct preview executed",
                    extra={"object": qname, "rows": len(rows),
                           "filters": len(filters or [])})
        return rows
