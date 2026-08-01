"""Pure AD mapping rules — no DB, no LDAP. / AD 매핑 순수 함수 (bpm 규칙 이식).

전부 순수 함수라 단위 테스트가 전체를 커버한다. 제외 규칙이 사실상의 1차
유저 필터이고, 로그인 허용은 별도 화이트리스트 게이트가 담당한다.
"""

import re
from dataclasses import dataclass

# 조직 트리 노이즈 토큰 / noise tokens dropped from the OU path (bpm 동일)
EXCLUDED_OU_TOKENS = frozenset({
    "BioLogics Users", "BioLogics Groups", "SAMSUNGBIOLOGICS", "President & CEO",
})
# 동기화 제외 최상위 조직 / org roots excluded from sync (bpm 동일)
EXCLUDED_ORG_L1 = frozenset({
    "Partners", "Partner", "External users", "External Users",
    "Application Users", "HR", "Service", "delete", "Client", "TEST", "View",
})

ACCOUNT_DISABLE_FLAG = 0x2  # AD userAccountControl ACCOUNTDISABLE 비트


@dataclass(frozen=True)
class RawUser:
    login_id: str
    name: str
    title: str | None
    dn: str
    uac: int | None
    email: str | None


def parse_org_levels(dn: str) -> list[str]:
    """DN의 OU들을 root→leaf 순으로 추출 / OU values root-to-leaf, noise dropped."""
    parts = re.split(r"(?<!\\),", dn)  # 이스케이프된 콤마 존중 / respect escaped commas
    levels = []
    for part in parts:
        part = part.strip()
        if part.upper().startswith("OU="):
            value = part[3:].replace("\\,", ",")
            if value not in EXCLUDED_OU_TOKENS:
                levels.append(value)
    levels.reverse()
    return levels[:5]


def is_active(uac: int | None) -> bool:
    if uac is None:
        return True  # 속성 없으면 보수적으로 활성 취급 / conservative default
    return not bool(uac & ACCOUNT_DISABLE_FLAG)


def is_excluded(org_l1: str | None, login_id: str, name: str) -> bool:
    """동기화 제외 — 서비스 계정·외부 조직 (bpm 규칙). / sync-time exclusion rules."""
    if org_l1 in EXCLUDED_ORG_L1:
        return True
    if "." not in login_id:
        return True  # 실제 사람 계정은 firstname.lastname 규약
    if "_" in name:
        return True  # 서비스/시스템 계정 네이밍
    return False


def to_user_fields(raw: RawUser, sysadmin_ids: set[str]) -> dict | None:
    """RawUser → app_users 필드. 제외 대상이면 None. / mapped fields or None if excluded."""
    levels = parse_org_levels(raw.dn)
    org_l1 = levels[0] if levels else None
    if is_excluded(org_l1, raw.login_id, raw.name):
        return None
    return {
        "login_id": raw.login_id,
        "name": raw.name,
        "title": raw.title,
        "department": levels[-1] if levels else None,  # 최심 조직 / deepest org level
        "org_path": "/".join(levels) if levels else None,
        "email": raw.email,
        "active": is_active(raw.uac),
        "source": "ad",
        "role": "admin" if raw.login_id in sysadmin_ids else "user",
    }
