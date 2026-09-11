# backend/app/domain/value_probe.py
"""Value probe planning — pure logic, no DB. / 값 추적 플래너 (순수 로직).

값 하나가 어느 컬럼에 들어갈 수 있는지는 카탈로그만 보고 결정한다. 여기서 잘라낸 만큼
소스 DB에 보내는 쿼리가 줄어든다 — 이 모듈은 쿼리 0개로 동작해야 한다.
The planner never touches a source DB; every column it drops is a query saved.
"""

import re
import uuid
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation

from app.domain.scoring import normalize_name

# 업무 상수 — 바꾸면 쿼리 크기·감사 규약이 달라진다 / business constants
PROBE_VALUE_MAX_LEN = 100          # 값 길이 상한(자) — 미리보기 필터와 동일
PROBE_MAX_VARIANTS = 8             # 컬럼당 IN (...) 변형값 상한
PROBE_MAX_COLUMNS_PER_QUERY = 40   # 이 수를 넘는 객체는 쿼리를 나눈다
PROBE_COUNT_CAP = 1000             # 건수 상한 — 초과는 "1000+"
PROBE_MAX_SCHEMAS = 50             # 요청당 스키마 수 상한

FAMILY_TEXT = "text"
FAMILY_INT = "int"
FAMILY_DECIMAL = "decimal"
FAMILY_DATE = "date"
FAMILY_GUID = "guid"

# 엔진별 타입 → 패밀리. 목록에 없는 타입은 None(제외) — bit·binary·xml·rowversion 등은
# 값 검색 대상이 아니다. MSSQL timestamp는 rowversion이고 PG timestamp는 날짜다.
_MSSQL_FAMILIES = {
    FAMILY_TEXT: {"char", "varchar", "nchar", "nvarchar", "text", "ntext"},
    FAMILY_INT: {"tinyint", "smallint", "int", "bigint"},
    FAMILY_DECIMAL: {"decimal", "numeric", "money", "smallmoney", "float", "real"},
    FAMILY_DATE: {"date", "datetime", "datetime2", "smalldatetime", "datetimeoffset"},
    FAMILY_GUID: {"uniqueidentifier"},
}
_POSTGRES_FAMILIES = {
    FAMILY_TEXT: {"character", "character varying", "varchar", "char", "bpchar", "text",
                  "name", "citext"},
    FAMILY_INT: {"smallint", "integer", "bigint", "int", "int2", "int4", "int8"},
    FAMILY_DECIMAL: {"numeric", "decimal", "real", "double precision", "float4", "float8",
                     "money"},
    FAMILY_DATE: {"date", "timestamp", "timestamp without time zone",
                  "timestamp with time zone", "timestamptz"},
    FAMILY_GUID: {"uuid"},
}
# MSSQL n-타입은 max_length가 바이트 — 문자 수는 절반 / byte length; halve for chars
_MSSQL_WIDE = {"nchar", "nvarchar", "ntext"}

_NUMBER_RE = re.compile(r"^-?\d+(\.\d+)?$")
_NUMBER_NOISE_RE = re.compile(r"[,\s_₩$€¥]")
_COMPACT_NOISE_RE = re.compile(r"[\s\-,]")
_DATE_SEP_RE = re.compile(
    r"^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$"
)
_DATE_COMPACT_RE = re.compile(r"^(\d{4})(\d{2})(\d{2})$")
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}(?::\d{2})?)?$")
# 조건이 뷰 아래로 내려가지 않는 모양 — 뷰 전체를 만든 뒤 거르므로 heavy
_VIEW_HEAVY_RE = re.compile(r"\b(GROUP\s+BY|DISTINCT|UNION|TOP|OVER)\b", re.IGNORECASE)


@dataclass(frozen=True)
class ValueInterpretation:
    """입력값을 패밀리별 변형값으로 푼 결과 / the value, expanded per family."""

    raw: str
    text: tuple[str, ...]
    ints: tuple[int, ...]
    decimals: tuple[str, ...]
    dates: tuple[str, ...]
    guids: tuple[str, ...]


@dataclass(frozen=True)
class ProbeColumn:
    """프로브 쿼리의 컬럼 하나 — 어떤 리터럴로 어떤 값들을 시도할지 / one probed column."""

    name: str
    family: str
    literal: str                     # text-narrow | text-wide | number | date | guid
    values: tuple[str | int, ...]
    op: str = "eq"                   # eq | contains

    def to_dict(self) -> dict:
        return {"name": self.name, "family": self.family, "literal": self.literal,
                "values": list(self.values), "op": self.op}

    @classmethod
    def from_dict(cls, data: dict) -> "ProbeColumn":
        return cls(data["name"], data["family"], data["literal"],
                   tuple(data["values"]), data.get("op", "eq"))


