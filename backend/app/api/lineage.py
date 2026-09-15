"""Lineage diagram payloads — 뷰 소스 흐름·컬럼 계보·테이블 영향도.

파싱은 이미 Phase 2(`services/phase2.py`)가 끝내고 `view_deps`·`view_joins`·
`view_lineage_flat`에 적재해 두었다. 이 모듈은 그 세 표를 다이어그램이 바로 그릴 수 있는
그래프 모양(노드·간선)으로 조립만 한다 — 새 파싱도, 실 DB 접속도 없다.
/ Assembles already-parsed rows into graph payloads; no parsing, no live DB access here.
"""

from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session, aliased

from app.db import get_db
from app.models import (
    AiSummary,
    CatalogColumn,
    CatalogObject,
    ViewDep,
    ViewJoin,
    ViewLineageFlat,
)
from app.services.schema_visibility import is_schema_hidden

router = APIRouter(prefix="/api/lineage", tags=["lineage"])

# 영향도 팬아웃 상한 — 882개 뷰 카탈로그에서 인기 테이블 하나가 수백 노드를 끌고 올 수 있다.
# 화면이 읽히는 한계이자 응답 크기 상한 / fan-out caps: past these the picture stops being readable
IMPACT_MAX_DEPTH = 4
IMPACT_MAX_NODES = 80


def _get_object(db: Session, object_id: int, *, require_view: bool = False) -> CatalogObject:
    obj = db.get(CatalogObject, object_id)
    if obj is None or (require_view and obj.type != "view"):
        raise HTTPException(404, {
            "message": "view not found" if require_view else "object not found",
            "context": {"object_id": object_id},
        })
    if is_schema_hidden(obj.schema):
        # 다이어그램은 컬럼 매핑이 본체다 — 숨김 스키마는 정의 SQL과 같은 기준으로 막는다
        raise HTTPException(403, {
            "message": "this schema is hidden — its columns and lineage are not served "
                       "(HIDDEN_SCHEMAS)",
            "context": {"object": f"{obj.schema}.{obj.name}", "schema": obj.schema},
        })
    return obj


def _load_ai_summaries(db: Session, qnames: set[str]) -> dict[str, str]:
    """노드 팝오버가 쓰는 AI 요약 캐시 — 없는 건 빠진 채로 온다(생성은 기존 AI API 담당)."""
    if not qnames:
        return {}
    rows = db.execute(
        select(AiSummary.object_qname, AiSummary.summary)
        .where(AiSummary.object_qname.in_(qnames))
    ).all()
    return {qname: summary for qname, summary in rows}


def _node_payload(
    obj: CatalogObject, depth: int, summaries: dict[str, str], *, direct: bool = True,
) -> dict:
    """column_count는 여기서 비워 두고 `_fill_column_counts`가 한 번에 채운다(노드당 COUNT 방지).

    direct=False는 "FROM/JOIN에 직접 쓰이진 않고 중첩 뷰 너머의 계보로만 등장"을 뜻한다 —
    소스 흐름 탭은 직접 소스만 그려야 FROM 절과 그림이 일치한다.
    """
    qname = f"{obj.schema}.{obj.name}"
    return {
        "id": obj.id,
        "qname": qname,
        "schema": obj.schema,
        "type": obj.type,
        "depth": depth,
        "direct": direct,
        "row_count": obj.row_count,
        "column_count": None,
        "ai_summary": summaries.get(qname),
        "hidden": is_schema_hidden(obj.schema),
        "columns": [],
    }


def _fill_column_counts(db: Session, nodes: list[dict]) -> None:
    """노드들의 컬럼 수를 한 번의 group-by로 채운다 — 팝오버가 쓰는 유일한 집계값."""
    ids = [node["id"] for node in nodes if node["id"] is not None]
    if not ids:
        return
    counts = {
        object_id: count
        for object_id, count in db.execute(
            select(CatalogColumn.object_id, func.count())
            .where(CatalogColumn.object_id.in_(ids))
            .group_by(CatalogColumn.object_id)
        ).all()
    }
    for node in nodes:
        if node["id"] is not None:
            node["column_count"] = counts.get(node["id"], 0)


