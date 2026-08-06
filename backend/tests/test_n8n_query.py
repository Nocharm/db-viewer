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
    assert result.cardinality == "1:N"  # tgt_distinct == tgt_rows → 유니크 타깃


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
