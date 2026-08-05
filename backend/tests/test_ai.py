"""AI endpoint tests — suggestions never become facts. / AI 엔드포인트 테스트 (계획 Phase 5)."""

import json
from datetime import UTC, datetime

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker

from app.adapters.ai import AiTableHit, CandidatePair, ColumnMeta, FakeAiClient, TableMeta
from app.adapters.llm_ai import AiUnavailableError, LlmAiClient
from app.api.ai import get_ai_session_factory, select_ai_candidates
from app.config import Settings
from app.domain import scoring
from app.models import AiEmbedding, AiJob, Base, CatalogColumn, CatalogObject, Relation, Snapshot, ViewLineageFlat
from app.services import ai_search
from app.services.ai_chat import CHAT_RELATIONS_LIMIT, CHAT_TOP_K, build_chat_context
from app.services.ai_search import search_tables_smart


def _seed(client, load_fixture) -> None:
    sid = client.post("/api/ingest/catalog", json=load_fixture("catalog.json")).json()["snapshot_id"]
    client.post("/api/ingest/view-deps",
                json={**load_fixture("view_deps.json"), "snapshot_id": sid})


@pytest.fixture()
def ai_job_client(client, migrated_engine):
    """suggest 백그라운드 잡의 세션 팩토리를 테스트 SQLite로 고정 (scan 테스트의 sclient와 동일 패턴, 사이클2 §5)."""
    client.app.dependency_overrides[get_ai_session_factory] = lambda: sessionmaker(bind=migrated_engine)
    return client


def _run_suggest_job(client) -> dict:
    """202 시작 → 완료 폴링 헬퍼 / start then poll to completion."""
    start = client.post("/api/ai/suggest-relations")
    assert start.status_code == 202
    job = client.get(f"/api/ai/jobs/{start.json()['job_id']}").json()
    assert job["status"] == "done", job.get("error")
    return job["result"]


def _pair(src_object, src_column, tgt_object, tgt_column, signals):
    return CandidatePair(
        src_object=src_object, src_column=src_column, src_type="int",
        src_is_pk=False, src_row_count=100,
        tgt_object=tgt_object, tgt_column=tgt_column, tgt_type="int",
        tgt_is_pk=True, tgt_row_count=50,
        score=52, signals=signals,
    )


def test_fake_client_judges_by_name_affinity_and_view_join():
    pairs = [
        _pair("dbo.T_ORD", "EMPNO", "dbo.T_EMP", "EMP_NO", ["key", "naming"]),
        _pair("dbo.T_A", "X_ID", "dbo.T_B", "Y_ID", ["view_join"]),
        _pair("dbo.T_C", "AAA", "dbo.T_D", "BBB", ["key"]),
    ]
    judgements = FakeAiClient().judge_relations(pairs)
    assert len(judgements) == len(pairs)  # 판정 전체 반환 — 기각도 포함
    by_key = {(j.src_object, j.src_column, j.tgt_object, j.tgt_column): j for j in judgements}
    assert by_key[("dbo.T_ORD", "EMPNO", "dbo.T_EMP", "EMP_NO")].accepted is True
    assert by_key[("dbo.T_A", "X_ID", "dbo.T_B", "Y_ID")].accepted is True
    assert by_key[("dbo.T_C", "AAA", "dbo.T_D", "BBB")].accepted is False  # 신호 없는 페어는 기각(반환은 됨)


def _col(cid, qname, name, is_pk=False):
    return scoring.ScoringColumn(
        column_id=cid, object_qname=qname, object_type="table", name=name,
        data_type="int", max_length=4, is_pk=is_pk, is_computed=False,
        distinct_count=100,
    )


def test_select_ai_candidates_prefers_pk_direction_and_caps():
    cols = {
        1: _col(1, "dbo.T_EMP", "EMP_NO", is_pk=True),
        2: _col(2, "dbo.T_ORD", "EMPNO"),
        3: _col(3, "dbo.T_ORD", "ORD_NO", is_pk=True),
        4: _col(4, "dbo.T_SHP", "ORD_NO"),
    }
    ranked = select_ai_candidates(cols, view_pairs=set(), fk_pairs=set(),
                                  min_distinct=50, blacklist=set(), max_pairs=1,
                                  existing=set())
    assert len(ranked) == 1  # 상한 적용
    src, cand = ranked[0]
    # 정확 동명(40+key20=60) > 정규화 변형(32+20=52) — 방향은 PK 쪽이 타깃
    assert (src.object_qname, src.name) == ("dbo.T_SHP", "ORD_NO")
    assert (cand.target.object_qname, cand.target.name) == ("dbo.T_ORD", "ORD_NO")


def test_select_ai_candidates_includes_view_join_pairs():
    cols = {
        1: _col(1, "dbo.T_A", "HDR_KEY"),
        2: _col(2, "dbo.T_B", "REF_CODE"),
    }
    ranked = select_ai_candidates(cols, view_pairs={frozenset((1, 2))},
                                  fk_pairs=set(), min_distinct=50,
                                  blacklist=set(), max_pairs=10, existing=set())
    # 이름이 달라도 뷰 JOIN 증거만으로 후보가 된다
    assert len(ranked) == 1
    assert ranked[0][1].signals.get("view_join") == scoring.WEIGHT_VIEW_JOIN


