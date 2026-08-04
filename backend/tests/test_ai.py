"""AI endpoint tests — suggestions never become facts. / AI 엔드포인트 테스트 (계획 Phase 5)."""

from datetime import UTC, datetime

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker

from app.adapters.ai import CandidatePair, ColumnMeta, FakeAiClient, TableMeta
from app.api.ai import get_ai_session_factory, select_ai_candidates
from app.domain import scoring
from app.models import AiJob, Base


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

    manifest = load_fixture("manifest.json")
    trap = manifest["cases"]["low_cardinality"][0]
    table_name = trap.rsplit(".", 1)[0].split(".", 1)[1]
    body = client.get("/api/ai/search-tables", params={"q": table_name}).json()
    assert body["items"] and body["items"][0]["object"].endswith(table_name)
    assert body["items"][0]["object_id"] is not None


def test_summarize_caches_and_feeds_graph_tooltip(client, load_fixture):
    _seed(client, load_fixture)
    rel = load_fixture("expected/relations.json")["rows"][0]
    _, table = rel["src_object"].split(".", 1)
    items = client.get("/api/objects", params={"q": table}).json()["items"]
    anchor = next(i for i in items if f"{i['schema']}.{i['name']}" == rel["src_object"])

    first = client.post(f"/api/ai/summarize/{anchor['id']}").json()
    assert first["cached"] is False and rel["src_object"] in first["summary"]
    second = client.post(f"/api/ai/summarize/{anchor['id']}").json()
    assert second["cached"] is True and second["summary"] == first["summary"]

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
