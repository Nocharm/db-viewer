"""Synthetic MSSQL catalog fixture generator. / 합성 MSSQL 카탈로그 픽스처 생성기.

n8n이 POST할 raw JSON(catalog.json, view_deps.json)과 자동 검증용 기대 결과
(expected/*.json), FakeJoinValidator용 값 집합(value_sets.json)을 함께 생성한다.
시드 고정 결정론 — 버리는 코드가 아니라 회귀 테스트 자산이다.
Emits raw ingest payloads plus ground-truth expectations and value sets.
Deterministic per seed — a regression asset, not throwaway code.

기대 결과 두 벌 / two expectation files:
- expected/lineage_full.json   — 컬럼 정밀 ground truth (Phase 2 목표)
- expected/lineage_phase1.json — set-level 엔진 기대치. 중첩 뷰는 부모 뷰의
  "전체" 참조 집합을 상속한다 — 엔진은 deps만 보므로 선택 컬럼으로 좁힐 수 없다.
  (nested views inherit the parent's FULL referenced set; deps cannot narrow it)

Usage: python tools/fixture_gen.py --out fixtures [--seed 42]
"""

import argparse
import json
import random
from pathlib import Path

# 규모 목표 (계획 §1) / scale targets from the plan
TABLE_COUNT_TARGET = 409
COLUMN_COUNT_TARGET = 9000
DEPTH_LIMIT = 10  # lineage 재귀 상한 (계획 §1.3) / recursion cap

# (모듈 접두어, 테이블 수) — 합계 409 / module prefix, table count — sums to 409
MODULES = [
    ("HR", 18), ("ORG", 12), ("ORD", 25), ("ITM", 20), ("PRD", 22), ("BOM", 12),
    ("SHP", 20), ("INV", 18), ("WMS", 16), ("PUR", 18), ("VND", 10), ("FIN", 22),
    ("ACC", 18), ("CST", 15), ("CRM", 16), ("QC", 14), ("EQP", 15), ("MNT", 12),
    ("PLN", 14), ("MES", 22), ("LAB", 10), ("EDU", 8), ("DOC", 10), ("SYS", 12),
    ("LOG", 10), ("APV", 10), ("EXT", 10),
]

_TABLE_NOUNS = [
    "MST", "DTL", "HDR", "HIST", "MAP", "CODE", "REQ", "RSLT", "PLAN", "ITEM",
    "GRP", "RATE", "SPEC", "STAT", "SUM", "TRAN", "BASE", "REL", "SET", "INFO",
    "LOG", "TMP", "CHG", "APRV", "FILE",
]

# 모듈별 도메인 엔티티 — 첫 항목이 모듈 마스터 / per-module entities, first is the master.
# 실DB와 유사한 수준의 네이밍(UI 리뷰용) — 부족분은 _TABLE_NOUNS로 폴백.
MODULE_NOUNS: dict[str, list[str]] = {
    "HR": ["EMP", "EMP_FAMILY", "APPOINT", "SALARY", "ATTEND", "LEAVE", "CERT",
           "EDU_HIST", "EVAL", "PROMOTION", "RETIRE", "DISPATCH", "SHIFT", "APRV", "LOG"],
    "ORG": ["DEPT", "DEPT_HIST", "POSITION", "DUTY", "TEAM_MAP", "CHART", "AUTH_GRP"],
    "ORD": ["SO_HDR", "SO_DTL", "CUST_PO", "QUOTE_HDR", "QUOTE_DTL", "DELIVERY_REQ",
            "BACKORDER", "RETURN_HDR", "RETURN_DTL", "CONTRACT", "PRICE_AGREE", "CREDIT"],
    "ITM": ["ITEM", "ITEM_SPEC", "ITEM_UOM", "ITEM_PRICE", "ITEM_CLASS", "ITEM_BARCODE",
            "ITEM_VENDOR", "ITEM_REV", "ITEM_ATTACH"],
    "PRD": ["WORK_ORD", "WORK_RSLT", "ROUTING", "ROUTING_STEP", "LINE", "LINE_STOP",
            "SHIFT_RSLT", "REWORK", "SCRAP", "YIELD", "PKG_ORD", "PKG_RSLT"],
    "BOM": ["BOM_HDR", "BOM_DTL", "BOM_REV", "ALT_ITEM", "WHERE_USED", "ECO"],
    "SHP": ["SHIP_ORD", "SHIP_RSLT", "PACKING_HDR", "PACKING_DTL", "INVOICE",
            "CARRIER", "CONTAINER", "EXPORT_DOC", "TRACKING", "COLD_CHAIN"],
    "INV": ["STOCK", "STOCK_MOVE", "STOCK_ADJ", "CYCLE_COUNT", "SAFETY_STOCK",
            "EXPIRY", "HOLD", "ALLOC"],
    "WMS": ["WAREHOUSE", "LOCATION", "PUTAWAY", "PICKING", "PICKING_DTL",
            "REPLENISH", "TASK", "DOCK"],
    "PUR": ["PO_HDR", "PO_DTL", "PR_HDR", "PR_DTL", "RFQ", "GR_HDR", "GR_DTL",
            "INSPECT_REQ", "SUPPLIER_EVAL"],
    "VND": ["VENDOR", "VENDOR_CONTACT", "VENDOR_ITEM", "VENDOR_EVAL", "VENDOR_CERT"],
    "FIN": ["AR_INVOICE", "AP_INVOICE", "PAYMENT", "RECEIPT", "TAX_INVOICE",
            "EXCHANGE_RATE", "BUDGET", "COST_CENTER", "SETTLE_HDR", "SETTLE_DTL"],
    "ACC": ["ACCOUNT", "JOURNAL_HDR", "JOURNAL_DTL", "LEDGER", "CLOSING",
            "SLIP_HDR", "SLIP_DTL", "ASSET", "DEPRECIATION"],
    "CST": ["COST_ROLLUP", "COST_ITEM", "ACTIVITY_RATE", "VARIANCE", "ABC_DRIVER"],
    "CRM": ["CUSTOMER", "CUST_CONTACT", "CUST_ADDR", "LEAD", "OPPORTUNITY",
            "CLAIM", "VOC", "CAMPAIGN"],
    "QC": ["SAMPLE", "SAMPLE_RSLT", "TEST_ITEM", "TEST_SPEC", "DEVIATION",
           "CAPA", "RELEASE", "RETEST"],
    "EQP": ["EQUIP", "EQUIP_SPEC", "CALIB", "CALIB_RSLT", "SENSOR", "ALARM_HIST"],
    "MNT": ["PM_PLAN", "PM_ORD", "PM_RSLT", "BREAKDOWN", "SPARE_PART"],
    "PLN": ["MPS", "MRP_RUN", "MRP_RSLT", "DEMAND", "SUPPLY", "CAPA_PLAN"],
    "MES": ["BATCH_HDR", "BATCH_STEP", "BATCH_PARAM", "EBR", "RECIPE",
            "RECIPE_STEP", "PROCESS_VAL", "CLEANING", "ENV_MONITOR", "WEIGHING",
            "LABEL_ISSUE", "MATERIAL_USE"],
    "LAB": ["LIMS_SAMPLE", "LIMS_RSLT", "INSTRUMENT", "REAGENT", "STABILITY"],
    "EDU": ["COURSE", "ENROLL", "COMPLETE", "GMP_TRAINING"],
    "DOC": ["DOC_MST", "DOC_REV", "SOP", "APPROVAL_LINE", "DISTRIBUTE"],
    "SYS": ["USER", "ROLE", "USER_ROLE", "MENU", "CODE_MST", "CODE_DTL", "CONFIG"],
    "LOG": ["ACCESS_LOG", "JOB_LOG", "IF_LOG", "ERROR_LOG", "AUDIT_TRAIL"],
    "APV": ["APRV_DOC", "APRV_LINE", "APRV_HIST", "DELEGATE"],
    "EXT": ["IF_SAP", "IF_LIMS", "IF_WMS", "IF_HR", "EDI_IN", "EDI_OUT"],
}

