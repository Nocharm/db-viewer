"""Hidden-schema policy. / 컬럼을 감출 스키마 판정.

`HIDDEN_SCHEMAS`(설정)에 든 스키마는 **이름만** 남는다: 목록·검색에는 계속 나오고 다른
테이블의 관계 목록에도 뜨지만, 컬럼과 컬럼에서 파생되는 것(조인 검증·후보 추천·미리보기·
ERD 노드)은 전부 빠진다. 미리보기 허용 목록(`preview_policy`)과는 축이 다르다 — 그쪽은
"실제 값"을, 이쪽은 "구조(컬럼)"를 통제한다.
"""

from app.config import get_settings


def get_hidden_schemas() -> set[str]:
    """설정값을 정규화해 반환 — 비교는 항상 이 집합으로 한다 (소문자)."""
    raw = get_settings().hidden_schemas
    return {part.strip().lower() for part in raw.split(",") if part.strip()}


def is_schema_hidden(schema: str) -> bool:
    return schema.lower() in get_hidden_schemas()