def test_select_ai_candidates_dedupes_before_cap_so_reruns_page_onward():
    cols = {
        1: _col(1, "dbo.T_EMP", "EMP_NO", is_pk=True),
        2: _col(2, "dbo.T_ORD", "EMPNO"),
        3: _col(3, "dbo.T_ORD", "ORD_NO", is_pk=True),
        4: _col(4, "dbo.T_SHP", "ORD_NO"),
    }
    # 1위 페어(T_SHP.ORD_NO -> T_ORD.ORD_NO, 60점)가 이미 관계로 존재한다고 가정
    existing = {("dbo.T_SHP", "ORD_NO", "dbo.T_ORD", "ORD_NO")}
    ranked = select_ai_candidates(cols, view_pairs=set(), fk_pairs=set(),
                                  min_distinct=50, blacklist=set(), max_pairs=1,
                                  existing=existing)
    assert len(ranked) == 1
    src, cand = ranked[0]
    # 상한(1) 적용 전에 1위가 걸러져야 2위가 다음 실행에서 판정 대상이 된다
    assert (src.object_qname, src.name) == ("dbo.T_ORD", "EMPNO")
    assert (cand.target.object_qname, cand.target.name) == ("dbo.T_EMP", "EMP_NO")


def test_fake_client_search_ranks_by_term_overlap():
    tables = [
        TableMeta("dbo.T_SHP_RSLT", [ColumnMeta("SHIP_QTY", "int")]),
        TableMeta("dbo.T_HR_MST", [ColumnMeta("EMP_NO", "int")]),
    ]
    hits = FakeAiClient().search_tables("SHP RSLT", tables)
    assert hits and hits[0].qname == "dbo.T_SHP_RSLT"
    assert all(h.qname != "dbo.T_HR_MST" for h in hits)


def test_suggest_relations_creates_ai_candidates_only(ai_job_client, migrated_engine, load_fixture):
    _seed(ai_job_client, load_fixture)
    body = _run_suggest_job(ai_job_client)
    assert body["created"] > 0

    with migrated_engine.connect() as conn:
        rel_t = Base.metadata.tables["relations"]
        rows = conn.execute(sa.select(rel_t)).all()
    ai_rows = [r for r in rows if r.origin == "ai"]
    # 판정 전체(수용+기각)가 적재된다 — 기각도 origin='ai'로 기록 (사이클2 §1·2)
    assert len(ai_rows) == body["created"] + body["rejected"]
    # AI 출력은 절대 confirmed로 저장되지 않는다 (계획 §5.2)
    assert all(r.status in ("candidate", "rejected") for r in ai_rows)
    assert sum(1 for r in ai_rows if r.status == "candidate") == body["created"]
    assert sum(1 for r in ai_rows if r.status == "rejected") == body["rejected"]


def test_suggest_relations_pages_without_dupes_then_exhausts(ai_job_client, migrated_engine, load_fixture):
    _seed(ai_job_client, load_fixture)
    total_created = 0
    total_rejected = 0
    for _ in range(30):  # 597후보/40상한 ≈ 15회 — 여유 상한, 무한루프 가드
        body = _run_suggest_job(ai_job_client)
        total_created += body["created"]
        total_rejected += body["rejected"]
        if body["created"] + body["rejected"] == 0:
            break
    else:
        pytest.fail("paging never exhausted")
    # 상한 너머로 페이징됐다 — 구 버그(1회용 상한) 회귀 가드
    # Fake는 후보 우주(view_join ∪ 동명↔PK) 전량을 수용하므로 이 엔드포인트 흐름에서
    # total_rejected는 항상 0 — 원래 단언 그대로 성립
    assert total_created > 40
    # 소진 후 재실행도 0 — 멱등 종착 (양쪽 다 대칭)
    exhausted = _run_suggest_job(ai_job_client)
    assert exhausted["created"] == 0 and exhausted["rejected"] == 0
    # 전 구간 중복 적재 없음 (방향 키 기준)
    with migrated_engine.connect() as conn:
        rel_t = Base.metadata.tables["relations"]
        rows = conn.execute(sa.select(rel_t)).all()
    keys = [(r.src_object, r.src_column, r.tgt_object, r.tgt_column)
            for r in rows if r.origin == "ai"]
    assert len(keys) == len(set(keys))
    assert len(keys) == total_created + total_rejected


def test_ai_candidate_cannot_be_confirmed_without_validation(ai_job_client, migrated_engine, load_fixture):
    _seed(ai_job_client, load_fixture)
    created = _run_suggest_job(ai_job_client)["items"]
    target = created[0]

    obj_t, col_t = Base.metadata.tables["objects"], Base.metadata.tables["columns"]

    def col_id(qname: str, col: str) -> int:
        schema, table = qname.split(".", 1)
        with migrated_engine.connect() as conn:
            return conn.execute(
                sa.select(col_t.c.id)
                .join(obj_t, col_t.c.object_id == obj_t.c.id)
                .where(obj_t.c.schema == schema, obj_t.c.name == table,
                       col_t.c.name == col)
            ).scalar_one()

    res = ai_job_client.post("/api/relations/confirm", json={
        "src_column_id": col_id(target["src_object"], target["src_column"]),
        "tgt_column_id": col_id(target["tgt_object"], target["tgt_column"]),
    })
    assert res.status_code == 400
    assert "validation" in res.json()["error"]["message"]


def test_ai_candidates_render_as_ai_suggested_edges(ai_job_client, migrated_engine, load_fixture):
    _seed(ai_job_client, load_fixture)
    created = _run_suggest_job(ai_job_client)["items"]
    target = created[0]
    _, table = target["src_object"].split(".", 1)
    items = ai_job_client.get("/api/objects", params={"q": table}).json()["items"]
    anchor = next(i for i in items if f"{i['schema']}.{i['name']}" == target["src_object"])
    graph = ai_job_client.get(f"/api/objects/{anchor['id']}/graph").json()
    assert any(e["kind"] == "ai_suggested" for e in graph["edges"])


