"""Pure payload→row mapping for ingest. / ingest 페이로드→서비스 행 매핑 (순수 로직)."""

from app.schemas.ingest import CatalogPayload, RawColumn, RawKeyConstraint


class MappingError(ValueError):
    """Payload references an unknown object/column. / 페이로드가 모르는 객체·컬럼 참조."""

    def __init__(self, message: str, context: dict):
        super().__init__(message)
        self.context = context


def build_pk_index(key_constraints: list[RawKeyConstraint]) -> set[tuple[int, str]]:
    """PK 소속 (object_id, column) 집합 / set of PK-membership pairs."""
    return {
        (kc.object_id, col)
        for kc in key_constraints
        if kc.type == "pk"
        for col in kc.columns
    }


def build_object_rows(snapshot_id: int, payload: CatalogPayload) -> list[dict]:
    return [
        {
            "snapshot_id": snapshot_id, "schema": o.schema_name, "name": o.name,
            "type": o.type, "object_id": o.object_id, "row_count": o.row_count,
        }
        for o in payload.objects
    ]


def build_column_rows(
    columns: list[RawColumn],
    pk_index: set[tuple[int, str]],
    object_id_map: dict[int, int],
) -> list[dict]:
    """raw object_id를 서비스 id로 치환하고 is_pk를 파생 / map ids and derive is_pk."""
    rows = []
    for c in columns:
        if c.object_id not in object_id_map:
            raise MappingError(
                "column references unknown object",
                {"object_id": c.object_id, "column": c.name},
            )
        rows.append({
            "object_id": object_id_map[c.object_id], "name": c.name, "ordinal": c.ordinal,
            "data_type": c.data_type, "max_length": c.max_length,
            "is_nullable": c.is_nullable, "is_pk": (c.object_id, c.name) in pk_index,
            "is_computed": c.is_computed,
        })
    return rows
