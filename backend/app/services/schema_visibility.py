"""Hidden-schema policy. / 컬럼을 감출 스키마 판정.

`HIDDEN_SCHEMAS`(설정)에 든 스키마는 **이름만** 남는다: 목록·검색에는 계속 나오고 다른
테이블의 관계 목록에도 뜨지만, 컬럼과 컬럼에서 파생되는 것(조인 검증·후보 추천·미리보기·
ERD 노드)은 전부 빠진다. 미리보기 허용 목록(`preview_policy`)과는 축이 다르다 — 그쪽은
"실제 값"을, 이쪽은 "구조(컬럼)"를 통제한다.
"""

from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import FLAG_RENDER_HIDDEN_SCHEMAS, AppFlag

# 플래그 행이 없을 때의 기본값 — 안 그린다. 감추라고 설정한 스키마가 배포 직후
# 목록에 보이면 설정이 안 먹은 것처럼 읽힌다.
# / default when the row is absent: don't render. A schema configured as hidden showing up
#   in the rail right after deploy reads as "the setting didn't take".
RENDER_HIDDEN_SCHEMAS_DEFAULT = False


def get_hidden_schemas() -> set[str]:
    """설정값을 정규화해 반환 — 비교는 항상 이 집합으로 한다 (소문자)."""
    raw = get_settings().hidden_schemas
    return {part.strip().lower() for part in raw.split(",") if part.strip()}


def is_schema_hidden(schema: str) -> bool:
    return schema.lower() in get_hidden_schemas()


def should_render_hidden_schemas(db: Session) -> bool:
    """감춘 스키마를 좌측 목록·테이블 목록에 그릴지 — 관리 콘솔 토글.

    컬럼을 감추는 정책 자체와는 무관하다: 켜도 컬럼은 여전히 안 나가고 진입도 막힌다.
    이 값은 "존재를 목록에 노출할지"만 정한다.
    / independent of the column policy: turning this on still withholds columns and blocks
      navigation — it only decides whether the name appears in the rails at all.
    """
    row = db.get(AppFlag, FLAG_RENDER_HIDDEN_SCHEMAS)
    return RENDER_HIDDEN_SCHEMAS_DEFAULT if row is None else row.value