def test_search_tables_endpoint(client, load_fixture):
    _seed(client, load_fixture)
    body = client.get("/api/ai/search-tables", params={"q": "ZZQX_NOPE"}).json()
    assert body["items"] == []  # 매칭 없음 — 빈 결과 상태
    assert body["mode"] == "keyword"  # Fake 경로(임베딩 미설정)는 항상 키워드 — 사이클2 Task 9

    manifest = load_fixture("manifest.json")
    trap = manifest["cases"]["low_cardinality"][0]
    table_name = trap.rsplit(".", 1)[0].split(".", 1)[1]
    body = client.get("/api/ai/search-tables", params={"q": table_name}).json()
    assert body["items"] and body["items"][0]["object"].endswith(table_name)
    assert body["items"][0]["object_id"] is not None
    assert body["mode"] == "keyword"


# 사이클2 Task 9: search_tables_smart — 임베딩 우선 + 자동 키워드 폴백
#
# 핵심 계약: 검색은 임베딩 문제(미설정/호출 실패/빈 인덱스)로 502가 되지 않는다.
# 폴백 경로는 실제 LLM 호출 없이 검증하도록 프리필터가 빈 결과가 되는 질의를 쓴다
# (LlmAiClient.search_tables가 조기 반환해 네트워크 호출 자체가 없다).


def _embed_settings(**overrides) -> Settings:
    defaults = dict(_env_file=None, ai_base_url="http://llm:11434/v1", ai_embed_model="e")
    defaults.update(overrides)
    return Settings(**defaults)


def test_search_tables_smart_uses_keyword_when_embed_model_unset(migrated_engine):
    """모델 미설정 — Fake든 뭐든 임베딩 분기 자체를 타지 않고 바로 키워드."""
    settings = _embed_settings(ai_embed_model="")
    tables = [TableMeta("dbo.T_ORD", [ColumnMeta("ORD_NO", "int")])]
    with sessionmaker(bind=migrated_engine)() as db:
        mode, hits = search_tables_smart(db, "ORD", tables, FakeAiClient(), settings)
    assert mode == "keyword"
    assert hits == FakeAiClient().search_tables("ORD", tables)


def test_search_tables_smart_falls_back_when_index_empty(migrated_engine, monkeypatch):
    """모델은 설정됐지만 해당 모델의 AiEmbedding 행이 하나도 없음 — embed_texts 호출 없이 키워드."""
    calls: list = []
    monkeypatch.setattr(ai_search, "embed_texts", lambda *a, **k: calls.append(a) or [[1.0]])

    settings = _embed_settings()
    tables = [TableMeta("dbo.T_ORD", [ColumnMeta("ORD_NO", "int")])]
    ai = LlmAiClient(base_url="http://llm:11434/v1", model="m", api_key="", timeout=30)
    with sessionmaker(bind=migrated_engine)() as db:
        mode, hits = search_tables_smart(db, "ZZQX_NOPE", tables, ai, settings)
    assert mode == "keyword"
    assert hits == []
    assert calls == []  # 빈 인덱스는 embed_texts를 호출하지 않고 바로 폴백


def test_search_tables_smart_falls_back_when_embed_texts_unavailable(
    migrated_engine, monkeypatch, caplog,
):
    """embed_texts 호출 실패(AiUnavailableError) — 502 아니라 warning 로그 후 키워드."""
    def _boom(*args, **kwargs):
        raise AiUnavailableError("embeddings request failed after retries", {"cause": "boom"})

    monkeypatch.setattr(ai_search, "embed_texts", _boom)

    settings = _embed_settings()
    tables = [TableMeta("dbo.T_ORD", [ColumnMeta("ORD_NO", "int")])]
    ai = LlmAiClient(base_url="http://llm:11434/v1", model="m", api_key="", timeout=30)
    with sessionmaker(bind=migrated_engine)() as db:
        db.add(AiEmbedding(object_qname="dbo.T_ORD", model="e", vector="[1.0]",
                           source_hash="h", updated_at=datetime.now(UTC)))
        db.commit()
        with caplog.at_level("WARNING"):
            mode, hits = search_tables_smart(db, "ZZQX_NOPE", tables, ai, settings)
    assert mode == "keyword"
    assert hits == []
    assert any("falling back" in r.message for r in caplog.records)


def test_search_tables_smart_uses_embedding_path_and_ranks_by_cosine(
    migrated_engine, monkeypatch,
):
    """임베딩 인덱스 가용 — 코사인 상위가 rerank_tables 입력이 되고 mode는 embedding."""
    monkeypatch.setattr(ai_search, "embed_texts", lambda *a, **k: [[1.0, 0.0]])
    captured: dict = {}

    def _fake_rerank(self, query, candidates):
        captured["candidates"] = candidates
        return [AiTableHit(qname=candidates[0].qname, score=0.9, reason="stub")]

    monkeypatch.setattr(LlmAiClient, "rerank_tables", _fake_rerank)

    tables = [
        TableMeta("dbo.T_CLOSE", [ColumnMeta("A", "int")]),
        TableMeta("dbo.T_FAR", [ColumnMeta("B", "int")]),
    ]
    settings = _embed_settings()
    ai = LlmAiClient(base_url="http://llm:11434/v1", model="m", api_key="", timeout=30)
    now = datetime.now(UTC)
    with sessionmaker(bind=migrated_engine)() as db:
        db.add(AiEmbedding(object_qname="dbo.T_CLOSE", model="e",
                           vector=json.dumps([1.0, 0.0]), source_hash="h1", updated_at=now))
        db.add(AiEmbedding(object_qname="dbo.T_FAR", model="e",
                           vector=json.dumps([0.0, 1.0]), source_hash="h2", updated_at=now))
        db.commit()
        mode, hits = search_tables_smart(db, "query text", tables, ai, settings)

    assert mode == "embedding"
    # T_CLOSE(코사인 1.0)가 T_FAR(코사인 0.0)보다 먼저 — rerank 입력 순서로 확인
    assert [t.qname for t in captured["candidates"]] == ["dbo.T_CLOSE", "dbo.T_FAR"]
    assert hits[0].qname == "dbo.T_CLOSE"


