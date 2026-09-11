"""Direct-connect value prober. / 직결 소스 값 추적 실행기.

N8nValueProber와 같은 시그니처 — 러너(services/value_probe.py)가 어느 쪽인지 몰라도 된다.
"""

import logging

from sqlalchemy import Engine, text

from app.domain.value_probe import ProbeColumn
from app.sources.direct_preview import _to_jsonable
from app.sources.preview_sql import build_count_sql, build_probe_sql

logger = logging.getLogger(__name__)


class DirectValueProber:
    """객체당 프로브 1개, 히트 컬럼당 건수 1개 — 읽기 전용."""

    def __init__(self, sa_engine: Engine) -> None:
        self._engine = sa_engine

    def probe(self, schema: str, name: str, columns: list[ProbeColumn]) -> list[dict]:
        specs = [column.to_dict() for column in columns]
        sql, params = build_probe_sql(
            schema, name, specs, {column.name for column in columns}, self._engine.dialect.name,
        )
        with self._engine.connect() as conn:
            result = conn.execute(text(sql), params)
            rows = [
                {key: _to_jsonable(value) for key, value in row._mapping.items()}
                for row in result
            ]
        logger.info("direct value probe executed",
                    extra={"object": f"{schema}.{name}", "columns": len(columns),
                           "hit": bool(rows)})
        return rows

    def count(self, schema: str, name: str, column: ProbeColumn, cap: int) -> int:
        sql, params = build_count_sql(
            schema, name, column.to_dict(), {column.name}, cap, self._engine.dialect.name,
        )
        with self._engine.connect() as conn:
            return int(conn.execute(text(sql), params).scalar_one())