@dataclass(frozen=True)
class ProbeCatalogColumn:
    """플래너가 보는 카탈로그 컬럼 — ORM에서 떼어낸 최소 정보 / catalog column, decoupled."""

    object_id: int
    name: str
    data_type: str
    max_length: int
    distinct_count: int | None
    masking_policy: str | None
    has_direct_lineage: bool


@dataclass(frozen=True)
class ProbeCatalogObject:
    """플래너가 보는 카탈로그 객체 / catalog object, decoupled from the ORM."""

    object_id: int
    qname: str
    object_type: str
    row_count: int | None
    definition: str | None
    base_row_counts: tuple[int | None, ...] = ()


@dataclass(frozen=True)
class PlannedTarget:
    """객체 하나에 보낼 프로브 1건 / one probe query for one object."""

    object_id: int
    qname: str
    object_type: str
    columns: tuple[ProbeColumn, ...]
    tier: str                        # auto | heavy
    heavy_reason: str | None         # rows | unknown_rows | view_shape
    est_rows: int | None
    rank: int


@dataclass(frozen=True)
class MatchedColumn:
    name: str
    matched_variant: str


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def _parse_number(text: str) -> Decimal | None:
    if not _NUMBER_RE.match(text):
        return None
    try:
        return Decimal(text)
    except InvalidOperation:
        return None


def _canon_decimal(number: Decimal) -> str:
    # normalize()는 1000을 1E+3으로 쓴다 — 'f' 포맷이 지수 표기를 되돌린다
    return format(number.normalize(), "f")


def _parse_date(text: str) -> tuple[str, str] | None:
    """(ISO 문자열, 압축형 YYYYMMDD) — 실제 달력 날짜가 아니면 None."""
    match = _DATE_SEP_RE.match(text)
    if match:
        year, month, day, hh, mm, ss = match.groups()
        try:
            parsed = date(int(year), int(month), int(day))
        except ValueError:
            return None
        iso = parsed.isoformat()
        if hh is not None:
            iso += f" {int(hh):02d}:{mm}:{ss or '00'}"
        return iso, parsed.strftime("%Y%m%d")
    match = _DATE_COMPACT_RE.match(text)
    if match:
        try:
            parsed = date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
        except ValueError:
            return None
        return parsed.isoformat(), text
    return None


def _parse_guid(text: str) -> str | None:
    try:
        return str(uuid.UUID(text))
    except ValueError:
        return None


def interpret_value(raw: str, mode: str) -> ValueInterpretation:
    """모드별 변형값 생성 — exact는 원문, contains는 trim 원문, normalized는 표기 변형."""
    stripped = raw.strip()
    if mode == "contains":
        return ValueInterpretation(raw, (stripped,), (), (), (), ())

    if mode == "exact":
        number = _parse_number(stripped)
        ints = (int(number),) if number is not None and number == number.to_integral_value() else ()
        decimals = (_canon_decimal(number),) if number is not None else ()
        # _parse_date pads HH:MM to HH:MM:SS — without it, match_cell's 19-char
        # comparison against a seconds-bearing DB value fails / canonicalize, don't echo raw
        parsed = _parse_date(stripped) if _ISO_DATE_RE.match(stripped) else None
        dates = (parsed[0],) if parsed else ()
        guid = _parse_guid(stripped)
        return ValueInterpretation(raw, (raw,), ints, decimals, dates,
                                   (guid,) if guid else ())

    texts = [raw, stripped, stripped.upper(), stripped.lower()]
    compact = _COMPACT_NOISE_RE.sub("", stripped)
    if compact and compact != stripped:
        texts.append(compact)

    ints: tuple[int, ...] = ()
    decimals: tuple[str, ...] = ()
    number = _parse_number(_NUMBER_NOISE_RE.sub("", stripped))
    if number is not None:
        canonical = _canon_decimal(number)
        decimals = (canonical,)
        if number == number.to_integral_value():
            ints = (int(number),)
        texts.append(canonical)

    dates: tuple[str, ...] = ()
    parsed_date = _parse_date(stripped)
    if parsed_date is not None:
        iso, compact_ymd = parsed_date
        dates = (iso,)
        day = iso[:10]
        texts += [iso, compact_ymd, day.replace("-", "."), day.replace("-", "/")]

    guids: tuple[str, ...] = ()
    guid = _parse_guid(stripped)
    if guid is not None:
        guids = (guid,)
        texts += [guid, guid.upper()]

    return ValueInterpretation(
        raw, tuple(_dedupe(texts)[:PROBE_MAX_VARIANTS]), ints, decimals, dates, guids,
    )


