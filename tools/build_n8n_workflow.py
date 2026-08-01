"""Build the n8n W1 workflow JSON from the SQL files. / n8n W1 워크플로 JSON 생성기.

SQL 파일(n8n/sql/*.sql)이 단일 소스다 — 워크플로에 쿼리를 손으로 복사하지 않는다.
테스트가 "커밋된 JSON == 재생성 결과"를 강제해 드리프트를 막는다.
The SQL files are the single source; a test enforces committed JSON == regenerated.

Usage: python tools/build_n8n_workflow.py
"""

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SQL_DIR = REPO_ROOT / "n8n" / "sql"
OUT_PATH = REPO_ROOT / "n8n" / "workflows" / "w1_catalog_snapshot.json"

# (노드 이름, SQL 파일) — 실행 순서 / execution order
SQL_NODES = [
    ("01 objects", "01_objects.sql"),
    ("02 columns", "02_columns.sql"),
    ("03 key constraints", "03_key_constraints.sql"),
    ("04 foreign keys", "04_foreign_keys.sql"),
    ("05 view definitions", "05_view_definitions.sql"),
    ("06 view deps", "06_view_deps.sql"),
    ("07 referenced entities", "07_referenced_entities.sql"),
]

# 가공·판단 금지 — 행을 계약 형태로 "묶기"만 한다 / mechanical grouping only, no logic
BUILD_CATALOG_JS = """\
// raw rows → catalog contract (mechanical grouping only / 기계적 그룹핑만)
const objects = $('01 objects').all().map(i => i.json);
const columns = $('02 columns').all().map(i => ({
  ...i.json, is_nullable: !!i.json.is_nullable, is_computed: !!i.json.is_computed,
}));
const kcs = {};
for (const { json: r } of $('03 key constraints').all()) {
  (kcs[r.name] ??= { name: r.name, type: r.type, object_id: r.object_id, columns: [] })
    .columns.push(r.column_name);
}
const fks = {};
for (const { json: r } of $('04 foreign keys').all()) {
  (fks[r.name] ??= { name: r.name, src_object_id: r.src_object_id,
                     tgt_object_id: r.tgt_object_id, columns: [] })
    .columns.push({ src_column: r.src_column, tgt_column: r.tgt_column });
}
const viewDefs = $('05 view definitions').all()
  .map(i => ({ object_id: i.json.object_id, definition: i.json.definition ?? null }));
return [{ json: {
  source_db: $env.DB_VIEWER_SOURCE_DB ?? 'MSSQL',
  collected_at: new Date().toISOString(),
  objects, columns,
  key_constraints: Object.values(kcs),
  foreign_keys: Object.values(fks),
  view_definitions: viewDefs,
} }];
"""

BUILD_VIEW_DEPS_JS = """\
// deps 계약 조립 — 07 컬럼 단위 우선, 06은 미해석·DMV실패 뷰 보강 (계약 규칙, 판단 아님)
// column-grain rows from 07; 06 fills unresolved refs and DMV-failed views per contract
const snapshotId = $('POST catalog').first().json.snapshot_id;
const rows07 = $('07 referenced entities').all().map(i => i.json);
const failures = rows07.filter(r => r.kind === 'failure')
  .map(r => ({ object_id: r.view_object_id, reason: r.reason }));
const failedIds = new Set(failures.map(f => f.object_id));
const deps07 = rows07.filter(r => r.kind === 'dep' && r.is_resolved).map(r => ({
  view_object_id: r.view_object_id, referenced_object_id: r.referenced_object_id,
  referenced_database: r.referenced_database, referenced_name: r.referenced_name,
  referenced_column: r.referenced_column, is_resolved: true,
}));
const deps06 = $('06 view deps').all().map(i => i.json)
  .filter(d => !d.is_resolved || failedIds.has(d.view_object_id))
  .map(d => ({ ...d, is_resolved: !!d.is_resolved }));
return [{ json: {
  snapshot_id: snapshotId,
  deps: [...deps07, ...deps06],
  unresolved_objects: failures,
} }];
"""


def _node(name: str, node_type: str, position: list[int], parameters: dict,
          credentials: dict | None = None, type_version: float = 1) -> dict:
    node = {
        "name": name, "type": node_type, "typeVersion": type_version,
        "position": position, "parameters": parameters,
    }
    if credentials:
        node["credentials"] = credentials
    return node


def build_workflow() -> dict:
    mssql_cred = {"microsoftSql": {"id": "REPLACE_ME", "name": "MSSQL readonly"}}
    nodes = [
        _node("Schedule", "n8n-nodes-base.scheduleTrigger", [0, 0], {
            "rule": {"interval": [{"field": "cronExpression", "expression": "0 2 * * *"}]},
        }, type_version=1.2),
    ]
    for i, (name, filename) in enumerate(SQL_NODES):
        nodes.append(_node(
            name, "n8n-nodes-base.microsoftSql", [220 * (i + 1), 0],
            {"operation": "executeQuery", "query": (SQL_DIR / filename).read_text()},
            credentials=mssql_cred, type_version=1.1,
        ))
    nodes += [
        _node("Build catalog payload", "n8n-nodes-base.code", [220 * 8, 0],
              {"jsCode": BUILD_CATALOG_JS}, type_version=2),
        _node("POST catalog", "n8n-nodes-base.httpRequest", [220 * 9, 0], {
            "method": "POST",
            "url": "={{ $env.DB_VIEWER_API_BASE }}/api/ingest/catalog",
            "sendBody": True, "specifyBody": "json",
            "jsonBody": "={{ JSON.stringify($json) }}",
        }, type_version=4.2),
        _node("Build view-deps payload", "n8n-nodes-base.code", [220 * 10, 0],
              {"jsCode": BUILD_VIEW_DEPS_JS}, type_version=2),
        _node("POST view-deps", "n8n-nodes-base.httpRequest", [220 * 11, 0], {
            "method": "POST",
            "url": "={{ $env.DB_VIEWER_API_BASE }}/api/ingest/view-deps",
            "sendBody": True, "specifyBody": "json",
            "jsonBody": "={{ JSON.stringify($json) }}",
        }, type_version=4.2),
    ]

    order = [n["name"] for n in nodes]
    connections = {
        src: {"main": [[{"node": dst, "type": "main", "index": 0}]]}
        for src, dst in zip(order, order[1:])
    }
    return {
        "name": "W1 catalog snapshot",
        "nodes": nodes,
        "connections": connections,
        "settings": {"executionOrder": "v1"},
        "meta": {
            "notes": "n8n은 수집·전송만 한다 — 가공·판단은 FastAPI ingest가 담당 (계획 §2). "
                     "credentials와 $env.DB_VIEWER_API_BASE / DB_VIEWER_SOURCE_DB를 배포 환경에 맞게 설정할 것.",
        },
    }


def main() -> None:
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(build_workflow(), ensure_ascii=False, indent=2) + "\n")
    print(f"wrote {OUT_PATH}")


if __name__ == "__main__":
    main()