def test_search_tables_smart_propagates_rerank_failure_without_fallback(
    migrated_engine, monkeypatch,
):
    """임베딩 경로에서 rerank_tables(실제 LLM 호출) 실패는 폴백 대상이 아니라 502 전파 대상 —
    순수 의미 질의에서 LLM 장애를 200 빈 결과로 은폐하면 안 된다 (리뷰 Critical 1)."""
    monkeypatch.setattr(ai_search, "embed_texts", lambda *a, **k: [[1.0, 0.0]])

    def _boom_rerank(self, query, candidates):
        raise AiUnavailableError("llm request failed after retries", {"cause": "down"})

    monkeypatch.setattr(LlmAiClient, "rerank_tables", _boom_rerank)

    tables = [TableMeta("dbo.T_CLOSE", [ColumnMeta("A", "int")])]
    settings = _embed_settings()
    ai = LlmAiClient(base_url="http://llm:11434/v1", model="m", api_key="", timeout=30)
    now = datetime.now(UTC)
    with sessionmaker(bind=migrated_engine)() as db:
        db.add(AiEmbedding(object_qname="dbo.T_CLOSE", model="e",
                           vector=json.dumps([1.0, 0.0]), source_hash="h1", updated_at=now))
        db.commit()
        with pytest.raises(AiUnavailableError):
            search_tables_smart(db, "query text", tables, ai, settings)


def test_search_tables_smart_skips_corrupt_vector_rows(migrated_engine, monkeypatch, caplog):
    """손상 vector 행은 스킵하고 나머지로 임베딩 경로를 유지 — 인덱스 일부 손상이 검색
    전체를 죽이면 안 된다 (리뷰 Critical 2)."""
    monkeypatch.setattr(ai_search, "embed_texts", lambda *a, **k: [[1.0, 0.0]])
    monkeypatch.setattr(
        LlmAiClient, "rerank_tables",
        lambda self, query, candidates: [
            AiTableHit(qname=candidates[0].qname, score=0.9, reason="stub")
        ],
    )

    tables = [TableMeta("dbo.T_OK", [ColumnMeta("A", "int")])]
    settings = _embed_settings()
    ai = LlmAiClient(base_url="http://llm:11434/v1", model="m", api_key="", timeout=30)
    now = datetime.now(UTC)
    with sessionmaker(bind=migrated_engine)() as db:
        db.add(AiEmbedding(object_qname="dbo.T_OK", model="e",
                           vector=json.dumps([1.0, 0.0]), source_hash="h1", updated_at=now))
        db.add(AiEmbedding(object_qname="dbo.T_BROKEN", model="e",
                           vector="not-json", source_hash="h2", updated_at=now))
        db.commit()
        with caplog.at_level("WARNING"):
            mode, hits = search_tables_smart(db, "query text", tables, ai, settings)
    assert mode == "embedding"
    assert hits[0].qname == "dbo.T_OK"
    assert any("corrupt" in r.message for r in caplog.records)


def test_search_tables_smart_falls_back_when_all_vectors_corrupt(migrated_engine, monkeypatch):
    """전부 손상이면 rows가 비어 embed_texts조차 호출하지 않고 키워드로."""
    calls: list = []
    monkeypatch.setattr(ai_search, "embed_texts", lambda *a, **k: calls.append(a) or [[1.0]])

    tables = [TableMeta("dbo.T_ORD", [ColumnMeta("ORD_NO", "int")])]
    settings = _embed_settings()
    ai = LlmAiClient(base_url="http://llm:11434/v1", model="m", api_key="", timeout=30)
    with sessionmaker(bind=migrated_engine)() as db:
        db.add(AiEmbedding(object_qname="dbo.T_ORD", model="e", vector="not-json",
                           source_hash="h", updated_at=datetime.now(UTC)))
        db.commit()
        mode, hits = search_tables_smart(db, "ZZQX_NOPE", tables, ai, settings)
    assert mode == "keyword"
    assert hits == []
    assert calls == []


def test_summarize_caches_and_feeds_graph_tooltip(client, load_fixture):
    """실 LLM 산출물만 캐시·툴팁으로 흘러간다 — 목업은 캐시 대상이 아니라 실 클라이언트로 검증."""
    from app.api.ai import get_ai_client

    _seed(client, load_fixture)
    rel = load_fixture("expected/relations.json")["rows"][0]
    _, table = rel["src_object"].split(".", 1)
    items = client.get("/api/objects", params={"q": table}).json()["items"]
    anchor = next(i for i in items if f"{i['schema']}.{i['name']}" == rel["src_object"])

    class _RealAi:
        def summarize_table(self, table_meta, base_tables):
            return f"{table_meta.qname} — 요약"

    client.app.dependency_overrides[get_ai_client] = lambda: _RealAi()
    try:
        first = client.post(f"/api/ai/summarize/{anchor['id']}").json()
        assert first["cached"] is False and first["mock"] is False
        assert rel["src_object"] in first["summary"]
        second = client.post(f"/api/ai/summarize/{anchor['id']}").json()
        assert second["cached"] is True and second["summary"] == first["summary"]
    finally:
        client.app.dependency_overrides.pop(get_ai_client)

    graph = client.get(f"/api/objects/{anchor['id']}/graph").json()
    me = next(n for n in graph["nodes"] if n["id"] == anchor["id"])
    assert me["ai_summary"] == first["summary"]



