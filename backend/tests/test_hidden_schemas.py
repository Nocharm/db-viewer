"""HIDDEN_SCHEMAS policy — 이름은 남고 컬럼은 사라진다.

미리보기 허용 목록(test_preview_allowlist.py)과 축이 다르다: 그쪽은 "실제 값", 이쪽은
"구조(컬럼)"를 통제한다. 두 정책은 독립이며, 감춘 스키마는 허용 목록에 올라 있어도 막힌다.
"""

import pytest
import sqlalchemy as sa

from app.config import get_settings

SCHEMA = "dbo"  # 픽스처(catalog.json)의 유일한 스키마


def _seed(client, load_fixture) -> None:
    sid = client.post("/api/ingest/catalog",
                      json=load_fixture("catalog.json")).json()["snapshot_id"]
    client.post("/api/ingest/view-deps",
                json={**load_fixture("view_deps.json"), "snapshot_id": sid})


def _an_object(client) -> dict:
    return client.get("/api/objects?q=HR_EMP&type=table&limit=1").json()["items"][0]


def _column_id(migrated_engine, qname: str, column: str) -> int:
    from app.models import Base

    obj_t, col_t = Base.metadata.tables["objects"], Base.metadata.tables["columns"]
    schema, table = qname.split(".", 1)
    with migrated_engine.connect() as conn:
        return conn.execute(
            sa.select(col_t.c.id).join(obj_t, col_t.c.object_id == obj_t.c.id)
            .where(obj_t.c.schema == schema, obj_t.c.name == table, col_t.c.name == column)
        ).scalar_one()


@pytest.fixture()
def preview_password(monkeypatch):
    """토글 게이트는 미리보기 허용 목록과 같은 비밀번호를 쓴다 (test_preview_allowlist와 동일)."""
    password = "s3cret-preview"
    monkeypatch.setenv("PREVIEW_ADMIN_PASSWORD", password)
    get_settings.cache_clear()
    yield password
    monkeypatch.delenv("PREVIEW_ADMIN_PASSWORD", raising=False)
    get_settings.cache_clear()


@pytest.fixture()
def hide_schemas(monkeypatch):
    """테스트 도중 정책을 켠다 — 켜기 전에 id를 미리 확보해야 하는 검사들 때문에 필요하다.
    / flips the policy mid-test: several checks must resolve ids while still visible."""
    def hide(value: str) -> None:
        monkeypatch.setenv("HIDDEN_SCHEMAS", value)
        get_settings.cache_clear()

    yield hide
    monkeypatch.delenv("HIDDEN_SCHEMAS", raising=False)
    get_settings.cache_clear()


def test_the_list_endpoint_reports_the_configured_schemas(client, hide_schemas):
    assert client.get("/api/objects/hidden-schemas").json()["items"] == []
    hide_schemas("MAP, STG")
    assert client.get("/api/objects/hidden-schemas").json()["items"] == ["map", "stg"]


def test_the_render_toggle_defaults_to_hidden(client, hide_schemas):
    """행이 없으면 안 그린다 — 감추라고 설정했는데 목록에 보이면 설정이 안 먹은 것처럼 읽힌다."""
    hide_schemas(SCHEMA)
    assert client.get("/api/objects/hidden-schemas").json()["render"] is False


def test_the_render_toggle_is_password_gated(client, hide_schemas, preview_password):
    hide_schemas(SCHEMA)
    assert client.put("/api/admin/hidden-schema-render",
                      json={"render": True}).status_code == 401
    assert client.put("/api/admin/hidden-schema-render",
                      headers={"X-Preview-Password": "wrong"},
                      json={"render": True}).status_code == 401

    ok = client.put("/api/admin/hidden-schema-render",
                    headers={"X-Preview-Password": preview_password},
                    json={"render": True})
    assert ok.status_code == 200
    assert client.get("/api/objects/hidden-schemas").json()["render"] is True

    client.put("/api/admin/hidden-schema-render",
               headers={"X-Preview-Password": preview_password},
               json={"render": False})
    assert client.get("/api/objects/hidden-schemas").json()["render"] is False


def test_the_toggle_never_opens_the_columns(client, load_fixture, hide_schemas,
                                            preview_password):
    """표시 토글은 노출 정책이 아니다 — 켜도 컬럼은 계속 막혀 있어야 한다."""
    _seed(client, load_fixture)
    obj = _an_object(client)
    hide_schemas(SCHEMA)
    client.put("/api/admin/hidden-schema-render",
               headers={"X-Preview-Password": preview_password},
               json={"render": True})

    body = client.get(f"/api/objects/{obj['id']}/detail").json()
    assert body["hidden"] is True
    assert body["columns"] == []
    assert client.get(f"/api/objects/{obj['id']}/graph").status_code == 403


def test_the_admin_view_exposes_the_schemas_read_only(client, hide_schemas):
    """무엇을 감출지는 환경변수 영역 — 관리 API는 읽기만 준다."""
    hide_schemas("MAP")
    body = client.get("/api/admin/hidden-schema-render").json()
    assert body == {"render": False, "schemas": ["map"]}


