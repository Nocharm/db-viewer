"""Live query execution via the n8n W2 webhook. / n8n 경유 live 검증·미리보기 실행기.

계획 §4.3의 pyodbc 직결 대신 n8n 고정 워크플로 경유 — 사용자 방침(연결 단계 확정).
백엔드는 kind + 식별자 파라미터만 보내고, SQL 템플릿은 W2 워크플로 안에만 존재한다.
DB 자격증명도 n8n에만 있다 — 백엔드는 원본 DB에 직접 닿지 않는다.
The backend sends only identifiers; SQL templates and DB credentials live in n8n.
"""

import json
import logging
import urllib.request
from urllib.error import HTTPError, URLError

from app.domain.validation import ColumnRef, ContainmentResult

logger = logging.getLogger(__name__)

# 일시 오류 1회 재시도 — 로깅 후 마지막 오류를 올린다 / one retry with logging, then raise
RETRY_COUNT = 1
# 오류 본문 인용 길이(자) — 원인 파악엔 앞부분이면 충분하고, 로그가 SQL 덤프로 부풀지 않는다
ERROR_BODY_LIMIT = 400


class N8nQueryError(RuntimeError):
    """W2 호출·응답 실패 — 상태코드·응답 본문을 담아 화면까지 원인을 전달한다.

    RuntimeError를 유지하는 이유: 기존 호출부가 RuntimeError로 잡는다.
    """


def _quote_body(raw: str) -> str:
    return raw[:ERROR_BODY_LIMIT].replace("\n", " ")


def _is_status_envelope(payload: dict) -> bool:
    """행이 아니라 n8n의 상태·오류 봉투인지 / n8n status envelope, not a result row.

    allEntries 응답은 항상 리스트다. 최상위가 dict이면서 `message`를 가지면
    Respond 설정이 lastNode/allEntries가 아니라는 뜻이다
    (`{"message": "Workflow was started"}` / `{"message": "Error in workflow"}`).
    """
    return "message" in payload


def _normalize_rows(payload: object, kind: str) -> list[dict]:
    """W2 응답을 행 목록으로 정규화 — 행이 아닌 응답이 조용히 0행이 되지 않게 막는다.

    n8n은 설정·경로에 따라 세 가지 모양을 돌려준다: 행 배열(정상), 한 겹 더 감싼
    recordset 배열, 그리고 상태 봉투. 뒤 둘을 그대로 통과시키면 미리보기가 빈 표나
    가짜 1행으로 보여 원인을 화면에서 알 수 없다 — 여기서 형태를 확정한다.
    """
    if isinstance(payload, dict):
        if _is_status_envelope(payload):
            raise N8nQueryError(
                f"n8n returned a status envelope instead of rows: kind={kind} "
                f"message={payload.get('message')!r} — check the W2 webhook Respond "
                "settings (responseMode=lastNode, responseData=allEntries)"
            )
        return [payload]
    if not isinstance(payload, list):
        raise N8nQueryError(
            f"n8n returned {type(payload).__name__}, expected rows: kind={kind}"
        )

    rows: list[dict] = []
    for item in payload:
        # recordset가 한 겹 더 감싸져 오는 응답 — 평탄화하지 않으면 행 전체가 유실된다
        if isinstance(item, list):
            rows.extend(row for row in item if isinstance(row, dict) and row)
            continue
        if not isinstance(item, dict):
            raise N8nQueryError(
                f"n8n returned a non-object row ({type(item).__name__}): kind={kind}"
            )
        # W2의 alwaysOutputData가 0건 결과를 빈 아이템({}) 1개로 보낸다 → 제거
        if item:
            rows.append(item)
    return rows


def _post_query(webhook_base: str, body: dict, timeout: int) -> list[dict]:
    url = f"{webhook_base.rstrip('/')}/dbv-query"
    kind = body.get("kind", "")
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    last_error: Exception | None = None
    for attempt in range(RETRY_COUNT + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read().decode()
        except HTTPError as e:
            detail = _quote_body(e.read().decode(errors="replace"))
            message = (
                f"n8n rejected the query: kind={kind} url={url} "
                f"status={e.code} body={detail}"
            )
            # 4xx는 재시도해도 같다 — 워크플로 비활성·webhook 경로 오타가 대부분이다
            if e.code < 500:
                raise N8nQueryError(message) from e
            last_error = N8nQueryError(message)
            logger.warning("n8n query returned a server error",
                           extra={"url": url, "kind": kind, "status": e.code,
                                  "attempt": attempt})
            continue
        except URLError as e:
            last_error = e
            logger.warning("n8n query attempt failed",
                           extra={"url": url, "kind": kind, "attempt": attempt})
            continue

        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as e:
            # 프록시 오류 페이지 등 — 본문을 인용해야 어디서 가로챘는지 알 수 있다
            raise N8nQueryError(
                f"n8n returned a non-JSON body: kind={kind} url={url} "
                f"body={_quote_body(raw)}"
            ) from e
        rows = _normalize_rows(payload, kind)
        logger.info("n8n query returned rows",
                    extra={"url": url, "kind": kind, "rows": len(rows)})
        return rows

    raise N8nQueryError(
        f"n8n query failed after retries: kind={kind} url={url} ({last_error})"
    ) from last_error


class N8nJoinValidator:
    """T2 검증 — W2의 containment/join_preview 템플릿 실행 / JoinValidator over W2."""

    def __init__(self, webhook_base: str, timeout: int):
        self._base = webhook_base
        self._timeout = timeout

    def containment(self, src: ColumnRef, tgt: ColumnRef) -> ContainmentResult:
        rows = _post_query(self._base, {
            "kind": "containment",
            "src_schema": src.schema, "src_table": src.table, "src_column": src.column,
            "tgt_schema": tgt.schema, "tgt_table": tgt.table, "tgt_column": tgt.column,
        }, self._timeout)
        if not rows:
            # 집계 쿼리는 항상 1행이다 — 0행이면 실행되지 않았다는 뜻
            raise N8nQueryError(
                "n8n returned no rows for the containment aggregate — the W2 query "
                f"did not run ({src.schema}.{src.table} → {tgt.schema}.{tgt.table})"
            )
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
        return _post_query(self._base, {
            "kind": "join_preview", "limit": limit,
            "src_schema": src.schema, "src_table": src.table, "src_column": src.column,
            "tgt_schema": tgt.schema, "tgt_table": tgt.table, "tgt_column": tgt.column,
        }, self._timeout)


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
        return _post_query(self._base, body, self._timeout)
