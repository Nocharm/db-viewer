# backend/tests/test_n8n_value_probe.py
"""값 추적 실행기 — n8n 클라이언트(재시도 없음)·픽스처 페이크·팩토리 분기."""

import io
import json
from datetime import UTC, datetime
from urllib.error import HTTPError

import pytest

from app.adapters import SyntheticDataRefused, create_value_prober, n8n_query
from app.adapters.n8n_query import N8nQueryError, N8nValueProber
from app.adapters.value_probe import FakeValueProber
from app.config import Settings
from app.domain import value_probe as vp
from app.models import DataSource
from app.sources.direct_probe import DirectValueProber


class _FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


@pytest.fixture()
def captured(monkeypatch):
    calls = {"bodies": [], "response": {"query": "SELECT 1", "rows": []}, "fail_with": None}

    def fake_urlopen(request, timeout=None):
        calls["bodies"].append(json.loads(request.data.decode()))
        if calls["fail_with"] is not None:
            raise calls["fail_with"]
        return _FakeResponse(json.dumps(calls["response"], ensure_ascii=False).encode())

    monkeypatch.setattr(n8n_query.urllib.request, "urlopen", fake_urlopen)
    return calls


COLUMN = vp.ProbeColumn("ORD_NO", vp.FAMILY_TEXT, "text-narrow", ("A", "a"))


def test_probe_posts_column_specs_and_returns_rows(captured):
    captured["response"] = {"query": "SELECT TOP 1 ...", "rows": [{"ORD_NO": "A"}]}
    rows = N8nValueProber("http://n8n/webhook", 5).probe("SAP", "T_ORD", [COLUMN])
    assert rows == [{"ORD_NO": "A"}]
    assert captured["bodies"] == [{
        "kind": "value_probe", "schema": "SAP", "table": "T_ORD",
        "columns": [{"name": "ORD_NO", "family": "text", "literal": "text-narrow",
                     "values": ["A", "a"], "op": "eq"}],
    }]


def test_probe_serializes_numeric_values_as_strings(captured):
    """숫자 값을 문자열로 보낸다 — JSON number를 거치면 16자리 이상 bigint가 정밀도를 잃는다."""
    captured["response"] = {"query": "SELECT TOP 1 ...", "rows": []}
    numeric = vp.ProbeColumn("AMT", vp.FAMILY_INT, "number", (1000, "250.5"))
    N8nValueProber("http://n8n/webhook", 5).probe("SAP", "T_ORD", [numeric])
    assert captured["bodies"][-1]["columns"] == [{
        "name": "AMT", "family": "int", "literal": "number",
        "values": ["1000", "250.5"], "op": "eq",
    }]


def test_count_reads_n_and_requires_a_row(captured):
    captured["response"] = {"query": "SELECT COUNT(*) ...", "rows": [{"n": 3}]}
    prober = N8nValueProber("http://n8n/webhook", 5)
    assert prober.count("SAP", "T_ORD", COLUMN, 1000) == 3
    assert captured["bodies"][-1]["kind"] == "value_count" and captured["bodies"][-1]["cap"] == 1000
    captured["response"] = {"query": "…", "rows": []}
    with pytest.raises(N8nQueryError):
        prober.count("SAP", "T_ORD", COLUMN, 1000)


def test_probe_does_not_retry_on_server_errors(captured):
    captured["fail_with"] = HTTPError("http://n8n/webhook/dbv-query", 502, "bad gateway",
                                      None, io.BytesIO(b"boom"))
    with pytest.raises(N8nQueryError):
        N8nValueProber("http://n8n/webhook", 5).probe("SAP", "T_ORD", [COLUMN])
    assert len(captured["bodies"]) == 1  # 타임아웃·5xx에 재시도하면 소스 부하가 두 배


def test_fake_prober_reads_value_sets(tmp_path):
    path = tmp_path / "value_sets.json"
    path.write_text(json.dumps({"columns": [
        {"object": "dbo.T_ORD", "column": "ORD_NO", "values": ["X1", "X2", "X2"]},
    ]}))
    fake = FakeValueProber(path)
    column = vp.ProbeColumn("ORD_NO", vp.FAMILY_TEXT, "text-narrow", ("x2", "X2"))
    rows = fake.probe("dbo", "T_ORD", [column, vp.ProbeColumn("OTHER", vp.FAMILY_TEXT, "text-narrow", ("X2",))])
    assert rows == [{"ORD_NO": "X2", "OTHER": None}]
    assert fake.count("dbo", "T_ORD", column, 1000) == 2
    assert fake.probe("dbo", "T_NONE", [column]) == []


def _settings(tmp_path, **overrides) -> Settings:
    base = dict(source_mode="fixture", n8n_webhook_base="", fixture_dir=str(tmp_path))
    base.update(overrides)
    return Settings(_env_file=None, **base)


def test_factory_picks_fake_direct_live_or_refuses(tmp_path):
    now = datetime.now(UTC)
    assert isinstance(create_value_prober(_settings(tmp_path)), FakeValueProber)
    direct = DataSource(id=97, name="d", engine="sqlite", access_mode="direct",
                        file_path=str(tmp_path / "x.db"), is_enabled=True, is_managed=False,
                        created_at=now, updated_at=now)
    assert isinstance(create_value_prober(_settings(tmp_path), direct), DirectValueProber)
    live = _settings(tmp_path, source_mode="live", n8n_webhook_base="http://n8n/webhook")
    assert isinstance(create_value_prober(live), N8nValueProber)
    with pytest.raises(RuntimeError):
        create_value_prober(_settings(tmp_path, source_mode="live"))
    with pytest.raises(SyntheticDataRefused):
        create_value_prober(_settings(tmp_path, n8n_webhook_base="http://n8n/webhook"))