def test_the_table_name_stays_searchable(client, load_fixture, hide_schemas):
    """이름은 감추지 않는다 — 다른 테이블에서 이어지는 관계를 읽으려면 필요하다."""
    _seed(client, load_fixture)
    hide_schemas(SCHEMA)
    items = client.get("/api/objects?q=HR_EMP&type=table&limit=1").json()["items"]
    assert items and items[0]["schema"] == SCHEMA


def test_detail_withholds_the_columns_but_keeps_the_object(client, load_fixture,
                                                           hide_schemas):
    _seed(client, load_fixture)
    obj = _an_object(client)
    assert client.get(f"/api/objects/{obj['id']}/detail").json()["columns"]

    hide_schemas(SCHEMA)
    body = client.get(f"/api/objects/{obj['id']}/detail").json()
    assert body["hidden"] is True
    assert body["columns"] == []
    assert body["name"].startswith(f"{SCHEMA}.")  # 이름은 그대로


def test_the_column_search_index_drops_hidden_schemas(client, load_fixture, hide_schemas):
    """인덱스가 남으면 컬럼명을 되찾을 수 있어 감춘 의미가 없다."""
    _seed(client, load_fixture)
    assert client.get("/api/objects/columns-index").json()["items"]

    hide_schemas(SCHEMA)
    assert client.get("/api/objects/columns-index").json()["items"] == []


def test_the_erd_graph_refuses_a_hidden_anchor(client, load_fixture, hide_schemas):
    _seed(client, load_fixture)
    obj = _an_object(client)
    assert client.get(f"/api/objects/{obj['id']}/graph").status_code == 200

    hide_schemas(SCHEMA)
    assert client.get(f"/api/objects/{obj['id']}/graph").status_code == 403


def test_candidates_are_refused_for_a_hidden_column(client, load_fixture, migrated_engine,
                                                    hide_schemas):
    _seed(client, load_fixture)
    cid = _column_id(migrated_engine, f"{SCHEMA}.HR_EMP", "EMP_NO")
    assert client.get(f"/api/columns/{cid}/candidates").status_code == 200

    hide_schemas(SCHEMA)
    assert client.get(f"/api/columns/{cid}/candidates").status_code == 403


def test_containment_is_refused_for_a_hidden_column(client, load_fixture, migrated_engine,
                                                    fixture_dir, hide_schemas):
    """컬럼을 감췄는데 id만 알면 판정이 되면 감춘 의미가 없다."""
    from app.adapters.fake_validator import FakeJoinValidator
    from app.api.validate import get_join_validator

    _seed(client, load_fixture)
    client.app.dependency_overrides[get_join_validator] = lambda: FakeJoinValidator(
        fixture_dir / "value_sets.json"
    )
    ids = {
        "src_column_id": _column_id(migrated_engine, f"{SCHEMA}.HR_EMP_FAMILY", "EMP_NO"),
        "tgt_column_id": _column_id(migrated_engine, f"{SCHEMA}.HR_EMP", "EMP_NO"),
    }
    assert client.post("/api/validate/containment", json=ids).status_code == 200

    hide_schemas(SCHEMA)
    blocked = client.post("/api/validate/containment", json=ids)
    assert blocked.status_code == 403
    assert blocked.json()["error"]["context"]["objects"] == [
        f"{SCHEMA}.HR_EMP", f"{SCHEMA}.HR_EMP_FAMILY",
    ]


def test_join_preview_is_refused_for_a_hidden_column(client, load_fixture, migrated_engine,
                                                     allow_preview, hide_schemas):
    """미리보기 허용 목록과 독립 — 허용돼 있어도 감춘 스키마면 막힌다."""
    _seed(client, load_fixture)
    allow_preview(SCHEMA)
    hide_schemas(SCHEMA)
    body = {"steps": [{
        "left_column_id": _column_id(migrated_engine, f"{SCHEMA}.HR_EMP_FAMILY", "EMP_NO"),
        "right_column_id": _column_id(migrated_engine, f"{SCHEMA}.HR_EMP", "EMP_NO"),
        "join_type": "inner",
    }]}
    assert client.post("/api/join/preview", json=body).status_code == 403


def test_table_preview_is_refused_even_when_allowlisted(client, load_fixture,
                                                        allow_preview, hide_schemas):
    _seed(client, load_fixture)
    allow_preview(SCHEMA)
    obj = _an_object(client)
    assert client.get(f"/api/objects/{obj['id']}/preview").status_code == 200

    hide_schemas(SCHEMA)
    assert client.get(f"/api/objects/{obj['id']}/preview").status_code == 403


def test_matching_ignores_case(client, load_fixture, hide_schemas):
    """운영자가 케이스를 틀려도 열리면 안 된다."""
    _seed(client, load_fixture)
    obj = _an_object(client)
    hide_schemas(SCHEMA.upper())
    assert client.get(f"/api/objects/{obj['id']}/detail").json()["columns"] == []
