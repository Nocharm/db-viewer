"""Ingest endpoint tests against the generated fixture set. / 픽스처 기반 ingest 테스트."""

import sqlalchemy as sa

from app.models import Base


def _count(engine, table: str) -> int:
    with engine.connect() as conn:
        return conn.execute(
            sa.select(sa.func.count()).select_from(Base.metadata.tables[table])
        ).scalar()


def _ingest_catalog(client, load_fixture) -> tuple[int, dict]:
    payload = load_fixture("catalog.json")
    res = client.post("/api/ingest/catalog", json=payload)
    assert res.status_code == 200, res.text
    return res.json()["snapshot_id"], payload


def test_ingest_catalog_persists_counts(client, migrated_engine, load_fixture):
    snapshot_id, payload = _ingest_catalog(client, load_fixture)

    assert snapshot_id == 1
    assert _count(migrated_engine, "objects") == len(payload["objects"])
    assert _count(migrated_engine, "columns") == len(payload["columns"])
    assert _count(migrated_engine, "constraints") == (
        len(payload["key_constraints"]) + len(payload["foreign_keys"])
    )
    assert _count(migrated_engine, "fk_columns") == sum(
        len(fk["columns"]) for fk in payload["foreign_keys"]
    )


def test_ingest_catalog_derives_is_pk(client, migrated_engine, load_fixture):
    _, payload = _ingest_catalog(client, load_fixture)
    expected_pk_pairs = sum(
        len(kc["columns"]) for kc in payload["key_constraints"] if kc["type"] == "pk"
    )
    with migrated_engine.connect() as conn:
        t = Base.metadata.tables["columns"]
        actual = conn.execute(
            sa.select(sa.func.count()).select_from(t).where(t.c.is_pk.is_(True))
        ).scalar()
    assert actual == expected_pk_pairs


def test_ingest_catalog_keeps_null_definitions(client, migrated_engine, load_fixture):
    # 권한 차단 뷰의 definition NULL은 NULL로 보존 / blocked definitions stay NULL
    _, payload = _ingest_catalog(client, load_fixture)
    null_defs = sum(1 for vd in payload["view_definitions"] if vd["definition"] is None)
    with migrated_engine.connect() as conn:
        t = Base.metadata.tables["objects"]
        stored_null = conn.execute(
            sa.select(sa.func.count()).select_from(t)
            .where(t.c.type == "view", t.c.definition.is_(None))
        ).scalar()
        stored_filled = conn.execute(
            sa.select(sa.func.count()).select_from(t)
            .where(t.c.type == "view", t.c.definition.is_not(None))
        ).scalar()
    assert stored_null == null_defs
    assert stored_filled == len(payload["view_definitions"]) - null_defs


def test_ingest_view_deps_full_flow(client, migrated_engine, load_fixture):
    snapshot_id, _ = _ingest_catalog(client, load_fixture)
    vd = load_fixture("view_deps.json")

    res = client.post("/api/ingest/view-deps", json={**vd, "snapshot_id": snapshot_id})
    assert res.status_code == 200, res.text
    assert res.json()["counts"]["deps"] == len(vd["deps"])

    with migrated_engine.connect() as conn:
        deps_t = Base.metadata.tables["view_deps"]
        unresolved = conn.execute(
            sa.select(deps_t).where(deps_t.c.is_resolved.is_(False))
        ).all()
        # 미해석 참조는 텍스트 식별자 보존 / unresolved refs keep textual identity
        assert unresolved and all(r.referenced_object_id is None for r in unresolved)
        assert all(r.referenced_name for r in unresolved)

        obj_t = Base.metadata.tables["objects"]
        dmv_flagged = conn.execute(
            sa.select(sa.func.count()).select_from(obj_t).where(obj_t.c.dmv_unresolved.is_(True))
        ).scalar()
        assert dmv_flagged == len(vd["unresolved_objects"])

        status = conn.execute(sa.select(Base.metadata.tables["snapshots"].c.status)).scalar()
        assert status == "ready"


def test_view_deps_unknown_snapshot_is_404(client, load_fixture):
    vd = load_fixture("view_deps.json")
    res = client.post("/api/ingest/view-deps", json={**vd, "snapshot_id": 999})
    assert res.status_code == 404
    body = res.json()
    # 승인된 에러 규약 준수 / approved error envelope
    assert body["error"]["code"] == 404
    assert body["error"]["context"] == {"snapshot_id": 999}


def test_invalid_payload_is_422_envelope(client):
    res = client.post("/api/ingest/catalog", json={"source_db": 1})
    assert res.status_code == 422
    assert res.json()["error"]["code"] == 422


def test_second_catalog_ingest_creates_new_snapshot(client, migrated_engine, load_fixture):
    sid1, _ = _ingest_catalog(client, load_fixture)
    sid2, payload = _ingest_catalog(client, load_fixture)
    assert (sid1, sid2) == (1, 2)
    assert _count(migrated_engine, "objects") == 2 * len(payload["objects"])