def test_explain_view_narrates_lineage_and_columns(client, load_fixture):
    _seed(client, load_fixture)
    view = client.get("/api/objects?q=V_&type=view&limit=1").json()["items"][0]
    body = client.post(f"/api/ai/explain-view/{view['id']}").json()
    assert body["object"] == f"{view['schema']}.{view['name']}"
    assert "컬럼" in body["explanation"]

    # 테이블에는 거부 / rejected for tables
    table_id = client.get("/api/objects?q=HR_EMP&type=table&limit=1").json()["items"][0]["id"]
    assert client.post(f"/api/ai/explain-view/{table_id}").status_code == 404


def test_explain_validation_requires_history_then_narrates(
    client, migrated_engine, fixture_dir, load_fixture,
):
    from app.adapters.fake_validator import FakeJoinValidator
    from app.api.validate import get_join_validator

    _seed(client, load_fixture)
    rel = next(
        r for r in load_fixture("expected/relations.json")["rows"]
        if r["kind"] == "real_no_fk" and r["orphan_count"] == 0
    )
    col_t, obj_t = Base.metadata.tables["columns"], Base.metadata.tables["objects"]

    def column_id(qname: str, column: str) -> int:
        schema, name = qname.split(".", 1)
        with migrated_engine.connect() as conn:
            return conn.execute(
                sa.select(col_t.c.id)
                .join(obj_t, col_t.c.object_id == obj_t.c.id)
                .where(obj_t.c.schema == schema, obj_t.c.name == name,
                       col_t.c.name == column)
            ).scalar_one()

    src_id = column_id(rel["src_object"], rel["src_column"])
    tgt_id = column_id(rel["tgt_object"], rel["tgt_column"])
    params = f"src_column_id={src_id}&tgt_column_id={tgt_id}"

    # 이력 없음 → 404 / no history yet
    assert client.post(f"/api/ai/explain-validation?{params}").status_code == 404

    # T2 관측 1회 후 진단 문장 생성 / narrates after one observation
    client.app.dependency_overrides[get_join_validator] = lambda: FakeJoinValidator(
        fixture_dir / "value_sets.json"
    )
    client.post("/api/validate/containment", json={
        "src_column_id": src_id, "tgt_column_id": tgt_id,
    })
    body = client.post(f"/api/ai/explain-validation?{params}").json()
    assert "100.0%" in body["explanation"]
    assert "우연" in body["explanation"]  # 관측 1회 → small_sample_only 진단


# Task 7: AiUnavailableError → 502 게이트웨이 오류 매핑
# 사이클2 Task 5: suggest가 202+백그라운드로 전환되며 예외는 요청 스레드가 아닌
# job 실행 중 발생 — app 예외 핸들러가 응답을 이미 보낸 뒤라 502로 못 잡히므로
# job.status="failed"/job.error 기록으로 검증 (run_ai_job의 502 비대상 주석 참조)

def test_ai_unavailable_marks_suggest_job_failed(ai_job_client, migrated_engine, load_fixture):
    """LLM 프로바이더 장애는 조용히 폴백하지 않고 job 실패로 기록된다."""
    from app.adapters.llm_ai import AiUnavailableError
    from app.api.ai import get_ai_client

    _seed(ai_job_client, load_fixture)

    class _DownAi:
        def judge_relations(self, candidates):
            raise AiUnavailableError("llm request failed after retries",
                                     {"url": "http://llm:11434/v1/chat/completions"})

    ai_job_client.app.dependency_overrides[get_ai_client] = lambda: _DownAi()
    try:
        start = ai_job_client.post("/api/ai/suggest-relations")
        assert start.status_code == 202
        job = ai_job_client.get(f"/api/ai/jobs/{start.json()['job_id']}").json()
    finally:
        ai_job_client.app.dependency_overrides.pop(get_ai_client)

    assert job["status"] == "failed"
    assert "llm" in job["error"]
    # 최종 전체 리뷰 Fix 4: AiUnavailableError.context(url)가 job.error에 보존된다
    assert "http://llm:11434/v1/chat/completions" in job["error"]


def test_ai_unavailable_maps_to_502_on_sync_endpoint(client, load_fixture):
    """동기 엔드포인트(search-tables 등)는 여전히 502 매핑 대상 — suggest만 잡 실패로 갈라졌을 뿐
    main.py의 AiUnavailableError 핸들러 자체가 죽은 코드가 되지 않았음을 가드한다."""
    from app.adapters.llm_ai import AiUnavailableError
    from app.api.ai import get_ai_client

    _seed(client, load_fixture)

    class _DownAi:
        def search_tables(self, q, tables):
            raise AiUnavailableError("llm request failed after retries",
                                     {"url": "http://llm:11434/v1/chat/completions"})

    client.app.dependency_overrides[get_ai_client] = lambda: _DownAi()
    try:
        res = client.get("/api/ai/search-tables", params={"q": "ZZ"})
    finally:
        client.app.dependency_overrides.pop(get_ai_client)

    assert res.status_code == 502
    body = res.json()["error"]
    assert body["code"] == 502
    assert "llm" in body["message"]
    assert "context" in body