def _sqlite_family(decl: str) -> str | None:
    # SQLite 타입 친화성 규칙(3.1절)을 따른다 — 날짜는 텍스트로 저장된다
    upper = decl.upper()
    if "INT" in upper:
        return FAMILY_INT
    if any(key in upper for key in ("CHAR", "CLOB", "TEXT", "DATE", "TIME")):
        return FAMILY_TEXT
    if "BLOB" in upper or upper == "":
        return None
    if any(key in upper for key in ("REAL", "FLOA", "DOUB", "NUM", "DEC")):
        return FAMILY_DECIMAL
    return None


def _base_type(data_type: str) -> str:
    return re.sub(r"\(.*\)", "", data_type).strip().lower()


def get_probe_family(engine: str, data_type: str) -> str | None:
    """엔진별 타입 패밀리 — None이면 값 검색 대상이 아니다."""
    base = _base_type(data_type)
    if engine == "sqlite":
        return _sqlite_family(base)
    table = _MSSQL_FAMILIES if engine == "mssql" else _POSTGRES_FAMILIES
    for family, names in table.items():
        if base in names:
            return family
    return None


def get_literal_kind(engine: str, data_type: str, family: str) -> str:
    """리터럴 렌더링 방식 — varchar에 N'…'을 붙이면 MSSQL이 인덱스를 버린다."""
    if family == FAMILY_TEXT:
        is_wide = engine == "mssql" and _base_type(data_type) in _MSSQL_WIDE
        return "text-wide" if is_wide else "text-narrow"
    if family in (FAMILY_INT, FAMILY_DECIMAL):
        return "number"
    return family


def _values_for(family: str, interp: ValueInterpretation) -> tuple[str | int, ...]:
    if family == FAMILY_TEXT:
        return interp.text
    if family == FAMILY_INT:
        return interp.ints
    if family == FAMILY_DECIMAL:
        return interp.decimals
    if family == FAMILY_DATE:
        return interp.dates
    return interp.guids


def _fit_text(values: tuple[str | int, ...], max_length: int, literal: str,
              engine: str) -> tuple[str | int, ...]:
    if max_length is None or max_length < 0:
        return values
    chars = max_length // 2 if (engine == "mssql" and literal == "text-wide") else max_length
    return tuple(v for v in values if len(str(v)) <= chars)


def select_candidate_columns(
    columns: list[ProbeCatalogColumn], interp: ValueInterpretation, engine: str,
    mode: str, min_distinct: int, blacklist: set[str],
) -> list[tuple[int, ProbeColumn]]:
    """카탈로그만으로 후보 컬럼을 고른다 — 여기서 떨어진 컬럼엔 쿼리가 나가지 않는다.

    저카디널리티 임계·블랙리스트는 scoring.check_exclusion과 같은 값을 쓰되 함수는
    재사용하지 않는다: 그 함수는 뷰·계산 컬럼을 거부하는데 값 검색은 둘 다 대상이다.
    """
    out: list[tuple[int, ProbeColumn]] = []
    for col in columns:
        if col.masking_policy:
            continue  # 마스킹된 값을 찾는 건 정책 우회 / masked values are never searched
        if col.has_direct_lineage:
            continue  # 베이스 테이블 프로브가 이미 커버 / the base-table probe covers it
        if col.name.upper() in blacklist:
            continue
        if col.distinct_count is not None and col.distinct_count < min_distinct:
            continue
        family = get_probe_family(engine, col.data_type)
        if family is None:
            continue
        literal = get_literal_kind(engine, col.data_type, family)
        if mode == "contains":
            if family != FAMILY_TEXT:
                continue
            out.append((col.object_id, ProbeColumn(col.name, family, literal,
                                                   (interp.text[0],), "contains")))
            continue
        values = _values_for(family, interp)
        if family == FAMILY_TEXT:
            values = _fit_text(values, col.max_length, literal, engine)
        if not values:
            continue
        out.append((col.object_id,
                    ProbeColumn(col.name, family, literal, tuple(values[:PROBE_MAX_VARIANTS]))))
    return out