def _create_job(engine) -> int:
    """청크 이어붙이기용 수집 잡 생성 / seed a collect job for chunked ingest."""
    from datetime import UTC, datetime

    t = Base.metadata.tables["collect_jobs"]
    now = datetime.now(UTC)
    with engine.begin() as conn:
        return conn.execute(
            sa.insert(t).values(mode="step", stage="catalog_running",
                                triggered_by="test", created_at=now, updated_at=now)
            .returning(t.c.id)
        ).scalar_one()


def _slice_catalog(payload: dict, objects: list, index: int, total: int,
                   job_id: int, with_fks: bool) -> dict:
    ids = {o["object_id"] for o in objects}
    return {
        "source_db": payload["source_db"], "collected_at": payload["collected_at"],
        "collect_job_id": job_id, "chunk_index": index, "chunk_total": total,
        "objects": objects,
        "columns": [c for c in payload["columns"] if c["object_id"] in ids],
        "key_constraints": [k for k in payload["key_constraints"] if k["object_id"] in ids],
        # FK는 청크를 가로지를 수 있어 마지막 청크에만 / FKs only on the final chunk
        "foreign_keys": payload["foreign_keys"] if with_fks else [],
        "view_definitions": [v for v in payload["view_definitions"] if v["object_id"] in ids],
    }


def test_ingest_catalog_chunked_assembles_one_snapshot(client, migrated_engine, load_fixture):
    payload = load_fixture("catalog.json")
    job_id = _create_job(migrated_engine)
    objects = payload["objects"]
    half = len(objects) // 2

    r1 = client.post("/api/ingest/catalog",
                     json=_slice_catalog(payload, objects[:half], 1, 2, job_id, False))
    assert r1.status_code == 200, r1.text
    job = client.get(f"/api/collect/jobs/{job_id}").json()
    assert job["stage"] == "catalog_running"  # 중간 청크는 완료 아님
    assert job["counts"]["catalog_chunks_done"] == 1
    assert job["counts"]["catalog_chunks_total"] == 2

    r2 = client.post("/api/ingest/catalog",
                     json=_slice_catalog(payload, objects[half:], 2, 2, job_id, True))
    assert r2.status_code == 200, r2.text
    assert r2.json()["snapshot_id"] == r1.json()["snapshot_id"]  # 같은 스냅샷에 이어붙임

    job = client.get(f"/api/collect/jobs/{job_id}").json()
    assert job["stage"] == "catalog_done"
    assert job["counts"]["objects"] == len(objects)
    assert _count(migrated_engine, "objects") == len(objects)
    assert _count(migrated_engine, "columns") == len(payload["columns"])
    # 청크 경계를 넘는 FK가 전체 맵으로 해석됐는지 / cross-chunk FKs resolve via full maps
    assert _count(migrated_engine, "fk_columns") == sum(
        len(fk["columns"]) for fk in payload["foreign_keys"]
    )


def test_ingest_catalog_chunk_without_job_is_400(client, load_fixture):
    payload = load_fixture("catalog.json")
    res = client.post("/api/ingest/catalog",
                      json={**payload, "chunk_index": 2, "chunk_total": 3})
    assert res.status_code == 400
    assert "collect_job_id" in res.json()["error"]["message"]


def test_ingest_view_deps_chunked_finalizes_on_last(client, migrated_engine, load_fixture):
    snapshot_id, _ = _ingest_catalog(client, load_fixture)
    vd = load_fixture("view_deps.json")
    job_id = _create_job(migrated_engine)
    deps = vd["deps"]
    half = len(deps) // 2

    r1 = client.post("/api/ingest/view-deps", json={
        "snapshot_id": snapshot_id, "collect_job_id": job_id,
        "chunk_index": 1, "chunk_total": 2, "deps": deps[:half],
        "unresolved_objects": [],
    })
    assert r1.status_code == 200, r1.text
    snap_t = Base.metadata.tables["snapshots"]
    with migrated_engine.connect() as conn:
        status = conn.execute(
            sa.select(snap_t.c.status).where(snap_t.c.id == snapshot_id)).scalar_one()
    assert status == "collecting"  # 중간 청크는 ready 전환 없음
    job = client.get(f"/api/collect/jobs/{job_id}").json()
    assert job["counts"]["deps_chunks_done"] == 1

    r2 = client.post("/api/ingest/view-deps", json={
        "snapshot_id": snapshot_id, "collect_job_id": job_id,
        "chunk_index": 2, "chunk_total": 2, "deps": deps[half:],
        "unresolved_objects": vd.get("unresolved_objects", []),
    })
    assert r2.status_code == 200, r2.text
    counts = r2.json()["counts"]
    assert counts["deps"] == len(deps)  # 전 청크 누적이 lineage 입력
    assert counts["lineage_rows"] > 0
    with migrated_engine.connect() as conn:
        status = conn.execute(
            sa.select(snap_t.c.status).where(snap_t.c.id == snapshot_id)).scalar_one()
    assert status == "ready"
