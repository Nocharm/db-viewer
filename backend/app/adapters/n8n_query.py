"""Live query execution via the n8n W2 webhook. / n8n 경유 live 검증·미리보기 실행기.

계획 §4.3의 pyodbc 직결 대신 n8n 고정 워크플로 경유 — 사용자 방침(연결 단계 확정).
백엔드는 kind + 식별자 파라미터만 보내고, SQL 템플릿은 W2 워크플로 안에만 존재한다.
DB 자격증명도 n8n에만 있다 — 백엔드는 원본 DB에 직접 닿지 않는다.
The backend sends only identifiers; SQL templates and DB credentials live in n8n.
"""

import json
import logging
import urllib.request
from dataclasses import asdict
from urllib.error import URLError

from app.domain.validation import ColumnRef, ContainmentResult, JoinStepRef

logger = logging.getLogger(__name__)

# 일시 오류 1회 재시도 — 로깅 후 마지막 오류를 올린다 / one retry with logging, then raise
RETRY_COUNT = 1


def _read_payload(url: str, body: dict, timeout: int) -> list | dict:
    """단일 HTTP 왕복 — 테스트가 이 경계를 대체한다 / one round trip; tests patch here."""
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode())


def _post_query(
    webhook_base: str, body: dict, timeout: int
) -> tuple[list[dict], str | None]:
    """행과 실행 SQL을 함께 돌려준다.

    신 W2는 {query, rows}, 구 W2는 행 리스트를 보낸다 — 둘 다 받아 배포 순서 결합을
    없앤다. 구 W2에서는 query가 None이다.
    Accepts both the wrapped and the legacy shape so backend and n8n can deploy
    independently.
    """
    url = f"{webhook_base.rstrip('/')}/dbv-query"
    last_error: Exception | None = None
    for attempt in range(RETRY_COUNT + 1):
        try:
            payload = _read_payload(url, body, timeout)
        except URLError as e:
            last_error = e
            logger.warning("n8n query attempt failed",
                           extra={"url": url, "kind": body.get("kind"), "attempt": attempt})
            continue
        if isinstance(payload, dict) and "rows" in payload:
            rows = payload["rows"] or []
            return [r for r in rows if r], payload.get("query")
        rows = payload if isinstance(payload, list) else [payload]
        # W2의 alwaysOutputData가 0건 결과를 빈 아이템({}) 1개로 보낸다 → 빈 리스트로 정규화
        return [r for r in rows if r], None
    raise RuntimeError(
        f"n8n query failed after retries: kind={body.get('kind')} url={url}"
    ) from last_error


class N8nJoinValidator:
    """T2 검증 — W2의 containment/join_preview 템플릿 실행 / JoinValidator over W2."""

    def __init__(self, webhook_base: str, timeout: int):
        self._base = webhook_base
        self._timeout = timeout

    def containment(self, src: ColumnRef, tgt: ColumnRef) -> ContainmentResult:
        rows, _ = _post_query(self._base, {
            "kind": "containment",
            "src_schema": src.schema, "src_table": src.table, "src_column": src.column,
            "tgt_schema": tgt.schema, "tgt_table": tgt.table, "tgt_column": tgt.column,
        }, self._timeout)
        row = rows[0]
        src_distinct = int(row["src_distinct"])
        matched = int(row["matched"])
        return ContainmentResult(
            src_distinct=src_distinct,
            matched=matched,
            # 빈 소스는 0으로 — 나눗셈 가드 / empty source guards the division
            containment=(matched / src_distinct) if src_distinct > 0 else 0.0,
            orphan_count=src_distinct - matched,
            src_row_count=int(row["src_rows"]),
            tgt_distinct=int(row["tgt_distinct"]),
            tgt_row_count=int(row["tgt_rows"]),
        )

    def preview(self, src: ColumnRef, tgt: ColumnRef, limit: int) -> list[dict]:
        rows, _ = _post_query(self._base, {
            "kind": "join_preview", "limit": limit,
            "src_schema": src.schema, "src_table": src.table, "src_column": src.column,
            "tgt_schema": tgt.schema, "tgt_table": tgt.table, "tgt_column": tgt.column,
        }, self._timeout)
        return rows

    def multi_join_preview(
        self, steps: list[JoinStepRef], limit: int
    ) -> tuple[list[dict], str]:
        """N-웨이 조인 미리보기 — 실행문을 함께 받는다 / rows plus the executed SQL."""
        rows, query = _post_query(self._base, {
            "kind": "multi_join_preview", "limit": limit,
            "steps": [asdict(step) for step in steps],
        }, self._timeout)
        if query is None:
            raise RuntimeError(
                "n8n W2 did not return the executed SQL — "
                "재배포가 필요합니다 (multi_join_preview는 신 W2 전용)"
            )
        return rows, query


class N8nTablePreview:
    """테이블 미리보기 — W2의 table_preview 템플릿 실행 (WHERE LIKE 재질의 포함)."""

    def __init__(self, webhook_base: str, timeout: int):
        self._base = webhook_base
        self._timeout = timeout

    def rows(
        self, qname: str, columns: list[dict], limit: int,
        filter_column: str | None = None, filter_value: str | None = None,
    ) -> list[dict]:
        schema, table = qname.split(".", 1)
        body: dict = {"kind": "table_preview", "schema": schema, "table": table,
                      "limit": limit}
        if filter_column and filter_value:
            body["filter_column"] = filter_column
            body["filter_value"] = filter_value
        rows, _ = _post_query(self._base, body, self._timeout)
        return rows