# Task 3 (사이클2): 판정 근거 영속 + 기각 이력


def test_judgements_persist_reason_and_rejections(ai_job_client, migrated_engine, load_fixture):
    """수용은 candidate+reason, 기각은 rejected+reason — 재실행 자동 제외 (사이클2 §1·2)."""
    from app.api.ai import get_ai_client
    from app.adapters.ai import RelationJudgement

    _seed(ai_job_client, load_fixture)

    class _SplitAi:
        def judge_relations(self, candidates):
            out = []
            for i, c in enumerate(candidates):
                out.append(RelationJudgement(
                    src_object=c.src_object, src_column=c.src_column,
                    tgt_object=c.tgt_object, tgt_column=c.tgt_column,
                    accepted=(i % 2 == 0), reason=f"근거 {i}",
                ))
            return out

    ai_job_client.app.dependency_overrides[get_ai_client] = lambda: _SplitAi()
    try:
        first = _run_suggest_job(ai_job_client)
        second = _run_suggest_job(ai_job_client)
    finally:
        ai_job_client.app.dependency_overrides.pop(get_ai_client)

    assert first["created"] > 0 and first["rejected"] > 0

    with migrated_engine.connect() as conn:
        rel_t = Base.metadata.tables["relations"]
        rows = conn.execute(sa.select(rel_t).where(rel_t.c.origin == "ai")).all()
    assert all(r.reason for r in rows)
    statuses = {r.status for r in rows}
    assert statuses == {"candidate", "rejected"}
    # 기각분이 dedupe에 걸려 두 번째 실행은 같은 페어를 재판정하지 않는다
    first_keys = {(r.src_object, r.src_column, r.tgt_object, r.tgt_column) for r in rows}
    assert len(first_keys) == len(rows)  # 중복 적재 없음
    assert second["suggested"] == 0 or second["created"] + second["rejected"] > 0  # 다음 창으로 전진


def test_rejected_relations_never_render_as_edges(ai_job_client, migrated_engine, load_fixture):
    """기각 relation은 그래프 엣지로 그려지지 않는다.

    FakeAiClient는 후보 우주(view_join ∪ 동명↔PK)를 전량 수용하므로 이 엔드포인트
    흐름에서는 rejected 행이 생기지 않아 공허 통과한다 — _SplitAi로 기각을 강제
    생성해 실제로 검증되게 한다 (사이클2 리뷰 Finding 1).
    """
    from app.api.ai import get_ai_client
    from app.adapters.ai import RelationJudgement

    _seed(ai_job_client, load_fixture)

    class _SplitAi:
        def judge_relations(self, candidates):
            return [
                RelationJudgement(
                    src_object=c.src_object, src_column=c.src_column,
                    tgt_object=c.tgt_object, tgt_column=c.tgt_column,
                    accepted=(i % 2 == 0), reason=f"근거 {i}",
                )
                for i, c in enumerate(candidates)
            ]

    ai_job_client.app.dependency_overrides[get_ai_client] = lambda: _SplitAi()
    try:
        body = _run_suggest_job(ai_job_client)
    finally:
        ai_job_client.app.dependency_overrides.pop(get_ai_client)

    assert body["created"] > 0  # index 0은 항상 수용 — 앵커 선정 근거
    target = body["items"][0]
    _, table = target["src_object"].split(".", 1)
    anchor = ai_job_client.get("/api/objects", params={"q": table}).json()["items"][0]
    graph = ai_job_client.get(f"/api/objects/{anchor['id']}/graph?depth=3").json()
    assert graph["edges"]  # 앵커에 실제 엣지가 잡힌다 — 공허 통과 방지 선행 단언

    with migrated_engine.connect() as conn:
        rel_t = Base.metadata.tables["relations"]
        rejected = conn.execute(
            sa.select(rel_t).where(rel_t.c.status == "rejected")).all()
    rejected_ids = {f"rel-{r.id}" for r in rejected}
    assert rejected_ids  # 기각 행이 실제로 존재 — 이중 공허 방지 선행 단언
    assert all(e["id"] not in rejected_ids for e in graph["edges"])


def test_ai_suggested_edges_carry_reason(ai_job_client, migrated_engine, load_fixture):
    _seed(ai_job_client, load_fixture)
    body = _run_suggest_job(ai_job_client)
    assert body["created"] > 0
    target = body["items"][0]
    _, table = target["src_object"].split(".", 1)
    anchor = ai_job_client.get("/api/objects", params={"q": table}).json()["items"][0]
    graph = ai_job_client.get(f"/api/objects/{anchor['id']}/graph").json()
    ai_edges = [e for e in graph["edges"] if e["kind"] == "ai_suggested"]
    assert ai_edges and all(e.get("reason") for e in ai_edges)


# 사이클2 Task 5: suggest 202 전환 — 동시 실행 가드


def test_start_suggest_job_conflicts_with_active_job(client, migrated_engine):
    """같은 kind(suggest)의 queued/running 잡이 있으면 새 시작은 409 (사이클2 §5)."""
    session_factory = sessionmaker(bind=migrated_engine)
    with session_factory() as db:
        db.add(AiJob(kind="suggest", status="queued", progress_done=0, progress_total=1,
                      triggered_by="test", created_at=datetime.now(UTC)))
        db.commit()

    res = client.post("/api/ai/suggest-relations")
    assert res.status_code == 409


# 최종 전체 리뷰 Fix 1: 재기동 고아 잡 정리