# 모듈 테마 컬럼 — 테이블마다 몇 개씩 우선 배치 / thematic columns placed before fillers
MODULE_COLS: dict[str, list[str]] = {
    "HR": ["EMP_NM", "DEPT_CD", "POSITION_CD", "HIRE_YMD", "BIRTH_YMD", "EMAIL"],
    "ORG": ["DEPT_NM", "UP_DEPT_CD", "DEPT_LVL", "MGR_EMP_NO"],
    "ORD": ["CUST_CD", "ITEM_CD", "ORD_QTY", "ORD_AMT", "DUE_YMD", "CURRENCY_CD"],
    "ITM": ["ITEM_NM", "ITEM_TYPE_CD", "UOM_CD", "SPEC_TXT", "MAKER_NM"],
    "PRD": ["PLANT_CD", "LINE_CD", "ITEM_CD", "PLAN_QTY", "GOOD_QTY", "DEFECT_QTY"],
    "BOM": ["PARENT_ITEM_CD", "CHILD_ITEM_CD", "USAGE_QTY", "LOSS_RATE"],
    "SHP": ["CUST_CD", "ITEM_CD", "SHIP_QTY", "SHIP_YMD", "CARRIER_CD", "TEMP_ZONE_CD"],
    "INV": ["WH_CD", "ITEM_CD", "LOT_NO", "STOCK_QTY", "EXP_YMD"],
    "WMS": ["WH_CD", "LOC_CD", "ITEM_CD", "LOT_NO", "QTY"],
    "PUR": ["VENDOR_CD", "ITEM_CD", "PO_QTY", "PO_AMT", "DUE_YMD"],
    "VND": ["VENDOR_NM", "BIZ_NO", "CEO_NM", "TEL_NO", "COUNTRY_CD"],
    "FIN": ["CUST_CD", "AMT", "CURRENCY_CD", "DUE_YMD", "SETTLE_YMD"],
    "ACC": ["ACCT_CD", "DR_AMT", "CR_AMT", "SLIP_YMD", "REMARK"],
    "CST": ["ITEM_CD", "COST_AMT", "PERIOD_YM", "COST_TYPE_CD"],
    "CRM": ["CUST_NM", "GRADE_CD", "OWNER_EMP_NO", "TEL_NO", "EMAIL"],
    "QC": ["ITEM_CD", "LOT_NO", "TEST_CD", "RSLT_VAL", "JUDGE_CD", "TESTER_EMP_NO"],
    "EQP": ["EQUIP_NM", "MODEL_NM", "INSTALL_YMD", "PLANT_CD", "LINE_CD"],
    "MNT": ["EQUIP_CD", "PM_CYCLE_CD", "PLAN_YMD", "RSLT_YMD", "WORKER_EMP_NO"],
    "PLN": ["ITEM_CD", "PLAN_YM", "PLAN_QTY", "FIRM_QTY", "PLANT_CD"],
    "MES": ["BATCH_NO", "ITEM_CD", "RECIPE_CD", "START_DT", "END_DT", "OPERATOR_EMP_NO"],
    "LAB": ["SAMPLE_NO", "ITEM_CD", "LOT_NO", "TEST_CD", "RSLT_VAL", "INSTRUMENT_CD"],
    "EDU": ["COURSE_NM", "EMP_NO", "COMPLETE_YMD", "SCORE_VAL"],
    "DOC": ["DOC_NM", "REV_NO", "WRITER_EMP_NO", "EFFECT_YMD"],
    "SYS": ["USER_NM", "ROLE_CD", "MENU_NM", "SORT_NO"],
    "LOG": ["USER_ID", "IP_ADDR", "ACTION_CD", "TARGET_TXT", "OCCUR_DT"],
    "APV": ["DOC_TITLE", "DRAFTER_EMP_NO", "APRV_EMP_NO", "APRV_YMD", "APRV_STATUS_CD"],
    "EXT": ["IF_ID", "SEND_DT", "RECV_DT", "RSLT_CD", "MSG_TXT"],
}

