"""MSSQL 전용 기능의 경계 — 다른 소스가 생겨도 안 깨지고, 다른 소스에 적용되지도 않는다.
/ the MSSQL-only boundary, from both sides.

뷰 파싱·관계 발견·조인 검증·AI는 "FK가 13개뿐인 레거시 MSSQL"을 위한 기계다(스펙 비목표).
스냅샷 id는 전 소스 공통 시퀀스라, PG/SQLite 소스를 한 번이라도 수집하면 "최신 ready
스냅샷"이 그쪽으로 넘어간다 — 소스를 안 건 조회는 오류 없이 조용히 엉뚱한 스냅샷을 본다.
반대편도 같은 문제다: 백엔드는 클라이언트가 준 object_id/column_id를 그대로 해석하므로,
UI가 진입점을 감춰도 북마크한 URL 하나면 PG 식별자가 n8n/MSSQL 검증기로 흘러든다.
"""

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker

from app.adapters.fake_validator import FakeJoinValidator
from app.api.scan import get_scan_session_factory
from app.api.validate import get_join_validator
from app.models import Base


def _seed_mssql_catalog(client, load_fixture) -> int:
    """기본 소스(사내 MSSQL)에 픽스처 카탈로그 1세트 / one fixture catalog on source 1."""
    sid = client.post("/api/ingest/catalog",
                      json=load_fixture("catalog.json")).json()["snapshot_id"]
    client.post("/api/ingest/view-deps",
                json={**load_fixture("view_deps.json"), "snapshot_id": sid})
    return sid


def _column_id(engine, object_qname: str, column: str) -> int:
    schema, table = object_qname.split(".", 1)
    objects, columns = Base.metadata.tables["objects"], Base.metadata.tables["columns"]
    with engine.connect() as conn:
        return conn.execute(
            sa.select(columns.c.id).join(objects, columns.c.object_id == objects.c.id)
            .where(objects.c.schema == schema, objects.c.name == table,
                   columns.c.name == column)
        ).scalar_one()


def _a_joinable_relation(load_fixture) -> dict:
    return next(r for r in load_fixture("expected/relations.json")["rows"]
                if r["kind"] == "real_no_fk" and r["orphan_count"] == 0)


@pytest.fixture()
def bclient(client, fixture_dir, migrated_engine):
    """검증기 + 스캔 배경 세션 오버라이드 / validator and scan-session overrides."""
    client.app.dependency_overrides[get_join_validator] = lambda: FakeJoinValidator(
        fixture_dir / "value_sets.json"
    )
    client.app.dependency_overrides[get_scan_session_factory] = lambda: sessionmaker(
        bind=migrated_engine
    )
    return client


# ── 다른 소스가 생겨도 MSSQL 기능이 계속 그 소스를 본다 ──


def test_scan_runs_against_the_mssql_snapshot_not_the_newest(
    bclient, migrated_engine, load_fixture, newer_non_mssql_snapshot
):
    """스캔은 '최신 ready'가 아니라 '사내 MSSQL의 최신 ready'를 봐야 한다."""
    # Arrange: MSSQL 카탈로그를 적재한 뒤, 더 새로운 PG 스냅샷을 만든다
    _seed_mssql_catalog(bclient, load_fixture)
    rel = _a_joinable_relation(load_fixture)
    src_id = _column_id(migrated_engine, rel["src_object"], rel["src_column"])
    newer_non_mssql_snapshot()

    # Act
    job_id = bclient.post(
        "/api/scan", json={"column_id": src_id, "triggered_by": "test"}
    ).json()["job_id"]
    body = bclient.get(f"/api/jobs/{job_id}").json()

    # Assert: 소스를 안 걸면 PG 스냅샷이 최신이라 "source column ... not in latest
    # snapshot"으로 죽는다 — 기능이 통째로 사라지고 오류는 잡 안에만 남는다
    assert body["status"] == "done", body.get("error")
    assert body["progress"]["total"] > 0