@router.get("/views/{object_id}")
def get_view_diagram(object_id: int, db: Session = Depends(get_db)) -> dict:
    """뷰 다이어그램 1종 페이로드 — 소스 흐름(탭1)·컬럼 계보(탭2)·정의 SQL(탭3)이 함께 쓴다.

    탭마다 따로 부르지 않는 이유: 세 탭이 같은 뷰의 같은 스냅샷을 보므로 한 번에 받아야
    탭 전환이 즉시 일어나고 화면 사이 수치가 어긋나지 않는다.
    / one payload for all three tabs so switching tabs never refetches or disagrees.
    """
    view = _get_object(db, object_id, require_view=True)

    # ── 직접 소스(FROM·JOIN 대상) — 평탄화된 lineage가 아니라 1-hop 의존성이 진실 ──────
    dep_rows = db.execute(
        select(ViewDep, CatalogObject)
        .outerjoin(CatalogObject, ViewDep.referenced_object_id == CatalogObject.id)
        .where(ViewDep.view_object_id == view.id)
        .order_by(ViewDep.id)
    ).all()

    nodes: dict[str, dict] = {}
    unresolved: list[dict] = []
    resolved_objects: dict[int, CatalogObject] = {}
    used_columns: dict[str, set[str]] = defaultdict(set)

    for dep, ref in dep_rows:
        if dep.is_resolved and ref is not None:
            if ref.id == view.id:
                continue  # 자기 참조(재귀 뷰) — 그래프에 자기 자신을 그리지 않는다
            resolved_objects[ref.id] = ref
            qname = f"{ref.schema}.{ref.name}"
            if dep.referenced_column:
                used_columns[qname].add(dep.referenced_column)
        else:
            # 크로스 DB·드랍된 객체 — 카탈로그 밖이라 노드 id가 없다
            label = ".".join(
                part for part in (dep.referenced_database, dep.referenced_name) if part
            ) or "(unknown)"
            unresolved.append({
                "database": dep.referenced_database,
                "name": dep.referenced_name,
                "column": dep.referenced_column,
                "qname": label,
            })

    unresolved_by_qname: dict[str, set[str]] = defaultdict(set)
    for item in unresolved:
        if item["column"]:
            unresolved_by_qname[item["qname"]].add(item["column"])

    summaries = _load_ai_summaries(
        db,
        {f"{o.schema}.{o.name}" for o in resolved_objects.values()} | {f"{view.schema}.{view.name}"},
    )

    for obj in resolved_objects.values():
        node = _node_payload(obj, 1, summaries)
        node["columns"] = sorted(used_columns.get(node["qname"], ()))
        nodes[node["qname"]] = node
    for qname, cols in sorted(unresolved_by_qname.items()):
        nodes[qname] = {
            "id": None, "qname": qname, "schema": None, "type": "unresolved", "depth": 1,
            "direct": True, "row_count": None, "column_count": None, "ai_summary": None,
            "hidden": False, "columns": sorted(cols),
        }
    for item in unresolved:  # 컬럼 없는 미해석 참조도 노드는 서야 한다
        nodes.setdefault(item["qname"], {
            "id": None, "qname": item["qname"], "schema": None, "type": "unresolved",
            "depth": 1, "direct": True, "row_count": None, "column_count": None,
            "ai_summary": None, "hidden": False, "columns": [],
        })

    # ── JOIN 조건 — view_joins는 컬럼 id만 들고 있어 객체까지 되짚는다 ────────────────
    left_col, right_col = aliased(CatalogColumn), aliased(CatalogColumn)
    left_obj, right_obj = aliased(CatalogObject), aliased(CatalogObject)
    joins = [
        {
            "left_object": f"{l_schema}.{l_name}", "left_column": l_col,
            "right_object": f"{r_schema}.{r_name}", "right_column": r_col,
            "join_type": join_type, "occurrence_count": occurrence,
        }
        for l_schema, l_name, l_col, r_schema, r_name, r_col, join_type, occurrence
        in db.execute(
            select(
                left_obj.schema, left_obj.name, left_col.name,
                right_obj.schema, right_obj.name, right_col.name,
                ViewJoin.join_type, ViewJoin.occurrence_count,
            )
            .select_from(ViewJoin)
            .join(left_col, ViewJoin.left_column_id == left_col.id)
            .join(right_col, ViewJoin.right_column_id == right_col.id)
            .join(left_obj, left_col.object_id == left_obj.id)
            .join(right_obj, right_col.object_id == right_obj.id)
            .where(ViewJoin.view_object_id == view.id)
            .order_by(ViewJoin.id)
        ).all()
    ]

    # ── 출력 컬럼 계보 — view_lineage_flat은 base table까지 이미 평탄화돼 있다 ─────────
    base = aliased(CatalogObject)
    lineage_rows = db.execute(
        select(ViewLineageFlat, base)
        .outerjoin(base, ViewLineageFlat.base_object_id == base.id)
        .where(ViewLineageFlat.view_object_id == view.id)
        .order_by(ViewLineageFlat.view_column, ViewLineageFlat.depth, ViewLineageFlat.id)
    ).all()

    columns: dict[str, dict] = {}
    flags: set[str] = set()
    base_objects: dict[str, CatalogObject] = {}
    base_depth: dict[str, int] = {}  # qname → 최소 depth
    for row, base_obj in lineage_rows:
        if row.flag:
            flags.add(row.flag)
        if base_obj is None:
            continue
        entry = columns.setdefault(row.view_column, {
            "name": row.view_column, "kind": row.mapping_kind, "sources": [],
        })
        # derived가 하나라도 섞이면 그 출력 컬럼은 가공된 것 / derived wins over direct
        if row.mapping_kind == "derived":
            entry["kind"] = "derived"
        base_qname = f"{base_obj.schema}.{base_obj.name}"
        entry["sources"].append({
            "object": base_qname, "column": row.base_column, "depth": row.depth,
        })
        base_objects[base_qname] = base_obj
        prior = base_depth.get(base_qname)
        base_depth[base_qname] = row.depth if prior is None else min(prior, row.depth)

    # 계보에만 등장하는 base table(중첩 뷰 너머)도 노드로 세운다 — 탭2의 왼쪽 레인.
    # 직접 소스로 이미 선 노드는 depth 1을 유지한다(탭1이 그 자리를 쓴다).
    base_summaries = _load_ai_summaries(
        db, {q for q in base_objects if q not in nodes})
    for qname, obj in base_objects.items():
        if qname in nodes:
            continue
        nodes[qname] = _node_payload(obj, base_depth[qname], base_summaries, direct=False)

    node_list = sorted(nodes.values(), key=lambda n: (n["depth"], n["qname"]))
    _fill_column_counts(db, node_list)
    view_column_count = db.execute(
        select(func.count()).select_from(CatalogColumn)
        .where(CatalogColumn.object_id == view.id)
    ).scalar_one()

    return {
        "view": {
            "id": view.id,
            "qname": f"{view.schema}.{view.name}",
            "schema": view.schema,
            "type": view.type,
            "parse_status": view.parse_status,
            "parse_error": view.parse_error,
            "row_count": view.row_count,
            "column_count": view_column_count,
            "ai_summary": summaries.get(f"{view.schema}.{view.name}"),
            "definition": view.definition,
        },
        "nodes": node_list,
        "joins": joins,
        "columns": sorted(columns.values(), key=lambda c: c["name"]),
        "unresolved": unresolved,
        "flags": sorted(flags),
    }