_FILLER_NAMES = [
    "ITEM_CD", "CUST_CD", "VENDOR_CD", "PLANT_CD", "LINE_CD", "WH_CD", "LOT_NO",
    "QTY", "AMT", "UNIT_PRICE", "CNT", "REMARK", "SEQ_NO", "SORT_NO",
    "BASE_YMD", "START_DT", "END_DT", "UNIT_CD", "TYPE_CD", "KIND_CD", "VER_NO",
    "RATE_VAL", "WGT_VAL", "SIZE_VAL", "ADDR_TXT", "TEL_NO", "EMAIL", "URL_TXT",
    "MEMO_TXT", "TAG_TXT", "REF_NO", "EXT_CD", "BATCH_NO", "LINE_NO", "GRADE_CD",
    "APPROVE_YMD", "CONFIRM_YN_DT", "PERIOD_YM", "CURRENCY_CD", "EXCH_RATE",
]
# (data_type, max_length_bytes) — sys.columns.max_length 의미와 동일 / matches sys.columns semantics
_FILLER_TYPES = [
    ("int", 4), ("bigint", 8), ("decimal", 9), ("datetime2", 8), ("date", 3),
    ("varchar", 20), ("varchar", 50), ("varchar", 100), ("nvarchar", 200), ("char", 1),
]

# 접미사 → 타입 관례 — 노드 패널에 보이는 타입의 사실성 / suffix-driven type convention
_SUFFIX_TYPES: list[tuple[tuple[str, ...], tuple[str, int]]] = [
    (("LOT_NO", "BATCH_NO", "BIZ_NO", "TEL_NO", "REF_NO"), ("varchar", 20)),
    (("_NM", "_TXT", "_TITLE", "TITLE"), ("nvarchar", 200)),
    (("_CD",), ("varchar", 20)),
    (("_YMD",), ("char", 8)),
    (("_YM",), ("char", 6)),
    (("_DT",), ("datetime2", 8)),
    (("_QTY", "_AMT", "_PRICE", "_RATE", "_VAL", "_SCORE", "RATE"), ("decimal", 9)),
    (("_NO", "_ID", "_SEQ", "_CNT", "_LVL"), ("int", 4)),
    (("EMAIL", "URL_TXT", "IP_ADDR"), ("varchar", 100)),
]


def _type_for(column_name: str, fallback: tuple[str, int]) -> tuple[str, int]:
    for suffixes, type_pair in _SUFFIX_TYPES:
        if any(column_name.endswith(s) for s in suffixes):
            return type_pair
    return fallback

TABLE_OID_BASE = 1_000_000
VIEW_OID_BASE = 2_000_000


