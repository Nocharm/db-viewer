"""N8n W2 query adapter tests with mocked HTTP. / n8n 쿼리 어댑터 테스트 (HTTP 목킹)."""

import io
import json

import pytest

from app.adapters import n8n_query
from app.adapters.n8n_query import N8nJoinValidator, N8nTablePreview
from app.domain.validation import ColumnRef

SRC = ColumnRef("dbo", "ORD_SO_HDR", "EMP_NO")
TGT = ColumnRef("dbo", "HR_EMP", "EMP_NO")


class _FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


@pytest.fixture()
def captured(monkeypatch):
    """urlopen을 가로채 요청 본문 기록 + 준비된 응답 반환 / capture request, return canned rows."""
    calls: dict = {"bodies": [], "response": []}

    def fake_urlopen(request, timeout=None):
        calls["bodies"].append(json.loads(request.data.decode()))
        calls["url"] = request.full_url
        calls["timeout"] = timeout
        return _FakeResponse(json.dumps(calls["response"]).encode())

    monkeypatch.setattr(n8n_query.urllib.request, "urlopen", fake_urlopen)
    return calls


def test_containment_sends_identifiers_and_computes_result(captured):
    captured["response"] = [{
        "src_rows": 1000, "tgt_rows": 340, "tgt_distinct": 340,
        "src_distinct": 200, "matched": 194,
    }]
    validator = N8nJoinValidator("http://n8n/webhook/", timeout=30)
    result = validator.containment(SRC, TGT)

    body = captured["bodies"][0]
    assert body["kind"] == "containment"
    assert (body["src_schema"], body["src_table"], body["src_column"]) == ("dbo", "ORD_SO_HDR", "EMP_NO")
    assert captured["url"] == "http://n8n/webhook/dbv-query"  # base 슬래시 정규화
    assert captured["timeout"] == 30

    assert result.containment == pytest.approx(194 / 200)
    assert result.orphan_count == 6
    assert result.cardinality == "N:1"  # tgt_distinct == tgt_rows → 유니크 타깃(1), src는 N


def test_containment_empty_source_guards_division(captured):
    captured["response"] = [{
        "src_rows": 0, "tgt_rows": 10, "tgt_distinct": 8,
        "src_distinct": 0, "matched": 0,
    }]
    result = N8nJoinValidator("http://n8n/webhook", timeout=5).containment(SRC, TGT)
    assert result.containment == 0.0
    assert result.cardinality == "N:M"


def test_table_preview_sends_filter_params(captured):
    captured["response"] = [{"EMP_NO": 1000, "EMP_NM": "샘플"}]
    preview = N8nTablePreview("http://n8n/webhook", timeout=5)
    rows = preview.rows("dbo.HR_EMP", [], 50, filter_column="EMP_NM", filter_value="샘플")

    body = captured["bodies"][0]
    assert body == {
        "kind": "table_preview", "schema": "dbo", "table": "HR_EMP",
        "limit": 50, "filter_column": "EMP_NM", "filter_value": "샘플",
        "filter_mode": "contains",
    }
    assert rows == [{"EMP_NO": 1000, "EMP_NM": "샘플"}]


def test_table_preview_drops_empty_rows(captured):
    # W2 alwaysOutputData: 0건 결과가 빈 아이템({}) 1개로 온다 → 빈 리스트 정규화
    captured["response"] = [{}]
    rows = N8nTablePreview("http://n8n/webhook", timeout=5).rows("dbo.HR_EMP", [], 50)
    assert rows == []


def test_table_preview_flattens_a_nested_recordset(captured):
    # 한 겹 더 감싸져 오는 응답 — 평탄화하지 않으면 20행이 통째로 유실된다
    captured["response"] = [[{"EMP_NO": 1}, {"EMP_NO": 2}]]
    rows = N8nTablePreview("http://n8n/webhook", timeout=5).rows("dbo.HR_EMP", [], 20)
    assert rows == [{"EMP_NO": 1}, {"EMP_NO": 2}]


