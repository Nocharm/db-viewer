"""Preview allowlist policy and its password gate. / 미리보기 허용 스키마·비밀번호 게이트."""

import pytest

from app.config import get_settings

PASSWORD = "s3cret-preview"


def _seed(client, load_fixture) -> None:
    # 스냅샷은 뷰 의존까지 들어와야 ready — 그 전엔 객체 조회가 열리지 않는다
    sid = client.post("/api/ingest/catalog",
                      json=load_fixture("catalog.json")).json()["snapshot_id"]
    client.post("/api/ingest/view-deps",
                json={**load_fixture("view_deps.json"), "snapshot_id": sid})


def _an_object(client) -> dict:
    return client.get("/api/objects?q=HR_EMP&type=table&limit=1").json()["items"][0]


@pytest.fixture()
def preview_password(monkeypatch):
    """수정 게이트가 켜진 배포 / a deployment with the edit password configured."""
    monkeypatch.setenv("PREVIEW_ADMIN_PASSWORD", PASSWORD)
    get_settings.cache_clear()
    yield PASSWORD
    monkeypatch.delenv("PREVIEW_ADMIN_PASSWORD", raising=False)
    get_settings.cache_clear()


def test_preview_is_denied_until_the_schema_is_allowed(client, load_fixture):
    """기본 정책 — 목록이 비어 있으면 전부 차단 (설정을 잊어도 값이 새지 않는다)."""
    _seed(client, load_fixture)
    obj = _an_object(client)

    res = client.get(f"/api/objects/{obj['id']}/preview")
    assert res.status_code == 403
    assert "preview allowlist" in res.json()["error"]["message"]
    assert client.get("/api/objects/preview-allowlist").json()["items"] == []


def test_allowed_schema_previews_and_appears_in_the_list(client, load_fixture,
                                                         preview_password):
    _seed(client, load_fixture)
    obj = _an_object(client)
    schema = obj["schema"]

    added = client.post("/api/admin/preview-allowlist",
                        headers={"X-Preview-Password": preview_password},
                        json={"schema": schema, "note": "영업 확인용"})
    assert added.status_code == 200 and added.json()["created"] is True

    assert client.get("/api/objects/preview-allowlist").json()["items"] == [schema]
    body = client.get(f"/api/objects/{obj['id']}/preview")
    assert body.status_code == 200 and body.json()["rows"]

    listed = client.get("/api/admin/preview-allowlist").json()
    assert listed["password_configured"] is True
    assert listed["items"][0]["note"] == "영업 확인용"


def test_allowing_a_schema_opens_every_object_in_it(client, load_fixture,
                                                    preview_password):
    """스키마 단위 정책의 핵심 — 등록 1건이 그 스키마 전체를 연다."""
    _seed(client, load_fixture)
    objects = client.get("/api/objects?type=table&limit=5").json()["items"]
    schema = objects[0]["schema"]
    assert all(obj["schema"] == schema for obj in objects)  # 픽스처는 단일 스키마

    client.post("/api/admin/preview-allowlist",
                headers={"X-Preview-Password": preview_password},
                json={"schema": schema})

    for obj in objects:
        assert client.get(f"/api/objects/{obj['id']}/preview").status_code == 200


def test_removing_the_entry_closes_the_preview_again(client, load_fixture,
                                                     preview_password):
    _seed(client, load_fixture)
    obj = _an_object(client)
    schema = obj["schema"]
    headers = {"X-Preview-Password": preview_password}

    client.post("/api/admin/preview-allowlist", headers=headers, json={"schema": schema})
    assert client.get(f"/api/objects/{obj['id']}/preview").status_code == 200

    removed = client.delete(f"/api/admin/preview-allowlist/{schema}", headers=headers)
    assert removed.status_code == 200 and removed.json()["removed"] is True
    assert client.get(f"/api/objects/{obj['id']}/preview").status_code == 403


def test_edits_require_the_configured_password(client, load_fixture, preview_password):
    _seed(client, load_fixture)
    schema = _an_object(client)["schema"]

    assert client.post("/api/admin/preview-allowlist",
                       json={"schema": schema}).status_code == 401
    assert client.post("/api/admin/preview-allowlist",
                       headers={"X-Preview-Password": "wrong"},
                       json={"schema": schema}).status_code == 401
    # 읽기는 관리자 게이트만 — 비밀번호 없이도 목록은 볼 수 있다
    assert client.get("/api/admin/preview-allowlist").status_code == 200


def test_edits_are_impossible_without_the_env_password(client, load_fixture):
    """비밀번호 미설정 배포는 열어두는 대신 수정을 막는다 / unset means no edits, not open."""
    _seed(client, load_fixture)
    schema = _an_object(client)["schema"]

    res = client.post("/api/admin/preview-allowlist", json={"schema": schema})
    assert res.status_code == 503
    assert "PREVIEW_ADMIN_PASSWORD" in res.json()["error"]["message"]
    assert client.get("/api/admin/preview-allowlist").json()["password_configured"] is False