class _Gen:
    """Single-run generator state. / 생성 1회분 상태."""

    def __init__(self, seed: int):
        self.rng = random.Random(seed)
        self.seed = seed
        self.tables: list[dict] = []
        self.views: list[dict] = []
        self.columns: dict[int, list[dict]] = {}   # object_id -> raw column rows
        self.key_constraints: list[dict] = []
        self.foreign_keys: list[dict] = []
        self.view_definitions: list[dict] = []
        self.deps: list[dict] = []
        self.unresolved_objects: list[dict] = []
        self.relations: list[dict] = []            # ground-truth relations
        self.joins: list[dict] = []                # ground-truth view joins (Phase 2)
        self.lineage_full: list[dict] = []         # column-precision truth (Phase 2)
        self.phase1: dict[int, list[dict]] = {}    # view oid -> set-level rows (Phase 1)
        self.value_sets: list[dict] = []
        self.cases: dict[str, list] = {}
        self._src_used: set[tuple[int, str]] = set()
        self._next_table_oid = TABLE_OID_BASE
        self._next_view_oid = VIEW_OID_BASE

    # ---------- helpers ----------

    def case(self, key: str, value) -> None:
        self.cases.setdefault(key, []).append(value)

    def qname(self, obj: dict) -> str:
        return f"{obj['schema']}.{obj['name']}"

    def table_by_oid(self, oid: int) -> dict:
        return next(t for t in self.tables + self.views if t["object_id"] == oid)

    def col_names(self, oid: int) -> list[str]:
        return [c["name"] for c in self.columns[oid]]

    def add_column(self, oid: int, name: str, data_type: str, max_length: int,
                   is_nullable: bool, is_computed: bool = False) -> dict:
        # 테이블 내 중복 이름은 숫자 접미사로 회피 / dedupe names with numeric suffix
        used = {c["name"] for c in self.columns[oid]}
        base, n = name, 2
        while name in used:
            name, n = f"{base}{n}", n + 1
        col = {
            "object_id": oid, "name": name, "ordinal": len(self.columns[oid]) + 1,
            "data_type": data_type, "max_length": max_length,
            "is_nullable": is_nullable, "is_computed": is_computed,
        }
        self.columns[oid].append(col)
        return col

    # ---------- tables ----------

    def build_tables(self) -> None:
        rng = self.rng
        for prefix, count in MODULES:
            style = rng.choice(["T_", "TB_", ""])  # 모듈별 네이밍 편차 / per-module naming drift
            domain_pool = MODULE_NOUNS.get(prefix, [])
            used_nouns: set[str] = set()
            for i in range(count):
                if i < len(domain_pool):
                    noun = domain_pool[i]  # 첫 항목이 모듈 마스터 / first entry is the master
                else:
                    noun = rng.choice(
                        [n for n in _TABLE_NOUNS if n not in used_nouns] or _TABLE_NOUNS
                    )
                used_nouns.add(noun)
                name = f"{style}{prefix}_{noun}"
                oid = self._next_table_oid = self._next_table_oid + 1
                table = {
                    "object_id": oid, "schema": "dbo", "name": name, "type": "table",
                    "row_count": rng.choice([0, 12, 340, 5_000, 48_000, 220_000, 1_500_000]),
                    "_module": prefix, "_is_master": i == 0,
                }
                self.tables.append(table)
                self.columns[oid] = []
                # PK는 엔티티 첫 토큰 기반 — SO_NO·EMP_NO 류 / entity-derived key name
                pk_base = noun.split("_")[0]
                pk_name = f"{pk_base}_{rng.choice(['NO', 'ID', 'CD', 'SEQ'])}"
                self.add_column(oid, pk_name, "int", 4, is_nullable=False)
                self.key_constraints.append(
                    {"name": f"PK_{name}", "type": "pk", "object_id": oid, "columns": [pk_name]}
                )
                table["_pk"] = pk_name
                # 모듈 테마 컬럼 우선 배치 / thematic columns before generic fillers
                for col_name in rng.sample(
                    MODULE_COLS.get(prefix, []),
                    k=min(len(MODULE_COLS.get(prefix, [])), rng.randint(3, 6)),
                ):
                    dt, ln = _type_for(col_name, rng.choice(_FILLER_TYPES))
                    self.add_column(oid, col_name, dt, ln, is_nullable=rng.random() < 0.5)

    # ---------- relations ----------

    def build_relations(self) -> None:
        """FK 있는 관계 + FK 없는 실제 관계 / relations with and without FK constraints."""
        rng = self.rng
        by_module: dict[str, list[dict]] = {}
        for t in self.tables:
            by_module.setdefault(t["_module"], []).append(t)

        pairs: list[tuple[dict, dict]] = []
        for tables in by_module.values():
            master = tables[0]
            for child in tables[1:]:
                if rng.random() < 0.55:
                    parent = master if rng.random() < 0.7 else rng.choice(
                        tables[: tables.index(child)] or [master]
                    )
                    pairs.append((child, parent))
        hub_masters = [by_module[m][0] for m in ("HR", "SYS", "ITM")]
        for _ in range(30):
            child = rng.choice(self.tables)
            parent = rng.choice(hub_masters)
            # 허브 마스터는 자식 금지 — 관계 그래프를 비순환으로 유지해
            # 값 집합을 위상 순서로 생성할 수 있게 한다 / keeps the relation graph acyclic
            if child not in hub_masters:
                pairs.append((child, parent))

        for child, parent in pairs:
            pk = parent["_pk"]
            variant = rng.random() < 0.15
            child_col = pk.replace("_", "") if variant else pk  # EMP_NO → EMPNO 류 변형
            if child_col in self.col_names(child["object_id"]) and (
                child["_module"] != parent["_module"] or variant
            ):
                child_col = f"{parent['_module']}_{pk}"
            # 한 src 컬럼은 관계 하나만 — 값 집합 불변식 유지 / one relation per src column
            if (child["object_id"], child_col) in self._src_used:
                continue
            self._src_used.add((child["object_id"], child_col))
            if child_col not in self.col_names(child["object_id"]):
                self.add_column(child["object_id"], child_col, "int", 4, is_nullable=rng.random() < 0.3)

            is_fk = rng.random() < 0.75
            has_orphans = (not is_fk) and rng.random() < 0.3
            relation = {
                "src_object": self.qname(child), "src_column": child_col,
                "tgt_object": self.qname(parent), "tgt_column": pk,
                "src_object_id": child["object_id"], "tgt_object_id": parent["object_id"],
                "kind": "fk" if is_fk else "real_no_fk",
                "cardinality": "1:N", "naming_variant": variant,
                "orphan_count": rng.randint(1, 25) if has_orphans else 0,
                "containment": 1.0, "in_view_join": False,
            }
            if is_fk:
                self.foreign_keys.append({
                    "name": f"FK_{child['name']}_{parent['name']}",
                    "src_object_id": child["object_id"], "tgt_object_id": parent["object_id"],
                    "columns": [{"src_column": child_col, "tgt_column": pk}],
                })
            self.relations.append(relation)
        self.case("fk", sum(1 for r in self.relations if r["kind"] == "fk"))
        self.case("real_no_fk", sum(1 for r in self.relations if r["kind"] == "real_no_fk"))

    def build_fillers(self) -> None:
        """Trap·audit·computed·filler 컬럼으로 목표 9,000개를 맞춘다 / pad to the column target."""
        rng = self.rng
        for t in self.tables:
            oid = t["object_id"]
            if rng.random() < 0.5:  # 저카디널리티 함정 / low-cardinality trap
                self.add_column(oid, "USE_YN", "char", 1, is_nullable=False)
                self.case("low_cardinality", f"{self.qname(t)}.USE_YN")
            if rng.random() < 0.3:
                self.add_column(oid, "STATUS_CD", "varchar", 2, is_nullable=False)
                self.case("low_cardinality", f"{self.qname(t)}.STATUS_CD")
            if rng.random() < 0.7:  # audit 공통 컬럼 / audit columns
                for nm, dt, ln in [("REG_DT", "datetime2", 8), ("REG_USER_ID", "varchar", 20),
                                   ("UPD_DT", "datetime2", 8), ("UPD_USER_ID", "varchar", 20)]:
                    self.add_column(oid, nm, dt, ln, is_nullable=nm.startswith("UPD"))

        # 계산 컬럼 케이스 / computed-column case (sys.columns.is_computed)
        for t in rng.sample(self.tables, 15):
            oid = t["object_id"]
            self.add_column(oid, "QTY", "decimal", 9, is_nullable=True)
            self.add_column(oid, "PRC", "decimal", 9, is_nullable=True)
            self.add_column(oid, "TOT_AMT", "decimal", 9, is_nullable=True, is_computed=True)
            self.case("computed_table_columns", f"{self.qname(t)}.TOT_AMT")

        # 잔여분 필러로 목표 근접 / top up with fillers toward the target
        deficit = COLUMN_COUNT_TARGET - sum(len(self.columns[t["object_id"]]) for t in self.tables)
        while deficit > 0:
            t = rng.choice(self.tables)
            nm = rng.choice(_FILLER_NAMES)
            dt, ln = _type_for(nm, rng.choice(_FILLER_TYPES))
            self.add_column(t["object_id"], nm, dt, ln, is_nullable=rng.random() < 0.6)
            deficit -= 1

    # ---------- value sets ----------

    def build_value_sets(self) -> None:
        """관계 양끝 + 함정 컬럼의 합성 값 집합 / synthetic value sets for the FakeJoinValidator.

        한 컬럼이 자식이자 부모인 체인(T_DTL.NO → T_MST.NO ← ...)이 있으므로
        위상 순서로 생성한다: 부모 먼저, 자식은 부모의 부분집합 샘플.
        containment는 선언값이 아니라 최종 집합에서 재계산 — 데이터와 기대치가
        어긋날 수 없다. / Sets are built parent-first along the relation DAG and
        containment is recomputed from the final sets, so data and expectations
        cannot drift apart.
        """
        rng = self.rng
        rel_by_src = {(r["src_object"], r["src_column"]): r for r in self.relations}
        values: dict[tuple[str, str], list] = {}

        def resolve(key: tuple[str, str], visiting: set) -> None:
            if key in values:
                return
            rel = rel_by_src.get(key)
            if rel is None or key in visiting:  # 루트 부모 또는 방어적 순환 차단
                n = rng.randint(60, 800)
                base = rng.randint(1, 9) * 100_000
                values[key] = list(range(base, base + n))
                return
            visiting.add(key)
            tgt_key = (rel["tgt_object"], rel["tgt_column"])
            resolve(tgt_key, visiting)
            parent_vals = values[tgt_key]
            child_n = rng.randint(max(10, len(parent_vals) // 3), len(parent_vals))
            child_vals = sorted(rng.sample(parent_vals, child_n))
            if rel["orphan_count"]:
                top = max(parent_vals)
                child_vals += [top + i + 1 for i in range(rel["orphan_count"])]
            values[key] = child_vals

        for rel in self.relations:
            resolve((rel["src_object"], rel["src_column"]), set())
            resolve((rel["tgt_object"], rel["tgt_column"]), set())

        # 실제 집합 기준 재계산 / recompute from the final sets
        for rel in self.relations:
            src = set(values[(rel["src_object"], rel["src_column"])])
            tgt = set(values[(rel["tgt_object"], rel["tgt_column"])])
            rel["containment"] = round(len(src & tgt) / len(src), 4)
            rel["orphan_count"] = len(src - tgt)

        # 부모 키는 유니크(row_count == distinct) — 카디널리티 판정(§3.2)의 전제
        # parent keys are unique; child columns repeat values (1:N from the child side)
        parent_keys = {(r["tgt_object"], r["tgt_column"]) for r in self.relations}
        for (obj, col), vals in sorted(values.items()):
            is_parent = (obj, col) in parent_keys
            self.value_sets.append({
                "object": obj, "column": col,
                "row_count": len(vals) if is_parent else max(len(vals) * 3, 30),
                "distinct_count": len(vals), "values": vals,
            })

        # 함정 값 집합 — 아무 컬럼에나 containment 1.0 / traps hit 1.0 against anything
        for spec in self.cases.get("low_cardinality", [])[:40]:
            obj, col = spec.rsplit(".", 1)
            if (obj, col) not in values:
                trap_vals = ["Y", "N"] if col == "USE_YN" \
                    else [f"{i:02d}" for i in range(1, rng.randint(4, 9))]
                self.value_sets.append({
                    "object": obj, "column": col, "row_count": rng.randint(1_000, 200_000),
                    "distinct_count": len(trap_vals), "values": trap_vals,
                })

    # ---------- views ----------

    def _new_view(self, name: str, definition: str | None) -> dict:
        oid = self._next_view_oid = self._next_view_oid + 1
        view = {"object_id": oid, "schema": "dbo", "name": name, "type": "view", "row_count": None}
        self.views.append(view)
        self.columns[oid] = []
        self.phase1[oid] = []
        self.view_definitions.append({"object_id": oid, "definition": definition})
        return view

    def _dep(self, view: dict, target: dict | None, column: str | None,
             database: str | None = None, name: str | None = None) -> None:
        self.deps.append({
            "view_object_id": view["object_id"],
            "referenced_object_id": target["object_id"] if target else None,
            "referenced_database": database,
            "referenced_name": name if target is None else self.qname(target),
            "referenced_column": column,
            "is_resolved": target is not None,
        })

    def _lineage(self, view: dict, view_col: str, base: dict | None, base_col: str | None,
                 depth: int, kind: str, flag: str | None = None) -> None:
        self.lineage_full.append({
            "view": self.qname(view), "view_column": view_col,
            "base": self.qname(base) if base else None, "base_column": base_col,
            "depth": depth, "mapping_kind": kind, "flag": flag,
        })

    def _phase1_add(self, view: dict, base: dict | None, base_col: str | None,
                    depth: int, flag: str | None = None) -> None:
        self.phase1[view["object_id"]].append({
            "view": self.qname(view), "view_column": "*",
            "base": self.qname(base) if base else None, "base_column": base_col,
            "depth": depth, "mapping_kind": "set", "flag": flag,
        })

    def _inherit_phase1(self, view: dict, parent_view: dict) -> None:
        """중첩 뷰는 부모의 전체 참조 집합을 상속 / nested views inherit the parent's full set."""
        rows = self.phase1[parent_view["object_id"]]
        if any(r["flag"] for r in rows) or any(r["depth"] + 1 > DEPTH_LIMIT for r in rows):
            flag = "cycle" if any(r["flag"] == "cycle" for r in rows) else "depth_exceeded"
            self._phase1_add(view, None, None, DEPTH_LIMIT, flag=flag)
            self.case("deep_chain_exceeded" if flag == "depth_exceeded" else "cycle_inherited",
                      self.qname(view))
            return
        for r in rows:
            base = next(t for t in self.tables if self.qname(t) == r["base"])
            self._phase1_add(view, base, r["base_column"], r["depth"] + 1)

    def _project(self, view: dict, src: dict, names: list[str],
                 depth_from_base: dict[str, tuple] | None = None) -> None:
        """src(테이블·뷰)의 컬럼을 그대로 투영 / project columns from a table or view."""
        src_cols = {c["name"]: c for c in self.columns[src["object_id"]]}
        for nm in names:
            c = src_cols[nm]
            added = self.add_column(view["object_id"], nm, c["data_type"], c["max_length"], c["is_nullable"])
            self._dep(view, src, nm)
            if depth_from_base and nm in depth_from_base:
                base, base_col, depth = depth_from_base[nm]
                self._lineage(view, added["name"], base, base_col, depth + 1, "direct")
            elif src["type"] == "table":
                self._lineage(view, added["name"], src, nm, 1, "direct")
                self._phase1_add(view, src, nm, 1)

    def _direct_map_of(self, parent_view: dict, names: list[str]) -> dict[str, tuple]:
        """부모 뷰 출력 컬럼의 (base, base_col, depth) 매핑 / parent's direct mappings."""
        dm = {}
        for r in self.lineage_full:
            if r["view"] == self.qname(parent_view) and r["view_column"] in names \
                    and r["mapping_kind"] == "direct":
                base = next(t for t in self.tables if self.qname(t) == r["base"])
                dm[r["view_column"]] = (base, r["base_column"], r["depth"])
        return dm

    def build_views(self) -> None:
        rng = self.rng
        rel_oids = sorted({r["src_object_id"] for r in self.relations})
        plain_tables = [t for t in self.tables if t["object_id"] not in rel_oids]

        # SELECT * 뷰 / star views
        for t in rng.sample(plain_tables, 5):
            v = self._new_view(f"V_{t['name']}_ALL",
                               f"CREATE VIEW dbo.V_{t['name']}_ALL AS SELECT * FROM dbo.{t['name']}")
            self._project(v, t, self.col_names(t["object_id"]))
            self.case("select_star", self.qname(v))

        # 단순 투영 + 계산식 파생 / simple projections, some with derived expressions
        simple_views = []
        for t in rng.sample(self.tables, 18):
            names = self.col_names(t["object_id"])
            picked = names[: rng.randint(3, min(8, len(names)))]
            sel = ", ".join(picked)
            v = self._new_view(f"V_{t['name']}",
                               f"CREATE VIEW dbo.V_{t['name']} AS SELECT {sel} FROM dbo.{t['name']}")
            self._project(v, t, picked)
            if rng.random() < 0.35 and len(picked) >= 2:
                a, b = picked[0], picked[1]
                dv = f"{a}_CALC"
                added = self.add_column(v["object_id"], dv, "nvarchar", 200, True)
                self.view_definitions[-1]["definition"] = (
                    f"CREATE VIEW dbo.V_{t['name']} AS SELECT {sel}, "
                    f"CONCAT({a}, '-', {b}) AS {dv} FROM dbo.{t['name']}"
                )
                for srcc in (a, b):
                    self._lineage(v, added["name"], t, srcc, 1, "derived")
                self.case("derived_view_columns", f"{self.qname(v)}.{added['name']}")
            simple_views.append((v, t))

        # JOIN 뷰 — ON 조건이 관계 추론 최상위 신호 / join views feed Phase 2's top signal
        purposes = ["SUMMARY", "LIST", "DAILY", "MONTHLY", "DETAIL", "STAT", "CURR", "RPT"]
        taken_names = {v["name"] for v in self.views}
        for i, rel in enumerate(rng.sample(self.relations, 18)):
            child = self.table_by_oid(rel["src_object_id"])
            parent = self.table_by_oid(rel["tgt_object_id"])
            rel["in_view_join"] = True
            c_cols = [n for n in self.col_names(child["object_id"])[:4] if n != rel["src_column"]][:3]
            # 출력 컬럼명 중복은 실제 T-SQL에서 불법 — parent 측은 겹치지 않는 이름만
            # duplicate output names are illegal T-SQL; pick non-colliding parent columns
            used_names = set(c_cols) | {rel["src_column"]}
            p_cols = [n for n in self.col_names(parent["object_id"])[:6]
                      if n != rel["tgt_column"] and n not in used_names][:2]
            join_type = rng.choice(["inner", "left"])
            kw = "JOIN" if join_type == "inner" else "LEFT JOIN"
            sel = ", ".join([f"c.{n}" for n in c_cols + [rel["src_column"]]] + [f"p.{n}" for n in p_cols])
            # 업무형 뷰 이름 — V_ORD_SO_DTL_SUMMARY 류 / business-style view names
            base = child["name"].removeprefix("TB_").removeprefix("T_")
            view_name = f"V_{base}_{purposes[i % len(purposes)]}"
            if view_name in taken_names:
                view_name = f"{view_name}_{i:02d}"
            taken_names.add(view_name)
            v = self._new_view(
                view_name,
                f"CREATE VIEW dbo.{view_name} AS SELECT {sel} "
                f"FROM dbo.{child['name']} c {kw} dbo.{parent['name']} p "
                f"ON c.{rel['src_column']} = p.{rel['tgt_column']}",
            )
            self._project(v, child, c_cols + [rel["src_column"]])
            self._project(v, parent, p_cols)
            self.joins.append({
                "view": self.qname(v),
                "left_object": rel["src_object"], "left_column": rel["src_column"],
                "right_object": rel["tgt_object"], "right_column": rel["tgt_column"],
                "join_type": join_type,
            })

        # 중첩 뷰 2·3단 — 집계·리포트 뷰 네이밍 / nested views named like reporting layers
        nested2 = []
        for v1, _ in rng.sample(simple_views, 8):
            names = [n for n in self.col_names(v1["object_id"]) if not n.endswith("_CALC")][:4]
            v2_name = f"V_SUM_{v1['name'].removeprefix('V_')}"
            v2 = self._new_view(v2_name,
                                f"CREATE VIEW dbo.{v2_name} AS "
                                f"SELECT {', '.join(names)} FROM dbo.{v1['name']}")
            self._project(v2, v1, names, depth_from_base=self._direct_map_of(v1, names))
            self._inherit_phase1(v2, v1)
            nested2.append(v2)
        for v2 in rng.sample(nested2, 4):
            names = self.col_names(v2["object_id"])[:3]
            v3_name = f"V_RPT_{v2['name'].removeprefix('V_SUM_')}"
            v3 = self._new_view(v3_name,
                                f"CREATE VIEW dbo.{v3_name} AS "
                                f"SELECT {', '.join(names)} FROM dbo.{v2['name']}")
            self._project(v3, v2, names, depth_from_base=self._direct_map_of(v2, names))
            self._inherit_phase1(v3, v2)
            self.case("nested3", self.qname(v3))

        # 12단 체인 — 상한 10 초과 유발 / 12-deep chain triggers depth_exceeded
        chain_base = self.table_by_oid(rel_oids[len(rel_oids) // 2])
        chain_cols = self.col_names(chain_base["object_id"])[:3]
        prev: dict = chain_base
        for k in range(1, 13):
            v = self._new_view(
                f"V_CHAIN_{k:02d}",
                f"CREATE VIEW dbo.V_CHAIN_{k:02d} AS "
                f"SELECT {', '.join(chain_cols)} FROM dbo.{prev['name']}",
            )
            src_cols = {c["name"]: c for c in self.columns[chain_base["object_id"]]}
            for nm in chain_cols:
                c = src_cols[nm]
                self.add_column(v["object_id"], nm, c["data_type"], c["max_length"], c["is_nullable"])
                self._dep(v, prev, nm)
                if k <= DEPTH_LIMIT:
                    self._lineage(v, nm, chain_base, nm, k, "direct")
            if k <= DEPTH_LIMIT:
                for nm in chain_cols:
                    self._phase1_add(v, chain_base, nm, k)
            else:
                self._phase1_add(v, None, None, DEPTH_LIMIT, flag="depth_exceeded")
                self._lineage(v, "*", None, None, DEPTH_LIMIT, "set", flag="depth_exceeded")
                self.case("deep_chain_exceeded", self.qname(v))
            prev = v
        self.case("deep_chain", "dbo.V_CHAIN_12")

        # 순환 참조 뷰 / cyclic views — 엔진은 무한루프 없이 cycle 플래그를 내야 한다
        vc_a = self._new_view("V_CYCLE_A", "CREATE VIEW dbo.V_CYCLE_A AS SELECT REF_VAL FROM dbo.V_CYCLE_B")
        vc_b = self._new_view("V_CYCLE_B", "CREATE VIEW dbo.V_CYCLE_B AS SELECT REF_VAL FROM dbo.V_CYCLE_A")
        for vv in (vc_a, vc_b):
            self.add_column(vv["object_id"], "REF_VAL", "int", 4, True)
            self._phase1_add(vv, None, None, 0, flag="cycle")
            self._lineage(vv, "*", None, None, 0, "set", flag="cycle")
            self.case("cycle", self.qname(vv))
        self._dep(vc_a, vc_b, "REF_VAL")
        self._dep(vc_b, vc_a, "REF_VAL")

        # 크로스 DB 참조 / cross-database references
        for i, t in enumerate(rng.sample(self.tables, 3)):
            pk = t["_pk"]
            v = self._new_view(
                f"V_XDB_{i}",
                f"CREATE VIEW dbo.V_XDB_{i} AS SELECT l.{pk}, r.RMT_COL FROM dbo.{t['name']} l "
                f"JOIN ERP_LEGACY.dbo.T_REMOTE_{i} r ON l.{pk} = r.{pk}",
            )
            self.add_column(v["object_id"], pk, "int", 4, False)
            self.add_column(v["object_id"], "RMT_COL", "varchar", 50, True)
            self._dep(v, t, pk)
            self._dep(v, None, None, database="ERP_LEGACY", name=f"dbo.T_REMOTE_{i}")
            self._lineage(v, pk, t, pk, 1, "direct")
            self._phase1_add(v, t, pk, 1)
            self.case("crossdb", self.qname(v))

        # 미해석 참조 (드랍된 테이블) / stale refs — referenced_id IS NULL
        for i, t in enumerate(rng.sample(self.tables, 3)):
            pk = t["_pk"]
            v = self._new_view(
                f"V_STALE_{i}",
                f"CREATE VIEW dbo.V_STALE_{i} AS SELECT a.{pk} FROM dbo.{t['name']} a "
                f"JOIN dbo.T_DROPPED_{i} g ON a.{pk} = g.{pk}",
            )
            self.add_column(v["object_id"], pk, "int", 4, False)
            self._dep(v, t, pk)
            self._dep(v, None, None, name=f"dbo.T_DROPPED_{i}")
            self._lineage(v, pk, t, pk, 1, "direct")
            self._phase1_add(v, t, pk, 1)
            self.case("stale_unresolved", self.qname(v))

        # VIEW DEFINITION 권한 차단 / permission-blocked (definition NULL, deps 없음)
        for t in rng.sample(self.tables, 4):
            v = self._new_view(f"V_SEC_{t['name']}", None)
            for nm in self.col_names(t["object_id"])[:3]:
                self.add_column(v["object_id"], nm, "varchar", 50, True)
            self.case("definition_null", self.qname(v))

        # sqlglot 파싱 도전 T-SQL / parse-challenge T-SQL (PIVOT, CROSS APPLY, hints)
        challenge_sql = [
            ("V_PVT_{n}", "CREATE VIEW dbo.{vn} AS SELECT * FROM (SELECT {c0}, {c1} FROM dbo.{tn}) s "
                          "PIVOT (COUNT({c1}) FOR {c1} IN ([A],[B],[C])) p"),
            ("V_PVT2_{n}", "CREATE VIEW dbo.{vn} AS SELECT * FROM dbo.{tn} "
                           "PIVOT (SUM({c1}) FOR {c0} IN ([X],[Y])) AS pv"),
            ("V_APL_{n}", "CREATE VIEW dbo.{vn} AS SELECT a.{c0}, x.v FROM dbo.{tn} a "
                          "CROSS APPLY (SELECT TOP 1 {c1} AS v FROM dbo.{tn} WHERE {c0} = a.{c0}) x"),
            ("V_APL2_{n}", "CREATE VIEW dbo.{vn} AS SELECT a.{c0} FROM dbo.{tn} a "
                           "OUTER APPLY (SELECT MAX({c1}) m FROM dbo.{tn}) x"),
            ("V_HINT_{n}", "CREATE VIEW dbo.{vn} AS SELECT {c0}, {c1} FROM dbo.{tn} "
                           "WITH (NOLOCK, INDEX(PK_{tn}))"),
            ("V_HINT2_{n}", "CREATE VIEW dbo.{vn} AS SELECT {c0} FROM dbo.{tn} WITH (READUNCOMMITTED)"),
        ]
        for i, (name_tpl, sql_tpl) in enumerate(challenge_sql):
            t = rng.choice(self.tables)
            names = self.col_names(t["object_id"])
            vn = name_tpl.format(n=i)
            v = self._new_view(vn, sql_tpl.format(vn=vn, tn=t["name"], c0=names[0], c1=names[1]))
            for nm in names[:2]:
                self.add_column(v["object_id"], nm, "varchar", 50, True)
                self._dep(v, t, nm)
                self._lineage(v, "*", t, nm, 1, "set")
                self._phase1_add(v, t, nm, 1)
            self.case("parse_challenge", self.qname(v))

        # dm_sql_referenced_entities 실패 격리 / DMV failure — object-level deps only
        for t in rng.sample(self.tables, 3):
            first_col = self.col_names(t["object_id"])[0]
            v = self._new_view(f"V_DMV_{t['name']}",
                               f"CREATE VIEW dbo.V_DMV_{t['name']} AS SELECT {first_col} FROM dbo.{t['name']}")
            self.add_column(v["object_id"], first_col, "varchar", 50, True)
            self._dep(v, t, None)  # 컬럼 정보 없음 / no column grain
            self.unresolved_objects.append(
                {"object_id": v["object_id"], "reason": "dm_sql_referenced_entities failed"}
            )
            self._lineage(v, "*", t, None, 1, "set")
            self._phase1_add(v, t, None, 1)
            self.case("dmv_failed", self.qname(v))

    # ---------- output ----------

    def write(self, out_dir: Path) -> dict:
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "expected").mkdir(exist_ok=True)

        def clean_obj(o: dict) -> dict:
            return {k: v for k, v in o.items() if not k.startswith("_")}

        lineage_phase1 = []
        seen: set[tuple] = set()
        for oid in sorted(self.phase1):
            for row in self.phase1[oid]:
                key = (row["view"], row["base"], row["base_column"], row["depth"], row["flag"])
                if key not in seen:
                    seen.add(key)
                    lineage_phase1.append(row)

        catalog = {
            "source_db": "FIXTURE_DB",
            "collected_at": "2026-08-01T00:00:00+00:00",
            "objects": [clean_obj(o) for o in self.tables + self.views],
            "columns": [c for oid in sorted(self.columns) for c in self.columns[oid]],
            "key_constraints": self.key_constraints,
            "foreign_keys": self.foreign_keys,
            "view_definitions": self.view_definitions,
        }
        manifest = {
            "seed": self.seed, "depth_limit": DEPTH_LIMIT,
            "counts": {
                "tables": len(self.tables),
                "table_columns": sum(len(self.columns[t["object_id"]]) for t in self.tables),
                "views": len(self.views),
                "view_columns": sum(len(self.columns[v["object_id"]]) for v in self.views),
                "fk_constraints": len(self.foreign_keys),
                "relations": len(self.relations),
                "deps": len(self.deps),
                "value_set_columns": len(self.value_sets),
            },
            "case_counts": {k: len(v) for k, v in sorted(self.cases.items())},
            "cases": {k: v[:60] for k, v in sorted(self.cases.items())},
        }
        files = {
            "catalog.json": catalog,
            "view_deps.json": {"deps": self.deps, "unresolved_objects": self.unresolved_objects},
            "value_sets.json": {"columns": self.value_sets},
            "manifest.json": manifest,
            "expected/lineage_full.json": {"rows": self.lineage_full},
            "expected/lineage_phase1.json": {"rows": lineage_phase1},
            "expected/relations.json": {"rows": [
                {k: v for k, v in r.items() if k not in ("src_object_id", "tgt_object_id")}
                for r in self.relations
            ]},
            "expected/joins.json": {"rows": self.joins},
        }
        for name, payload in files.items():
            (out_dir / name).write_text(
                json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=1) + "\n"
            )
        return manifest


def generate(seed: int, out_dir: Path) -> dict:
    """Generate one fixture set; returns the manifest. / 픽스처 1세트 생성 후 manifest 반환."""
    g = _Gen(seed)
    g.build_tables()
    g.build_relations()
    g.build_fillers()
    g.build_value_sets()
    g.build_views()
    return g.write(out_dir)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("fixtures"))
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    manifest = generate(args.seed, args.out)
    print(json.dumps(manifest["counts"], indent=2))


if __name__ == "__main__":
    main()