def test_startup_fails_orphaned_ai_jobs(migrated_engine, monkeypatch):
    """재기동으로 실행 주체(BackgroundTasks)를 잃은 queued/running 잡은 startup 훅이 failed로 정리한다.

    startup 훅은 DI를 거치지 않고 app.db.get_session_factory를 직접 호출하므로 그 함수를
    테스트 SQLite로 monkeypatch한다. bare TestClient(app)는 lifespan을 타지 않으므로
    with 블록으로 명시적으로 기동한다.
    """
    from fastapi.testclient import TestClient

    from app.main import create_app

    session_factory = sessionmaker(bind=migrated_engine)
    with session_factory() as db:
        db.add(AiJob(kind="suggest", status="running", progress_done=0, progress_total=1,
                      triggered_by="test", created_at=datetime.now(UTC)))
        db.commit()

    monkeypatch.setattr("app.db.get_session_factory", lambda: session_factory)

    with TestClient(create_app()):
        pass

    with session_factory() as db:
        job = db.execute(sa.select(AiJob)).scalars().one()
    assert job.status == "failed"
    assert job.error == "interrupted by restart"


# 최종 전체 리뷰 Fix 2: 미판정 페어 무신호 (페이징 정체 관측성)


def test_suggest_result_reports_unjudged_pairs(ai_job_client, migrated_engine, load_fixture):
    """LLM이 후보 일부의 판정을 누락하면 unjudged로 드러난다 — 무신호 페이징 정체 방지."""
    from app.adapters.ai import RelationJudgement
    from app.api.ai import get_ai_client

    _seed(ai_job_client, load_fixture)

    class _PartialAi:
        def judge_relations(self, candidates):
            # 짝수 index만 판정 반환 — 홀수 index는 LLM 누락을 흉내낸다
            return [
                RelationJudgement(
                    src_object=c.src_object, src_column=c.src_column,
                    tgt_object=c.tgt_object, tgt_column=c.tgt_column,
                    accepted=True, reason="근거",
                )
                for i, c in enumerate(candidates) if i % 2 == 0
            ]

    ai_job_client.app.dependency_overrides[get_ai_client] = lambda: _PartialAi()
    try:
        body = _run_suggest_job(ai_job_client)
    finally:
        ai_job_client.app.dependency_overrides.pop(get_ai_client)

    assert body["suggested"] > 1  # 후보가 여러 건 있어야 누락이 의미 있다
    assert body["unjudged"] == body["suggested"] - (body["created"] + body["rejected"])
    assert body["unjudged"] > 0


# Task 10 (사이클2): build_chat_context — search_tables_smart 재사용 top-8 + 관계·lineage


def _new_snapshot(db) -> Snapshot:
    snap = Snapshot(collected_at=datetime.now(UTC), source_db="TEST", status="ready")
    db.add(snap)
    db.flush()
    return snap


def _add_table(db, snapshot_id: int, oid: int, name: str, columns: list[tuple[str, bool]]):
    obj = CatalogObject(snapshot_id=snapshot_id, schema="dbo", name=name,
                        type="table", object_id=oid, row_count=10)
    db.add(obj)
    db.flush()
    for i, (col_name, is_pk) in enumerate(columns, start=1):
        db.add(CatalogColumn(object_id=obj.id, name=col_name, ordinal=i, data_type="int",
                             max_length=4, is_nullable=False, is_pk=is_pk, is_computed=False))
    db.flush()
    return obj


def test_build_chat_context_returns_empty_when_no_search_hits(migrated_engine):
    """히트 없으면 빈 컨텍스트 — Fake의 '관련 테이블 없음' 경로로 이어진다."""
    with sessionmaker(bind=migrated_engine)() as db:
        snap = _new_snapshot(db)
        db.commit()
        tables = [TableMeta("dbo.T_ORD", [ColumnMeta("ORD_NO", "int", True)])]
        context = build_chat_context(db, snap.id, "ZZQX_NOPE", tables,
                                     FakeAiClient(), Settings(_env_file=None))
    assert context.tables == []


def test_build_chat_context_caps_at_top_eight(migrated_engine):
    """검색 히트가 8개를 넘어도 컨텍스트는 top-8만 담는다."""
    with sessionmaker(bind=migrated_engine)() as db:
        snap = _new_snapshot(db)
        tables = []
        for i in range(10):
            name = f"T_ORD_{i:02d}"
            _add_table(db, snap.id, 9_000_000 + i, name, [("ORD_NO", True)])
            tables.append(TableMeta(f"dbo.{name}", [ColumnMeta("ORD_NO", "int", True)]))
        db.commit()
        context = build_chat_context(db, snap.id, "ORD", tables,
                                     FakeAiClient(), Settings(_env_file=None))
    assert CHAT_TOP_K == 8
    assert len(context.tables) == 8
    # FakeAiClient는 동점을 qname 오름차순으로 깨므로 앞 8개가 선택된다
    assert [t.qname for t in context.tables] == [f"dbo.T_ORD_{i:02d}" for i in range(8)]


