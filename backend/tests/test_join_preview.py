"""N-웨이 조인 미리보기 엔드포인트 테스트. / multi-table join preview API."""

import pytest
import sqlalchemy as sa
from sqlalchemy import String

from app.api.validate import get_join_validator
from app.domain.validation import JoinStepRef
from app.models import AuditLog, Base

# 픽스처의 실제 FK — fixtures/catalog.json: FK_HR_EMP_FAMILY_HR_EMP
LEFT = ("dbo.HR_EMP_FAMILY", "EMP_NO")
RIGHT = ("dbo.HR_EMP", "EMP_NO")


class StubValidator:
    """실행문과 행을 고정 반환 — 스텝 배열을 그대로 캡처한다."""

    def __init__(self) -> None:
        self.steps = None
        self.limit = None

    def containment(self, src, tgt):  # pragma: no cover - 이 테스트에서 미사용
        raise NotImplementedError

    def preview(self, src, tgt, limit):  # pragma: no cover - 이 테스트에서 미사용
        raise NotImplementedError

    def multi_join_preview(self, steps, limit):
        self.steps = steps
        self.limit = limit
        return [{"HR_EMP_FAMILY.EMP_NO": "E001", "HR_EMP.EMP_NO": "E001"}], "SELECT TOP 20 ..."


@pytest.fixture()
def stub() -> StubValidator:
    return StubValidator()


@pytest.fixture()
def jclient(client, stub):
    client.app.dependency_overrides[get_join_validator] = lambda: stub
    return client


def _seed(client, load_fixture) -> None:
    sid = client.post("/api/ingest/catalog",
                      json=load_fixture("catalog.json")).json()["snapshot_id"]
    client.post("/api/ingest/view-deps",
                json={**load_fixture("view_deps.json"), "snapshot_id": sid})


def _column_id(engine, object_qname: str, column: str) -> int:
    schema, table = object_qname.split(".", 1)
    obj_t, col_t = Base.metadata.tables["objects"], Base.metadata.tables["columns"]
    with engine.connect() as conn:
        return conn.execute(
            sa.select(col_t.c.id)
            .join(obj_t, col_t.c.object_id == obj_t.c.id)
            .where(obj_t.c.schema == schema, obj_t.c.name == table, col_t.c.name == column)
        ).scalar_one()


def _step(engine, join_type: str = "inner") -> dict:
    return {
        "left_column_id": _column_id(engine, *LEFT),
        "right_column_id": _column_id(engine, *RIGHT),
        "join_type": join_type,
    }


def test_rejects_an_empty_step_list(jclient, load_fixture):
    _seed(jclient, load_fixture)
    res = jclient.post("/api/join/preview", json={"steps": []})
    # Pydantic min_length=1이 422로 막는다 / rejected by request validation
    assert res.status_code == 422


def test_rejects_more_than_eight_steps(jclient, migrated_engine, load_fixture):
    _seed(jclient, load_fixture)
    res = jclient.post("/api/join/preview",
                       json={"steps": [_step(migrated_engine)] * 9})
    assert res.status_code == 400
    assert "too many join steps" in str(res.json())


def test_rejects_a_disconnected_second_step(jclient, migrated_engine, load_fixture):
    """끊긴 조인은 곱집합이 된다 — 두 번째 스텝은 기존 테이블과 이어져야 한다."""
    _seed(jclient, load_fixture)
    far = {
        "left_column_id": _column_id(migrated_engine, "dbo.HR_CERT", "APPOINT_NO"),
        "right_column_id": _column_id(migrated_engine, "dbo.HR_APPOINT", "APPOINT_NO"),
        "join_type": "inner",
    }
    res = jclient.post("/api/join/preview",
                       json={"steps": [_step(migrated_engine), far]})
    assert res.status_code == 400
    assert "disconnected join step" in str(res.json())


def test_check_connectivity_rejects_left_join_between_already_bound_tables() -> None:
    """Finding 2 두 번째 증상 — 양쪽 다 이미 바인딩된 닫는 스텝은 새 JOIN이 아니라
    기존 clause에 AND로 붙어, 독립된 LEFT 방향이 없다. join_type=left를 조용히
    무시하면 UI는 LEFT 배지를 계속 보여주는데 SQL은 그걸 반영하지 않는 거짓 상태가
    된다 — 순수 함수라 DB 없이 바로 검증한다."""
    from app.api.join_preview import _check_connectivity

    steps = [
        JoinStepRef(left_schema="dbo", left_table="A", left_column="a1",
                    right_schema="dbo", right_table="B", right_column="b1",
                    join_type="inner"),
        JoinStepRef(left_schema="dbo", left_table="A", left_column="a2",
                    right_schema="dbo", right_table="B", right_column="b2",
                    join_type="left"),
    ]
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        _check_connectivity(steps)
    assert exc.value.status_code == 400
    assert "left join" in str(exc.value.detail).lower()