def test_status_envelope_raises_instead_of_looking_like_no_data(captured):
    """Respond 설정이 어긋나면 n8n은 상태 봉투를 준다 — 빈 표가 아니라 원인을 올린다."""
    captured["response"] = {"message": "Workflow was started"}
    with pytest.raises(n8n_query.N8nQueryError, match="responseData=allEntries"):
        N8nTablePreview("http://n8n/webhook", timeout=5).rows("dbo.HR_EMP", [], 20)


def test_containment_without_rows_raises(captured):
    # 집계는 항상 1행 — 0행은 쿼리가 실행되지 않았다는 신호다
    captured["response"] = [{}]
    with pytest.raises(n8n_query.N8nQueryError, match="did not run"):
        N8nJoinValidator("http://n8n/webhook", timeout=5).containment(SRC, TGT)


def test_client_error_reports_status_and_body_without_retrying(monkeypatch):
    """워크플로 비활성·경로 오타(4xx)는 재시도해도 같다 — 본문을 인용해 즉시 알린다."""
    from urllib.error import HTTPError

    attempts = []

    def failing_urlopen(request, timeout=None):
        attempts.append(1)
        raise HTTPError(request.full_url, 404, "Not Found", {},
                        io.BytesIO(b'{"message":"webhook not registered"}'))

    monkeypatch.setattr(n8n_query.urllib.request, "urlopen", failing_urlopen)
    with pytest.raises(n8n_query.N8nQueryError) as exc:
        N8nTablePreview("http://n8n/webhook", timeout=1).rows("dbo.HR_EMP", [], 20)
    assert "status=404" in str(exc.value)
    assert "webhook not registered" in str(exc.value)
    assert len(attempts) == 1


def test_non_json_body_is_quoted_in_the_error(monkeypatch):
    def html_urlopen(request, timeout=None):
        return _FakeResponse(b"<html>502 Bad Gateway</html>")

    monkeypatch.setattr(n8n_query.urllib.request, "urlopen", html_urlopen)
    with pytest.raises(n8n_query.N8nQueryError, match="502 Bad Gateway"):
        N8nTablePreview("http://n8n/webhook", timeout=1).rows("dbo.HR_EMP", [], 20)


def test_failure_raises_after_retry(monkeypatch):
    from urllib.error import URLError

    attempts = []

    def failing_urlopen(request, timeout=None):
        attempts.append(1)
        raise URLError("connection refused")

    monkeypatch.setattr(n8n_query.urllib.request, "urlopen", failing_urlopen)
    with pytest.raises(RuntimeError, match="n8n query failed"):
        N8nJoinValidator("http://n8n/webhook", timeout=1).containment(SRC, TGT)
    assert len(attempts) == 2  # 1회 재시도 후 마지막 오류 / one retry then raise


def test_post_query_accepts_both_legacy_and_wrapped_shapes(monkeypatch) -> None:
    """구 W2(행 리스트)와 신 W2({query, rows})를 모두 받는다 — 배포 순서 결합 제거."""
    from app.adapters import n8n_query

    legacy = [{"a": 1}, {"a": 2}]
    wrapped = {"query": "SELECT 1", "rows": [{"a": 1}]}

    # _read_payload는 원문 문자열을 돌려준다 — 비-JSON 본문을 인용하려면 파싱이 호출부에 남아야 한다
    payloads = iter([json.dumps(legacy), json.dumps(wrapped)])
    monkeypatch.setattr(n8n_query, "_read_payload", lambda *a, **k: next(payloads))

    rows, query = n8n_query._post_query("http://x", {"kind": "containment"}, 5)
    assert rows == legacy and query is None

    rows, query = n8n_query._post_query("http://x", {"kind": "containment"}, 5)
    assert rows == [{"a": 1}] and query == "SELECT 1"