def test_build_chat_context_formats_relations_and_caps_at_ten(migrated_engine):
    """validated·confirmed만 'src.col → tgt.col (status)' 형식으로, 최대 10건."""
    with sessionmaker(bind=migrated_engine)() as db:
        snap = _new_snapshot(db)
        _add_table(db, snap.id, 9_100_000, "T_ANCHOR", [("ANCHOR_NO", True)])
        now = datetime.now(UTC)
        for i in range(12):  # 상한(10)보다 많은 validated/confirmed
            db.add(Relation(
                src_object="dbo.T_ANCHOR", src_column="ANCHOR_NO",
                tgt_object=f"dbo.T_TGT_{i:02d}", tgt_column="TGT_NO",
                status="validated" if i % 2 == 0 else "confirmed", origin="ai",
                confidence=0.9, cardinality="1:N", last_verified_at=now,
                reason=None, created_at=now,
            ))
        # candidate/rejected는 챗 컨텍스트에서 제외되어야 한다
        db.add(Relation(
            src_object="dbo.T_ANCHOR", src_column="ANCHOR_NO",
            tgt_object="dbo.T_NOISE", tgt_column="NOISE_NO",
            status="candidate", origin="ai", confidence=None, cardinality=None,
            last_verified_at=None, reason=None, created_at=now,
        ))
        db.commit()
        tables = [TableMeta("dbo.T_ANCHOR", [ColumnMeta("ANCHOR_NO", "int", True)])]
        context = build_chat_context(db, snap.id, "ANCHOR", tables,
                                     FakeAiClient(), Settings(_env_file=None))
    assert len(context.tables) == 1
    relations = context.tables[0].relations
    assert CHAT_RELATIONS_LIMIT == 10
    assert len(relations) == 10
    assert all(r.startswith("dbo.T_ANCHOR.ANCHOR_NO → dbo.T_TGT_") for r in relations)
    assert all(r.endswith("(validated)") or r.endswith("(confirmed)") for r in relations)
    assert not any("NOISE" in r for r in relations)  # candidate 상태는 제외


def test_build_chat_context_backtracks_base_tables_via_lineage(migrated_engine):
    """ViewLineageFlat 역추적 — summarize_object/explain_view와 동일한 쿼리 관용."""
    with sessionmaker(bind=migrated_engine)() as db:
        snap = _new_snapshot(db)
        anchor = _add_table(db, snap.id, 9_200_000, "V_ORD_SUMMARY", [("ORD_NO", False)])
        base = _add_table(db, snap.id, 9_200_001, "T_ORD_BASE", [("ORD_NO", True)])
        db.add(ViewLineageFlat(
            snapshot_id=snap.id, view_object_id=anchor.id, view_column="ORD_NO",
            base_object_id=base.id, base_column="ORD_NO", depth=1,
            mapping_kind="direct", flag=None,
        ))
        db.commit()
        tables = [TableMeta("dbo.V_ORD_SUMMARY", [ColumnMeta("ORD_NO", "int")])]
        context = build_chat_context(db, snap.id, "ORD", tables,
                                     FakeAiClient(), Settings(_env_file=None))
    assert context.tables[0].base_tables == ["dbo.T_ORD_BASE"]


# Task 10 (사이클2): POST /api/ai/chat — Fake 경로·mock 플래그·history 상한


def test_chat_endpoint_fake_path_returns_answer_mock_and_matching_tables(client, load_fixture):
    _seed(client, load_fixture)
    manifest = load_fixture("manifest.json")
    trap = manifest["cases"]["low_cardinality"][0]
    table_name = trap.rsplit(".", 1)[0].split(".", 1)[1]

    res = client.post("/api/ai/chat", json={"question": table_name})
    assert res.status_code == 200
    body = res.json()
    assert body["mock"] is True  # FakeAiClient 경로 (사이클2 §4)
    assert body["answer"]
    # tables는 서버가 컨텍스트에서 구성 — search-tables 테스트와 동일하게 최상위 히트만 단언
    # (Fake는 정규화 부분일치라 HR_EMP_FAMILY 등도 함께 매칭되지만 동점 tie-break로 정확 일치가 1위)
    assert body["tables"] and body["tables"][0].endswith(table_name)


def test_ai_content_endpoints_mark_mock_output(client, load_fixture):
    """AI 미연결 시 모든 AI 산출물에 mock 표시 — 휴리스틱 결과가 LLM 판단으로 오독되면 안 된다.

    chat만 표시하던 규약을 검색·요약·설명으로 확장 (FakeAiClient 전수조사 결과).
    """
    _seed(client, load_fixture)
    obj = client.get("/api/objects?q=HR_EMP&type=table&limit=1").json()["items"][0]
    view = client.get("/api/objects?type=view&limit=1").json()["items"][0]

    assert client.get("/api/ai/search-tables", params={"q": "HR"}).json()["mock"] is True
    assert client.post(f"/api/ai/summarize/{obj['id']}").json()["mock"] is True
    assert client.post(f"/api/ai/explain-view/{view['id']}").json()["mock"] is True


def test_mock_summaries_are_not_cached(client, load_fixture):
    """목업 요약을 캐시에 남기면 실 LLM 연결 후에도 가짜가 실값처럼 재사용된다."""
    _seed(client, load_fixture)
    obj = client.get("/api/objects?q=HR_EMP&type=table&limit=1").json()["items"][0]

    client.post(f"/api/ai/summarize/{obj['id']}")
    again = client.post(f"/api/ai/summarize/{obj['id']}").json()
    assert again["cached"] is False


def test_chat_endpoint_no_hits_falls_back_to_empty_context(client, load_fixture):
    _seed(client, load_fixture)
    res = client.post("/api/ai/chat", json={"question": "ZZQX_NOPE_ZZ"})
    assert res.status_code == 200
    body = res.json()
    assert body["tables"] == []
    assert "관련 테이블 없음" in body["answer"]  # Fake 목업 응답 경로


def test_chat_endpoint_rejects_history_over_six_turns(client, load_fixture):
    _seed(client, load_fixture)
    history = [{"role": "user", "content": f"질문 {i}"} for i in range(7)]
    res = client.post("/api/ai/chat", json={"question": "테스트 질문", "history": history})
    assert res.status_code == 422
