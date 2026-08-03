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
RECON_OUT_PATH = REPO_ROOT / "n8n" / "workflows" / "w0_recon_queries.json"
W1A_OUT_PATH = REPO_ROOT / "n8n" / "workflows" / "w1a_collect_catalog.json"
W1B_OUT_PATH = REPO_ROOT / "n8n" / "workflows" / "w1b_collect_viewdeps.json"
W2_OUT_PATH = REPO_ROOT / "n8n" / "workflows" / "w2_query_executor.json"

# W2 — 파라미터 → 고정 템플릿 쿼리. 동적 SQL 문자열은 절대 받지 않는다 (보안 경계).
# parameters become one of three fixed templates; raw SQL is never accepted
BUILD_QUERY_JS = """\
// 식별자는 브래킷, 리터럴은 '' 이스케이프 — 템플릿 밖 SQL 조립 금지
// bracket-escape identifiers, quote-escape literals; no free-form SQL
const esc = (s) => '[' + String(s).replace(/\\]/g, ']]') + ']';
const lit = (s) => String(s).replace(/'/g, "''");
const b = $json.body ?? {};
const limit = Math.min(Math.max(parseInt(b.limit, 10) || 20, 1), 500);
let query;
if (b.kind === 'containment') {
  const src = esc(b.src_schema) + '.' + esc(b.src_table);
  const tgt = esc(b.tgt_schema) + '.' + esc(b.tgt_table);
  const sc = esc(b.src_column), tc = esc(b.tgt_column);
  query = `SELECT
  (SELECT COUNT(*) FROM ${src}) AS src_rows,
  (SELECT COUNT(*) FROM ${tgt}) AS tgt_rows,
  (SELECT COUNT(DISTINCT ${tc}) FROM ${tgt}) AS tgt_distinct,
  COUNT(DISTINCT a.${sc}) AS src_distinct,
  COUNT(DISTINCT CASE WHEN b.${tc} IS NOT NULL THEN a.${sc} END) AS matched
FROM ${src} a LEFT JOIN ${tgt} b ON a.${sc} = b.${tc}`;
} else if (b.kind === 'join_preview') {
  const src = esc(b.src_schema) + '.' + esc(b.src_table);
  const tgt = esc(b.tgt_schema) + '.' + esc(b.tgt_table);
  const sc = esc(b.src_column), tc = esc(b.tgt_column);
  query = `SELECT TOP ${limit} a.${sc} AS ${esc('src.' + b.src_column)}, ` +
    `b.${tc} AS ${esc('tgt.' + b.tgt_column)} ` +
    `FROM ${src} a LEFT JOIN ${tgt} b ON a.${sc} = b.${tc}`;
} else if (b.kind === 'table_preview') {
  const tbl = esc(b.schema) + '.' + esc(b.table);
  query = `SELECT TOP ${limit} * FROM ${tbl}`;
  if (b.filter_column && b.filter_value) {
    query += ` WHERE ${esc(b.filter_column)} LIKE N'%${lit(b.filter_value)}%'`;
  }
} else {
  throw new Error('unknown kind: ' + b.kind);
}
return [{ json: { query } }];
"""

# (노드 이름, 정찰 SQL 파일) — 연결 단계 정지점 16 / recon queries, connection step 16
RECON_SQL_NODES = [
    ("recon 01 fk count", "recon/01_fk_count.sql"),
    ("recon 02 object scale", "recon/02_object_scale.sql"),
    ("recon 03 view definition permission", "recon/03_view_definition_permission.sql"),
    ("recon 04 cross database refs", "recon/04_cross_database_refs.sql"),
    ("recon 05 nested views", "recon/05_nested_views.sql"),
    ("recon 06 lineage dmv smoke", "recon/06_lineage_dmv_smoke.sql"),
]