def test_unknown_schemas_are_refused(client, load_fixture, preview_password):
    """오타로 유령 허용이 쌓이면 목록만 늘고 아무것도 안 열린다."""
    _seed(client, load_fixture)

    refused = client.post("/api/admin/preview-allowlist",
                          headers={"X-Preview-Password": preview_password},
                          json={"schema": "NO_SUCH_SCHEMA"})
    assert refused.status_code == 400
    assert client.get("/api/objects/preview-allowlist").json()["items"] == []


def test_join_preview_uses_the_same_allowlist(client, load_fixture, migrated_engine,
                                              fixture_dir, preview_password):
    """조인 샘플도 실값을 내보낸다 — 여기가 열려 있으면 허용 목록이 우회된다."""
    import sqlalchemy as sa

    from app.adapters.fake_validator import FakeJoinValidator
    from app.api.validate import get_join_validator
    from app.models import Base

    _seed(client, load_fixture)
    client.app.dependency_overrides[get_join_validator] = lambda: FakeJoinValidator(
        fixture_dir / "value_sets.json"
    )
    rel = next(r for r in load_fixture("expected/relations.json")["rows"]
               if r["kind"] == "real_no_fk" and r["orphan_count"] == 0)

    obj_t, col_t = Base.metadata.tables["objects"], Base.metadata.tables["columns"]

    def column_id(qname: str, column: str) -> int:
        schema, table = qname.split(".", 1)
        with migrated_engine.connect() as conn:
            return conn.execute(
                sa.select(col_t.c.id).join(obj_t, col_t.c.object_id == obj_t.c.id)
                .where(obj_t.c.schema == schema, obj_t.c.name == table,
                       col_t.c.name == column)
            ).scalar_one()

    ids = {"src_column_id": column_id(rel["src_object"], rel["src_column"]),
           "tgt_column_id": column_id(rel["tgt_object"], rel["tgt_column"])}

    blocked = client.post("/api/validate/preview", json=ids)
    assert blocked.status_code == 403
    # 양쪽 다 검사한다 — 한쪽만 보면 닫힌 쪽 값이 샌다 / both sides are checked
    assert blocked.json()["error"]["context"]["objects"] == [rel["src_object"],
                                                             rel["tgt_object"]]

    client.post("/api/admin/preview-allowlist",
                headers={"X-Preview-Password": preview_password},
                json={"schema": rel["src_object"].split(".", 1)[0]})
    assert client.post("/api/validate/preview", json=ids).status_code == 200


def test_n_way_join_preview_uses_the_same_allowlist(client, load_fixture, migrated_engine,
                                                    fixture_dir, preview_password):
    """조인 빌더가 실제로 쓰는 경로 — 2-way만 막으면 여기가 우회로가 된다.

    2-way(/api/validate/preview)는 게이트가 있었지만 프론트는 이 N-웨이 경로만 호출한다.
    같은 데이터에 대해 한쪽만 열려 있으면 허용 목록이 사실상 무력해진다.
    """
    import sqlalchemy as sa

    from app.adapters.fake_validator import FakeJoinValidator
    from app.api.validate import get_join_validator
    from app.models import Base

    _seed(client, load_fixture)
    client.app.dependency_overrides[get_join_validator] = lambda: FakeJoinValidator(
        fixture_dir / "value_sets.json"
    )
    rel = next(r for r in load_fixture("expected/relations.json")["rows"]
               if r["kind"] == "real_no_fk" and r["orphan_count"] == 0)

    obj_t, col_t = Base.metadata.tables["objects"], Base.metadata.tables["columns"]

    def column_id(qname: str, column: str) -> int:
        schema, table = qname.split(".", 1)
        with migrated_engine.connect() as conn:
            return conn.execute(
                sa.select(col_t.c.id).join(obj_t, col_t.c.object_id == obj_t.c.id)
                .where(obj_t.c.schema == schema, obj_t.c.name == table,
                       col_t.c.name == column)
            ).scalar_one()

    body = {"steps": [{
        "left_column_id": column_id(rel["src_object"], rel["src_column"]),
        "right_column_id": column_id(rel["tgt_object"], rel["tgt_column"]),
        "join_type": "inner",
    }]}

    blocked = client.post("/api/join/preview", json=body)
    assert blocked.status_code == 403
    # 스텝의 양쪽 테이블이 모두 실린다 — 한쪽만 보면 닫힌 쪽 값이 샌다
    assert blocked.json()["error"]["context"]["objects"] == [rel["src_object"],
                                                             rel["tgt_object"]]

    client.post("/api/admin/preview-allowlist",
                headers={"X-Preview-Password": preview_password},
                json={"schema": rel["src_object"].split(".", 1)[0]})
    # 403이 사라진 것으로 충분하다 — 여기서부터는 소스 가용성 문제라 이 파일의 관심 밖이다
    assert client.post("/api/join/preview", json=body).status_code != 403