def test_post_query_unwraps_a_single_element_list_envelope(monkeypatch) -> None:
    """반쯤 배포된 상태 — 코드는 신 W2 계약을 기대하는데 워크플로가 아직 재임포트되지
    않아 webhook이 allEntries로 남아 있으면, Attach query의 단일 아이템 {query, rows}가
    HTTP 응답에서 [{query, rows}] 배열로 한 번 더 감싸진다. 이걸 구형 응답으로 오인해
    래퍼 객체를 행 하나로 돌려주는 대신(Finding 1의 증상) 벗겨내 정상 처리해야 한다."""
    from app.adapters import n8n_query

    monkeypatch.setattr(
        n8n_query, "_read_payload",
        lambda *a, **k: json.dumps([{"query": "SELECT TOP 20 ...", "rows": [{"a": 1}, {"a": 2}]}]),
    )
    rows, query = n8n_query._post_query("http://x", {"kind": "multi_join_preview"}, 5)
    assert rows == [{"a": 1}, {"a": 2}]
    assert query == "SELECT TOP 20 ..."


def test_post_query_wrapped_dict_missing_rows_falls_back_to_legacy_shape(monkeypatch) -> None:
    """rows 키가 아예 없는 dict는 신 W2 포맷으로 오인하지 않고 구형 단일-행 응답으로
    받는다 — KeyError로 죽는 대신 안전하게 처리된다는 걸 고정한다."""
    from app.adapters import n8n_query

    monkeypatch.setattr(n8n_query, "_read_payload",
                        lambda *a, **k: json.dumps({"query": "SELECT 1"}))
    rows, query = n8n_query._post_query("http://x", {"kind": "containment"}, 5)
    assert rows == [{"query": "SELECT 1"}]
    assert query is None


def test_sample_stats_sends_kind_and_parses_counts(captured):
    captured["response"] = [{"sample_rows": 200, "sample_distinct": 187}]
    validator = N8nJoinValidator("http://n8n/webhook/", timeout=30)

    rows, distinct = validator.sample_stats(SRC, 200)

    body = captured["bodies"][0]
    assert body["kind"] == "sample_distinct"
    assert (body["schema"], body["table"], body["column"]) == ("dbo", "ORD_SO_HDR", "EMP_NO")
    assert body["top"] == 200
    assert (rows, distinct) == (200, 187)


def test_sample_stats_without_rows_raises(captured):
    captured["response"] = []
    validator = N8nJoinValidator("http://n8n/webhook/", timeout=30)
    with pytest.raises(n8n_query.N8nQueryError):
        validator.sample_stats(SRC, 200)


def test_multi_join_preview_sends_steps_and_returns_the_query(monkeypatch) -> None:
    """N-웨이 미리보기는 스텝 배열을 그대로 보내고 실행문을 함께 받는다."""
    from app.adapters import n8n_query
    from app.domain.validation import JoinStepRef

    captured: dict = {}

    def fake_read(url, body, timeout):  # noqa: ARG001
        captured.update(body)
        return json.dumps({"query": "SELECT TOP 20 ...", "rows": [{"x": 1}]})

    monkeypatch.setattr(n8n_query, "_read_payload", fake_read)
    validator = n8n_query.N8nJoinValidator("http://x", 5)
    steps = [JoinStepRef(
        left_schema="ATM", left_table="T_ORDER", left_column="ORDER_ID",
        right_schema="ATM", right_table="T_LOG", right_column="ORDER_ID",
        join_type="left",
    )]

    rows, query = validator.multi_join_preview(steps, 20)

    assert captured["kind"] == "multi_join_preview"
    assert captured["limit"] == 20
    assert captured["steps"][0]["join_type"] == "left"
    assert captured["steps"][0]["left_table"] == "T_ORDER"
    assert rows == [{"x": 1}]
    assert query == "SELECT TOP 20 ..."