RECON_REPORT_JS = """\
// 정찰 결과 종합 — 판단은 사람이 한다 (결과 보고 → 정지점 16)
// assemble the recon report; humans judge the results
const report = {};
report.fk_count = $('recon 01 fk count').all().map(i => i.json);
report.object_scale = $('recon 02 object scale').all().map(i => i.json);
report.view_definition_permission = $('recon 03 view definition permission').all().map(i => i.json);
report.cross_database_refs = $('recon 04 cross database refs').all().map(i => i.json);
report.nested_views = $('recon 05 nested views').all().map(i => i.json);
report.lineage_dmv_smoke = $('recon 06 lineage dmv smoke').all().map(i => i.json);
report.warnings = [];
const perm = report.view_definition_permission[0];
if (perm && Number(perm.blocked) > 0) {
  report.warnings.push(`VIEW DEFINITION blocked on ${perm.blocked}/${perm.total} views — 권한 필요 (최우선)`);
}
const smoke = report.lineage_dmv_smoke[0];
if (smoke && smoke.error) {
  report.warnings.push(`dm_sql_referenced_entities failed on ${smoke.smoke_view}: ${smoke.error}`);
}
return [{ json: report }];
"""

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
  if (!r.name) continue;  // alwaysOutputData의 빈 아이템({}) 무시 / skip empty passthrough item
  (kcs[r.name] ??= { name: r.name, type: r.type, object_id: r.object_id, columns: [] })
    .columns.push(r.column_name);
}
const fks = {};
for (const { json: r } of $('04 foreign keys').all()) {
  if (!r.name) continue;
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
  .filter(d => d.view_object_id != null && (!d.is_resolved || failedIds.has(d.view_object_id)))
  .map(d => ({ ...d, is_resolved: !!d.is_resolved }));
return [{ json: {
  snapshot_id: snapshotId,
  deps: [...deps07, ...deps06],
  unresolved_objects: failures,
} }];
"""


# 단계 워크플로용 SQL 분할 — 1단계 카탈로그(01-05) / 2단계 뷰 의존(06-07)
CATALOG_SQL_NODES = SQL_NODES[:5]
VIEW_DEPS_SQL_NODES = SQL_NODES[5:]

# webhook body(collect_job_id)를 그대로 되돌려 FastAPI 잡 단계가 갱신되게 한다
# echo collect_job_id from the webhook body so the backend can track stages
BUILD_CATALOG_JS_W1A = BUILD_CATALOG_JS.replace(
    "return [{ json: {",
    "const trigger = $('Webhook').first().json.body ?? {};\n"
    "return [{ json: {\n"
    "  collect_job_id: trigger.collect_job_id ?? null,",
)

BUILD_VIEW_DEPS_JS_W1B = BUILD_VIEW_DEPS_JS.replace(
    "const snapshotId = $('POST catalog').first().json.snapshot_id;",
    "// 단계 실행은 스냅샷 id를 트리거 본문으로 받는다 / snapshot id arrives via the webhook\n"
    "const trigger = $('Webhook').first().json.body ?? {};\n"
    "const snapshotId = trigger.snapshot_id;",
).replace(
    "return [{ json: {",
    "return [{ json: {\n  collect_job_id: trigger.collect_job_id ?? null,",
)


# 한 세트 전략 — 워크플로는 $env가 있으면 그 값(로컬 리허설: compose가 주입),
# 없으면 리터럴 폴백(실서버 n8n: UI 접근만 가능해 env 주입 불가)을 쓴다.
# one set serves both: local compose injects $env; production falls back to literals
PROD_API_BASE = "http://182.199.63.71:6678"
# 비밀키는 커밋 금지 — 임포트 후 n8n UI에서 실제 키로 교체 / replace in the n8n UI after import
KEY_PLACEHOLDER = "PASTE-INGEST-API-KEY-HERE"
API_BASE_EXPR = "$env.DB_VIEWER_API_BASE ?? '" + PROD_API_BASE + "'"
KEY_VALUE = "={{ $env.DB_VIEWER_INGEST_KEY ?? '" + KEY_PLACEHOLDER + "' }}"

# 정상적으로 0행일 수 있는 쿼리 노드 — n8n은 출력 0건이면 체인을 멈추므로
# alwaysOutputData로 빈 아이템을 흘려보낸다 (FK 없는 레거시 DB가 이 프로젝트의 전제)
# these queries can legitimately return zero rows; without alwaysOutputData n8n halts the chain
EMPTYABLE_SQL_NODES = {
    "recon 04 cross database refs",
    "03 key constraints", "04 foreign keys",
    "06 view deps", "07 referenced entities",
    "Run query",  # W2 — 빈 테이블 미리보기·LIKE 무매칭 / empty preview or no LIKE match
}


def _node(name: str, node_type: str, position: list[int], parameters: dict,
          credentials: dict | None = None, type_version: float = 1) -> dict:
    node = {
        "name": name, "type": node_type, "typeVersion": type_version,
        "position": position, "parameters": parameters,
    }
    if name in EMPTYABLE_SQL_NODES:
        node["alwaysOutputData"] = True
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
            "url": "={{ " + API_BASE_EXPR + " }}/api/ingest/catalog",
            "sendBody": True, "specifyBody": "json",
            "jsonBody": "={{ JSON.stringify($json) }}",
            # ingest 머신 게이트 — 백엔드 INGEST_API_KEY와 동일 값 / machine auth key
            "sendHeaders": True,
            "headerParameters": {"parameters": [
                {"name": "X-API-Key", "value": KEY_VALUE},
            ]},
        }, type_version=4.2),
        _node("Build view-deps payload", "n8n-nodes-base.code", [220 * 10, 0],
              {"jsCode": BUILD_VIEW_DEPS_JS}, type_version=2),
        _node("POST view-deps", "n8n-nodes-base.httpRequest", [220 * 11, 0], {
            "method": "POST",
            "url": "={{ " + API_BASE_EXPR + " }}/api/ingest/view-deps",
            "sendBody": True, "specifyBody": "json",
            "jsonBody": "={{ JSON.stringify($json) }}",
            "sendHeaders": True,
            "headerParameters": {"parameters": [
                {"name": "X-API-Key", "value": KEY_VALUE},
            ]},
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
                     "값은 DB_VIEWER_* 환경변수가 있으면 그 값, 없으면 리터럴 폴백. "
                     "실서버는 임포트 후 POST catalog / POST view-deps 노드의 X-API-Key "
                     "플레이스홀더만 .env의 INGEST_API_KEY로 교체할 것.",
        },
    }


def _post_ingest_node(name: str, endpoint: str, position: list[int]) -> dict:
    return _node(name, "n8n-nodes-base.httpRequest", position, {
        "method": "POST",
        "url": "={{ " + API_BASE_EXPR + " }}" + endpoint,
        "sendBody": True, "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify($json) }}",
        "sendHeaders": True,
        "headerParameters": {"parameters": [
            {"name": "X-API-Key", "value": KEY_VALUE},
        ]},
    }, type_version=4.2)


def _chain(nodes: list[dict]) -> dict:
    order = [n["name"] for n in nodes]
    return {
        src: {"main": [[{"node": dst, "type": "main", "index": 0}]]}
        for src, dst in zip(order, order[1:])
    }


def build_collect_catalog_workflow() -> dict:
    """W1a — 버튼 트리거 1단계: 카탈로그 수집 webhook / webhook-triggered catalog step."""
    mssql_cred = {"microsoftSql": {"id": "REPLACE_ME", "name": "MSSQL readonly"}}
    nodes = [
        _node("Webhook", "n8n-nodes-base.webhook", [0, 0], {
            "httpMethod": "POST", "path": "dbv-collect-catalog",
            # 즉시 응답 — 진행 상태는 FastAPI 잡 폴링이 담당 / respond immediately
            "responseMode": "onReceived",
        }, type_version=2),
    ]
    for i, (name, filename) in enumerate(CATALOG_SQL_NODES):
        nodes.append(_node(
            name, "n8n-nodes-base.microsoftSql", [220 * (i + 1), 0],
            {"operation": "executeQuery", "query": (SQL_DIR / filename).read_text()},
            credentials=mssql_cred, type_version=1.1,
        ))
    nodes += [
        _node("Build catalog payload", "n8n-nodes-base.code", [220 * 6, 0],
              {"jsCode": BUILD_CATALOG_JS_W1A}, type_version=2),
        _post_ingest_node("POST catalog", "/api/ingest/catalog", [220 * 7, 0]),
    ]
    return {
        "name": "W1a collect catalog (webhook)",
        "nodes": nodes,
        "connections": _chain(nodes),
        "settings": {"executionOrder": "v1"},
        "meta": {
            "notes": "버튼 트리거 1단계 — FastAPI /api/collect/catalog가 이 webhook을 호출한다. "
                     "collect_job_id를 페이로드로 되돌려 잡 단계가 갱신된다. "
                     "N8N_WEBHOOK_BASE(백엔드)와 이 워크플로의 webhook 경로가 일치해야 한다.",
        },
    }


def build_collect_viewdeps_workflow() -> dict:
    """W1b — 버튼 트리거 2단계: 뷰 의존 수집 webhook / webhook-triggered view-deps step."""
    mssql_cred = {"microsoftSql": {"id": "REPLACE_ME", "name": "MSSQL readonly"}}
    nodes = [
        _node("Webhook", "n8n-nodes-base.webhook", [0, 0], {
            "httpMethod": "POST", "path": "dbv-collect-viewdeps",
            "responseMode": "onReceived",
        }, type_version=2),
    ]
    for i, (name, filename) in enumerate(VIEW_DEPS_SQL_NODES):
        nodes.append(_node(
            name, "n8n-nodes-base.microsoftSql", [220 * (i + 1), 0],
            {"operation": "executeQuery", "query": (SQL_DIR / filename).read_text()},
            credentials=mssql_cred, type_version=1.1,
        ))
    nodes += [
        _node("Build view-deps payload", "n8n-nodes-base.code", [220 * 3, 0],
              {"jsCode": BUILD_VIEW_DEPS_JS_W1B}, type_version=2),
        _post_ingest_node("POST view-deps", "/api/ingest/view-deps", [220 * 4, 0]),
    ]
    return {
        "name": "W1b collect view-deps (webhook)",
        "nodes": nodes,
        "connections": _chain(nodes),
        "settings": {"executionOrder": "v1"},
        "meta": {
            "notes": "버튼 트리거 2단계 — FastAPI /api/collect/view-deps가 snapshot_id·collect_job_id를 "
                     "webhook body로 전달한다. 1단계(catalog_done) 이후에만 호출된다.",
        },
    }


def build_query_executor_workflow() -> dict:
    """W2 — T2 검증·미리보기용 동기 쿼리 실행 webhook / synchronous query executor.

    백엔드가 kind + 식별자 파라미터만 보내고, SQL은 여기 고정 템플릿에서만 만들어진다.
    응답은 마지막 노드(MSSQL) 출력 — webhook이 결과 행을 그대로 돌려준다.
    """
    mssql_cred = {"microsoftSql": {"id": "REPLACE_ME", "name": "MSSQL readonly"}}
    nodes = [
        _node("Webhook", "n8n-nodes-base.webhook", [0, 0], {
            "httpMethod": "POST", "path": "dbv-query",
            # 동기 응답 — 쿼리 결과가 HTTP 응답이 된다 / last node's output is the response
            "responseMode": "lastNode",
        }, type_version=2),
        _node("Build query", "n8n-nodes-base.code", [220, 0],
              {"jsCode": BUILD_QUERY_JS}, type_version=2),
        _node("Run query", "n8n-nodes-base.microsoftSql", [440, 0], {
            "operation": "executeQuery",
            "query": "={{ $json.query }}",
        }, credentials=mssql_cred, type_version=1.1),
    ]
    return {
        "name": "W2 query executor (webhook)",
        "nodes": nodes,
        "connections": _chain(nodes),
        "settings": {"executionOrder": "v1"},
        "meta": {
            "notes": "T2 검증·미리보기의 live 실행기 — FastAPI가 kind(containment/join_preview/"
                     "table_preview)와 식별자 파라미터를 보내면 고정 템플릿 쿼리만 실행한다. "
                     "동적 SQL 문자열은 받지 않는다. credentials는 읽기 전용 계정 권장. "
                     "N8N_WEBHOOK_BASE(백엔드)와 webhook 경로(dbv-query)가 일치해야 한다.",
        },
    }


def build_recon_workflow() -> dict:
    """정찰 워크플로 — 수동 트리거, 6종 쿼리 → 종합 리포트 1건 / manual recon run."""
    mssql_cred = {"microsoftSql": {"id": "REPLACE_ME", "name": "MSSQL readonly"}}
    nodes = [
        _node("Manual Trigger", "n8n-nodes-base.manualTrigger", [0, 0], {}),
    ]
    for i, (name, filename) in enumerate(RECON_SQL_NODES):
        nodes.append(_node(
            name, "n8n-nodes-base.microsoftSql", [220 * (i + 1), 0],
            {"operation": "executeQuery", "query": (SQL_DIR / filename).read_text()},
            credentials=mssql_cred, type_version=1.1,
        ))
    nodes.append(_node(
        "Recon report", "n8n-nodes-base.code", [220 * 7, 0],
        {"jsCode": RECON_REPORT_JS}, type_version=2,
    ))

    order = [n["name"] for n in nodes]
    connections = {
        src: {"main": [[{"node": dst, "type": "main", "index": 0}]]}
        for src, dst in zip(order, order[1:])
    }
    return {
        "name": "W0 recon queries",
        "nodes": nodes,
        "connections": connections,
        "settings": {"executionOrder": "v1"},
        "meta": {
            "notes": "연결 단계 정지점 16 — 실행 결과(Recon report)를 보고 후 W1 진행 여부를 결정한다. "
                     "[3] blocked > 0 이면 VIEW DEFINITION 권한부터 해결할 것. "
                     "credentials를 배포 환경에 맞게 설정.",
        },
    }


def main() -> None:
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    outputs = [
        (OUT_PATH, build_workflow()),
        (RECON_OUT_PATH, build_recon_workflow()),
        (W1A_OUT_PATH, build_collect_catalog_workflow()),
        (W1B_OUT_PATH, build_collect_viewdeps_workflow()),
        (W2_OUT_PATH, build_query_executor_workflow()),
    ]
    for path, workflow in outputs:
        path.write_text(json.dumps(workflow, ensure_ascii=False, indent=2) + "\n")
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