def score_hint(hint: str | None, object_name: str, column_names: list[str]) -> int:
    """라벨 힌트와 컬럼명·객체명의 토큰 일치 점수 — 순서에만 쓰고 사실로 쓰지 않는다."""
    if not hint or not hint.strip():
        return 0
    tokens = {part for part in re.split(r"[^0-9A-Za-z가-힣]+", hint) if part}
    tokens.add(hint.strip())
    normalized = {normalize_name(token) for token in tokens}
    object_norm = normalize_name(object_name)
    score = 0
    for token in normalized:
        if not token:
            continue
        for column in column_names:
            column_norm = normalize_name(column)
            if column_norm == token:
                score = max(score, 3)
            elif token in column_norm or column_norm in token:
                score = max(score, 2)
        if token in object_norm:
            score = max(score, 1)
    return score


def estimate_rows(obj: ProbeCatalogObject) -> int | None:
    """테이블은 row_count, 뷰는 lineage 베이스의 최대값 — 뷰의 row_count는 항상 NULL이다."""
    if obj.object_type == "table":
        return obj.row_count
    known = [count for count in obj.base_row_counts if count is not None]
    return max(known) if known else None


def classify_heavy(obj: ProbeCatalogObject, est_rows: int | None, heavy_rows: int) -> str | None:
    if obj.object_type == "view" and obj.definition and _VIEW_HEAVY_RE.search(obj.definition):
        return "view_shape"
    if est_rows is None:
        return "unknown_rows"
    if est_rows > heavy_rows:
        return "rows"
    return None


def plan_targets(
    candidates: list[tuple[int, ProbeColumn]], objects: dict[int, ProbeCatalogObject],
    hint: str | None, heavy_rows: int, max_columns: int = PROBE_MAX_COLUMNS_PER_QUERY,
) -> list[PlannedTarget]:
    """객체별로 묶고 순위를 매긴다 — 테이블 먼저, 힌트 유사도, 작은 객체부터."""
    grouped: dict[int, list[ProbeColumn]] = {}
    for object_id, column in candidates:
        grouped.setdefault(object_id, []).append(column)

    scored = []
    for object_id, columns in grouped.items():
        obj = objects[object_id]
        est = estimate_rows(obj)
        reason = classify_heavy(obj, est, heavy_rows)
        name = obj.qname.split(".", 1)[1]
        scored.append((obj, columns, est, reason,
                       score_hint(hint, name, [c.name for c in columns])))
    scored.sort(key=lambda item: (
        0 if item[0].object_type == "table" else 1,
        -item[4],
        item[2] if item[2] is not None else float("inf"),
        item[0].qname,
    ))

    targets: list[PlannedTarget] = []
    rank = 0
    for obj, columns, est, reason, _ in scored:
        for start in range(0, len(columns), max_columns):
            rank += 1
            targets.append(PlannedTarget(
                object_id=obj.object_id, qname=obj.qname, object_type=obj.object_type,
                columns=tuple(columns[start:start + max_columns]),
                tier="heavy" if reason else "auto", heavy_reason=reason,
                est_rows=est, rank=rank,
            ))
    return targets


def _match_date(cell: str, values: tuple[str | int, ...]) -> str | None:
    normalized = cell.replace("T", " ")
    for value in values:
        text = str(value)
        if len(text) == 10:
            time_part = normalized[11:19]
            if normalized[:10] == text and time_part in ("", "00:00", "00:00:00"):
                return text
        elif normalized[:19] == text[:19]:
            return text
    return None


def match_cell(cell: object, column: ProbeColumn) -> str | None:
    """돌아온 셀이 이 컬럼의 변형값 중 어느 것과 같은지 — 없으면 None."""
    if cell is None:
        return None
    text = str(cell)
    if column.op == "contains":
        needle = str(column.values[0])
        return needle if needle.upper() in text.upper() else None
    if column.family == FAMILY_TEXT:
        stripped = text.strip()
        for value in column.values:
            if text == str(value) or stripped == str(value).strip():
                return str(value)
        return None
    if column.family in (FAMILY_INT, FAMILY_DECIMAL):
        try:
            actual = Decimal(text)
        except InvalidOperation:
            return None
        for value in column.values:
            try:
                if Decimal(str(value)) == actual:
                    return str(value)
            except InvalidOperation:
                continue
        return None
    if column.family == FAMILY_DATE:
        return _match_date(text, column.values)
    if column.family == FAMILY_GUID:
        for value in column.values:
            if text.lower() == str(value).lower():
                return str(value)
    return None


def match_columns(row: dict, columns: list[ProbeColumn]) -> list[MatchedColumn]:
    """프로브 행에서 실제로 맞은 컬럼만 — 이 행은 여기서 소비되고 밖으로 나가지 않는다."""
    matched: list[MatchedColumn] = []
    for column in columns:
        variant = match_cell(row.get(column.name), column)
        if variant is not None:
            matched.append(MatchedColumn(column.name, variant))
    return matched
