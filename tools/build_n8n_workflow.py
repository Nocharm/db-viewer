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
RECON_OUT_PATH = REPO_ROOT / "n8n" / "workflows" / "w0_recon_queries.json"
W1_OUT_PATH = REPO_ROOT / "n8n" / "workflows" / "w1_catalog_query.json"
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

# 수집 쿼리 kind → SQL 파일. 서비스가 kind와 파라미터를 보내면 그 쿼리 하나만 실행한다.
# 캐스케이드(객체→그 객체의 컬럼→…)는 백엔드가 주도한다 — n8n은 단문 실행기로만 둔다.
# one small query per call; the backend owns the cascade
CATALOG_QUERY_KINDS = [
    ("totals", "00_object_count.sql"),
    ("objects", "01_objects.sql"),
    ("columns", "02_columns.sql"),
    ("key_constraints", "03_key_constraints.sql"),
    ("foreign_keys", "04_foreign_keys.sql"),
    ("view_definitions", "05_view_definitions.sql"),
    ("view_deps", "06_view_deps.sql"),
    ("view_refs", "07_referenced_entities.sql"),
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




# 단계 워크플로용 SQL 분할 — 1단계 카탈로그(01-05) / 2단계 뷰 의존(06-07)





# 한 세트 전략 — 워크플로는 $env가 있으면 그 값(로컬 리허설: compose가 주입),
# 없으면 리터럴 폴백(실서버 n8n: UI 접근만 가능해 env 주입 불가)을 쓴다.
# one set serves both: local compose injects $env; production falls back to literals

# 정상적으로 0행일 수 있는 쿼리 노드 — n8n은 출력 0건이면 체인을 멈추므로
# alwaysOutputData로 빈 아이템을 흘려보낸다 (FK 없는 레거시 DB가 이 프로젝트의 전제)
# these queries can legitimately return zero rows; without alwaysOutputData n8n halts the chain
EMPTYABLE_SQL_NODES = {
    "recon 04 cross database refs",  # 크로스 DB 참조 없음이 정상 / no cross-db refs is normal
    "Run query",                     # 빈 결과가 정상인 조회 다수 / many queries legitimately return none
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




def _chain(nodes: list[dict]) -> dict:
    order = [n["name"] for n in nodes]
    return {
        src: {"main": [[{"node": dst, "type": "main", "index": 0}]]}
        for src, dst in zip(order, order[1:])
    }




# kind별 파라미터 치환 — 정수만 통과시켜 SQL 조립 경로를 닫는다 (W2와 동일 원칙)
CATALOG_QUERY_JS_TAIL = """\
const b = $json.body ?? {};
const sql = TEMPLATES[b.kind];
if (!sql) { throw new Error('unknown kind: ' + b.kind); }
// 정수 외에는 전부 거른다 — 목록이 비면 매칭 0건이 되도록 -1을 넣는다
const ids = (Array.isArray(b.object_ids) ? b.object_ids : [])
  .map(n => parseInt(n, 10)).filter(Number.isInteger);
const idList = ids.length ? ids.join(',') : '-1';
const offset = Math.max(parseInt(b.offset, 10) || 0, 0);
const limit = Math.min(Math.max(parseInt(b.limit, 10) || 300, 1), 5000);
const query = sql
  .split('{{ID_LIST}}').join(idList)
  .split('{{OFFSET}}').join(String(offset))
  .split('{{LIMIT}}').join(String(limit));
return [{ json: { query } }];
"""


def build_catalog_query_workflow() -> dict:
    """W1 — 수집용 단문 쿼리 실행기 / one small catalog query per call.

    백엔드가 kind와 파라미터(offset/limit 또는 object_ids)를 보내면 해당 쿼리 하나만
    실행하고 행을 그대로 돌려준다. 객체→컬럼→키 같은 연쇄는 백엔드가 주도하므로
    이 워크플로는 3노드로 고정된다 (n8n에 상태·분기 없음).
    """
    templates = {kind: (SQL_DIR / filename).read_text()
                 for kind, filename in CATALOG_QUERY_KINDS}
    build_js = (
        "// kind → 고정 SQL. 파라미터는 정수만 받아 그대로 박는다 (문자열 SQL 미수신)\n"
        "// fixed SQL per kind; only integers are interpolated, never raw SQL\n"
        "const TEMPLATES = " + json.dumps(templates, ensure_ascii=False, indent=2) + ";\n"
        + CATALOG_QUERY_JS_TAIL
    )
    return {
        "name": "W1 catalog query (webhook)",
        "nodes": [
            _node("Webhook", "n8n-nodes-base.webhook", [0, 0], {
                "httpMethod": "POST", "path": "dbv-catalog",
                # 동기 응답 — 백엔드가 결과를 받아 다음 쿼리를 결정한다 / rows are the response
                "responseMode": "lastNode",
            }, type_version=2),
            _node("Build query", "n8n-nodes-base.code", [220, 0],
                  {"jsCode": build_js}, type_version=2),
            _node("Run query", "n8n-nodes-base.microsoftSql", [440, 0], {
                "operation": "executeQuery", "query": "={{ $json.query }}",
            }, credentials={"microsoftSql": {"id": "REPLACE_ME", "name": "MSSQL readonly"}},
                type_version=1.1),
        ],
        "connections": _chain([{"name": "Webhook"}, {"name": "Build query"}, {"name": "Run query"}]),
        "settings": {"executionOrder": "v1"},
        "meta": {
            "notes": "수집용 단문 쿼리 실행기 — FastAPI가 kind(totals/objects/columns/"
                     "key_constraints/foreign_keys/view_definitions/view_deps/view_refs)와 "
                     "정수 파라미터를 보내면 해당 쿼리만 실행한다. 캐스케이드는 백엔드가 "
                     "주도하므로 이 워크플로는 상태를 갖지 않는다. credentials는 읽기 전용 계정 권장.",
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
    W1_OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    outputs = [
        (RECON_OUT_PATH, build_recon_workflow()),
        (W1_OUT_PATH, build_catalog_query_workflow()),
        (W2_OUT_PATH, build_query_executor_workflow()),
    ]
    for path, workflow in outputs:
        path.write_text(json.dumps(workflow, ensure_ascii=False, indent=2) + "\n")
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
