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