def test_maps_n8n_runtime_error_to_a_502_with_context(jclient, migrated_engine, load_fixture):
    """n8n_query._post_query가 재시도 후에도 실패하거나 W2가 실행문을 안 돌려주면
    RuntimeError를 올린다 — 잡지 않으면 프론트에 맨 500만 보이고 원인 설명이
    전달되지 않는다(Finding 5)."""
    _seed(jclient, load_fixture)

    class FailingValidator:
        def containment(self, src, tgt):  # pragma: no cover - 미사용
            raise NotImplementedError

        def preview(self, src, tgt, limit):  # pragma: no cover - 미사용
            raise NotImplementedError

        def multi_join_preview(self, steps, limit):
            raise RuntimeError("n8n query failed after retries: kind=multi_join_preview url=x")

    jclient.app.dependency_overrides[get_join_validator] = lambda: FailingValidator()
    res = jclient.post("/api/join/preview", json={"steps": [_step(migrated_engine)]})
    assert res.status_code == 502
    body = res.json()
    assert "n8n query failed after retries" in body["error"]["context"]["reason"]


def test_returns_rows_and_the_executed_sql(jclient, stub, migrated_engine, load_fixture):
    _seed(jclient, load_fixture)
    res = jclient.post("/api/join/preview",
                       json={"steps": [_step(migrated_engine, "left")]})

    assert res.status_code == 200
    body = res.json()
    assert body["query"] == "SELECT TOP 20 ..."
    assert body["limit"] == 20
    assert len(body["rows"]) == 1
    assert stub.limit == 20
    assert stub.steps[0].join_type == "left"
    assert stub.steps[0].left_table == "HR_EMP_FAMILY"
    assert stub.steps[0].right_table == "HR_EMP"


def test_writes_an_audit_log(jclient, migrated_engine, load_fixture):
    """원본 값이 나가는 지점 — 감사 없이 통과하면 안 된다."""
    _seed(jclient, load_fixture)
    jclient.post("/api/join/preview", json={"steps": [_step(migrated_engine)]})

    audit_t = Base.metadata.tables["audit_logs"]
    with migrated_engine.connect() as conn:
        actions = conn.execute(sa.select(audit_t.c.action)).scalars().all()
    assert "join_preview" in actions


def test_bounds_the_audit_detail_to_the_column_length():
    """8스텝 최대 조인 + MSSQL 식별자 상한(128자)로도 detail이 컬럼 길이를 넘지 않아야
    한다 — Postgres는 VARCHAR 길이를 커밋 시 강제해 넘치면 500이 된다(SQLite는
    강제하지 않아 테스트에서 이 결함이 안 잡혔었다)."""
    from app.api.join_preview import _TRUNCATION_MARKER, _build_audit_detail

    long_name = "x" * 128  # MSSQL 식별자 최대 길이
    refs = [
        JoinStepRef(
            left_schema=long_name, left_table=long_name, left_column=long_name,
            right_schema=long_name, right_table=long_name, right_column=long_name,
            join_type="inner",
        )
        for _ in range(8)
    ]
    # 하드코딩 대신 모델에서 직접 읽는다 — 컬럼을 나중에 넓혀도 이 값이 조용히 안 맞아지지 않게.
    # Column.type은 TypeEngine[Any]로 타입 지정돼 .length가 안 보인다 — join_preview.py의
    # isinstance 좁히기와 같은 패턴 적용 (narrows the generic TypeEngine to String).
    detail_type = AuditLog.__table__.c.detail.type
    assert isinstance(detail_type, String) and detail_type.length is not None
    limit = detail_type.length
    detail = _build_audit_detail(refs, row_count=20)
    assert len(detail) <= limit
    assert "8 steps" in detail and "20 rows" in detail
    # 마커가 빠지면 잘린 경로가 안 잘린 것처럼 보인다 — 절단 표시 자체를 회귀 감시
    assert _TRUNCATION_MARKER in detail


def test_reports_503_when_the_source_is_synthetic(client, migrated_engine, load_fixture):
    """FakeJoinValidator는 명시 실패 — 합성 조인 결과가 실값처럼 나가면 안 된다."""
    from app.adapters.fake_validator import FakeJoinValidator

    _seed(client, load_fixture)

    def _fake():
        return FakeJoinValidator.__new__(FakeJoinValidator)

    client.app.dependency_overrides[get_join_validator] = _fake
    res = client.post("/api/join/preview", json={"steps": [_step(migrated_engine)]})
    assert res.status_code == 503