@router.get("/objects/{object_id}/impact")
def get_impact_graph(
    object_id: int,
    max_depth: int = Query(IMPACT_MAX_DEPTH, ge=1, le=IMPACT_MAX_DEPTH),
    db: Session = Depends(get_db),
) -> dict:
    """영향도 팬아웃 — 이 객체를 읽는 뷰를 depth 순으로 BFS 전개한다.

    `view_lineage_flat`(평탄화)이 아니라 `view_deps`(1-hop)를 쓴다: "무엇을 거쳐 번지는가"가
    질문이라 중간 뷰가 간선으로 보여야 한다. 평탄화 표는 base까지 건너뛴 결과만 준다.
    / one-hop deps, not the flattened table: the intermediate views are the answer here.
    """
    root = _get_object(db, object_id)

    edges: list[dict] = []
    depth_by_id: dict[int, int] = {root.id: 0}
    objects_by_id: dict[int, CatalogObject] = {root.id: root}
    frontier = [root.id]
    truncated = False

    for depth in range(1, max_depth + 1):
        if not frontier:
            break
        rows = db.execute(
            select(ViewDep, CatalogObject)
            .join(CatalogObject, ViewDep.view_object_id == CatalogObject.id)
            .where(
                ViewDep.snapshot_id == root.snapshot_id,
                ViewDep.referenced_object_id.in_(frontier),
                ViewDep.is_resolved.is_(True),
            )
            .order_by(CatalogObject.schema, CatalogObject.name, ViewDep.id)
        ).all()

        columns_by_edge: dict[tuple[int, int], set[str]] = defaultdict(set)
        next_frontier: list[int] = []
        for dep, consumer in rows:
            if consumer.id == dep.referenced_object_id:
                continue  # 자기 참조
            if consumer.id in depth_by_id and depth_by_id[consumer.id] <= depth:
                # 이미 더 짧은 경로로 들어온 노드 — 간선만 추가하고 다시 펼치지 않는다
                pass
            elif len(depth_by_id) >= IMPACT_MAX_NODES:
                truncated = True
                continue
            else:
                depth_by_id[consumer.id] = depth
                objects_by_id[consumer.id] = consumer
                next_frontier.append(consumer.id)
            if dep.referenced_column:
                columns_by_edge[(dep.referenced_object_id, consumer.id)].add(
                    dep.referenced_column)
            else:
                columns_by_edge.setdefault((dep.referenced_object_id, consumer.id), set())

        for (source_id, consumer_id), cols in columns_by_edge.items():
            if consumer_id not in objects_by_id:
                continue
            edges.append({
                "from_id": source_id, "to_id": consumer_id, "columns": sorted(cols),
            })
        frontier = next_frontier

    summaries = _load_ai_summaries(
        db, {f"{o.schema}.{o.name}" for o in objects_by_id.values()})

    nodes = sorted(
        (_node_payload(obj, depth_by_id[obj_id], summaries)
         for obj_id, obj in objects_by_id.items()),
        key=lambda n: (n["depth"], n["qname"]),
    )
    _fill_column_counts(db, nodes)
    by_id = {node["id"]: node["qname"] for node in nodes}
    root_node = next(node for node in nodes if node["id"] == root.id)
    return {
        "root": {
            "id": root.id, "qname": f"{root.schema}.{root.name}", "schema": root.schema,
            "type": root.type, "row_count": root.row_count,
            "column_count": root_node["column_count"],
            "ai_summary": summaries.get(f"{root.schema}.{root.name}"),
        },
        "nodes": nodes,
        "edges": [
            {
                "from": by_id[edge["from_id"]], "to": by_id[edge["to_id"]],
                "from_id": edge["from_id"], "to_id": edge["to_id"],
                "columns": edge["columns"],
            }
            for edge in edges
            if edge["from_id"] in by_id and edge["to_id"] in by_id
        ],
        "truncated": truncated,
    }