def test_pending_relation_prefill_resolves_against_the_mssql_snapshot(
    bclient, migrated_engine, load_fixture, newer_non_mssql_snapshot
):
    """/verify 프리필은 관계 텍스트를 현 스냅샷의 id로 되돌린다 — 소스를 안 걸면 전부 null."""
    # Arrange: 검증(T2)으로 대기 관계 1건을 만든 뒤 더 새로운 PG 스냅샷을 붙인다
    _seed_mssql_catalog(bclient, load_fixture)
    rel = _a_joinable_relation(load_fixture)
    src_id = _column_id(migrated_engine, rel["src_object"], rel["src_column"])
    tgt_id = _column_id(migrated_engine, rel["tgt_object"], rel["tgt_column"])
    bclient.post("/api/validate/containment",
                 json={"src_column_id": src_id, "tgt_column_id": tgt_id})
    newer_non_mssql_snapshot()

    # Act
    body = bclient.get("/api/relations/pending").json()

    # Assert
    entry = next(i for i in body["items"]
                 if (i["src_object"], i["src_column"]) == (rel["src_object"],
                                                           rel["src_column"]))
    assert entry["src_column_id"] == src_id and entry["tgt_column_id"] == tgt_id


# ── 다른 소스의 id로는 MSSQL 기계를 부를 수 없다 ──


def test_join_check_rejects_a_non_mssql_object(
    bclient, migrated_engine, load_fixture, newer_non_mssql_snapshot
):
    """북마크한 /verify 링크 하나로 PG 객체가 n8n 검증기에 들어가면 안 된다."""
    # Arrange
    mssql_snapshot = _seed_mssql_catalog(bclient, load_fixture)
    _, pg_object_id, _ = newer_non_mssql_snapshot()
    objects = Base.metadata.tables["objects"]
    with migrated_engine.connect() as conn:
        mssql_object_id = conn.execute(
            sa.select(objects.c.id)
            .where(objects.c.snapshot_id == mssql_snapshot, objects.c.type == "table")
            .order_by(objects.c.id).limit(1)
        ).scalar_one()

    # Act
    rejected = bclient.post(f"/api/objects/{pg_object_id}/join-check", json={})
    allowed = bclient.post(f"/api/objects/{mssql_object_id}/join-check", json={})

    # Assert: MSSQL 경로는 그대로 살아 있어야 차단이 공허하지 않다
    assert rejected.status_code == 400
    assert "MSSQL source only" in rejected.json()["error"]["message"]
    assert allowed.status_code == 200


def test_validation_endpoints_reject_a_non_mssql_column(
    bclient, migrated_engine, load_fixture, newer_non_mssql_snapshot
):
    """컬럼 id를 받는 검증 경로 전체가 같은 경계를 공유한다 (resolve_column_ref 한 곳)."""
    # Arrange
    _seed_mssql_catalog(bclient, load_fixture)
    _, _, pg_column_id = newer_non_mssql_snapshot()
    rel = _a_joinable_relation(load_fixture)
    mssql_column_id = _column_id(migrated_engine, rel["src_object"], rel["src_column"])
    tgt_column_id = _column_id(migrated_engine, rel["tgt_object"], rel["tgt_column"])
    pg_ids = {"src_column_id": pg_column_id, "tgt_column_id": pg_column_id}

    # Act
    gate = bclient.post("/api/validate/gate", json=pg_ids)
    containment = bclient.post("/api/validate/containment", json=pg_ids)
    scan = bclient.post("/api/scan", json={"column_id": pg_column_id})
    mssql = bclient.post("/api/validate/containment",
                         json={"src_column_id": mssql_column_id,
                               "tgt_column_id": tgt_column_id})

    # Assert
    assert [gate.status_code, containment.status_code,
            scan.status_code] == [400, 400, 400]
    assert "MSSQL source only" in containment.json()["error"]["message"]
    assert mssql.status_code == 200  # 기존 MSSQL 경로는 무변경
