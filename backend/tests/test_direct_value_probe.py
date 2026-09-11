"""직결 값 추적 — 실제 SQLite 파일로 왕복. / DirectValueProber against a real SQLite file."""

import sqlite3
from datetime import UTC, datetime

import pytest

from app.domain import value_probe as vp
from app.models import DataSource
from app.sources.connection import clear_sa_engine, get_sa_engine
from app.sources.direct_probe import DirectValueProber


@pytest.fixture()
def sqlite_source(tmp_path):
    # Arrange: 테이블 + 뷰 + 건수 상한 검증용 대량 행
    path = tmp_path / "app.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE orders (id INTEGER PRIMARY KEY, ord_no TEXT, amt REAL, status TEXT)")
    conn.executemany("INSERT INTO orders (ord_no, amt, status) VALUES (?, ?, ?)",
                     [("ORD-0910-001", 1000.0, "PAID"), ("ORD-0910-002", 250.5, "PAID")]
                     + [(f"BULK-{i}", 1.0, "BULK") for i in range(1500)])
    conn.execute("CREATE VIEW v_orders AS SELECT ord_no AS order_number, status FROM orders")
    conn.commit()
    conn.close()
    now = datetime.now(UTC)
    source = DataSource(id=98, name="probe", engine="sqlite", access_mode="direct",
                        file_path=str(path), is_enabled=True, is_managed=False,
                        created_at=now, updated_at=now)
    clear_sa_engine(source.id)
    yield DirectValueProber(get_sa_engine(source))
    clear_sa_engine(source.id)


def _text(name, *values, op="eq"):
    return vp.ProbeColumn(name, vp.FAMILY_TEXT, "text-narrow", tuple(values), op)


def test_probe_returns_one_row_and_match_columns_names_the_column(sqlite_source):
    columns = [_text("ord_no", "ord-0910-001", "ORD-0910-001"), _text("status", "ord-0910-001")]
    rows = sqlite_source.probe("main", "orders", columns)
    assert len(rows) == 1
    matched = vp.match_columns(rows[0], columns)
    assert [(m.name, m.matched_variant) for m in matched] == [("ord_no", "ORD-0910-001")]


def test_probe_numeric_variant_hits_real_column(sqlite_source):
    column = vp.ProbeColumn("amt", vp.FAMILY_DECIMAL, "number", ("1000",))
    rows = sqlite_source.probe("main", "orders", [column])
    assert rows and vp.match_cell(rows[0]["amt"], column) == "1000"


def test_probe_returns_empty_when_nothing_matches(sqlite_source):
    assert sqlite_source.probe("main", "orders", [_text("ord_no", "nope")]) == []


def test_probe_works_against_a_view(sqlite_source):
    rows = sqlite_source.probe("main", "v_orders", [_text("order_number", "ORD-0910-002")])
    assert rows[0]["order_number"] == "ORD-0910-002"


def test_count_is_capped_at_cap_plus_one(sqlite_source):
    assert sqlite_source.count("main", "orders", _text("status", "BULK"), 1000) == 1001
    assert sqlite_source.count("main", "orders", _text("status", "PAID"), 1000) == 2


def test_contains_probe_uses_like(sqlite_source):
    rows = sqlite_source.probe("main", "orders", [_text("ord_no", "0910-00", op="contains")])
    assert rows and "0910-00" in rows[0]["ord_no"]
