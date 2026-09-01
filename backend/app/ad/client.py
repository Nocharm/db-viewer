"""Blocking LDAP I/O. / LDAP 접속·조회 (bpm 패턴 — 동기 엔드포인트라 threadpool 위임 불필요)."""

import ssl

from ldap3 import Connection, Server, Tls

from app.ad.org import RawUser
from app.config import get_settings

_ATTRIBUTES = [
    "sAMAccountName", "displayName", "title",
    "distinguishedName", "userAccountControl", "mail",
]


def _make_tls() -> Tls:
    # 인증서 검증 필수 — ldap3 기본값(CERT_NONE)은 MITM에 무방비 (보안 리뷰 반영)
    # certificate validation is mandatory; ldap3's default is CERT_NONE
    ca_bundle = get_settings().ldap_ca_bundle or None
    return Tls(validate=ssl.CERT_REQUIRED, ca_certs_file=ca_bundle)


def _connect() -> Connection:
    settings = get_settings()
    use_ssl = settings.ldap_url.lower().startswith("ldaps://")
    needs_tls = use_ssl or settings.ldap_start_tls
    server = Server(
        settings.ldap_url, use_ssl=use_ssl, tls=_make_tls() if needs_tls else None
    )
    conn = Connection(
        server, user=settings.ldap_bind_dn,
        password=settings.ldap_bind_credentials, auto_bind=False,
    )
    if settings.ldap_start_tls:
        conn.start_tls()
    conn.bind()
    return conn


def escape_filter_value(value: str) -> str:
    """RFC 4515 필터 이스케이프 — 백슬래시 먼저 / LDAP filter escaping, backslash first."""
    return (
        value.replace("\\", "\\5c")
        .replace("*", "\\2a")
        .replace("(", "\\28")
        .replace(")", "\\29")
        .replace("\x00", "\\00")
    )


def _to_raw(entry) -> RawUser:
    attrs = entry["attributes"]

    def one(name: str) -> str | None:
        value = attrs.get(name)
        if isinstance(value, list):
            value = value[0] if value else None
        return str(value) if value not in (None, "") else None

    uac = attrs.get("userAccountControl")
    return RawUser(
        login_id=one("sAMAccountName") or "",
        name=one("displayName") or one("sAMAccountName") or "",
        title=one("title"),
        dn=one("distinguishedName") or "",
        uac=int(uac) if uac not in (None, "") else None,
        email=one("mail"),
    )


def fetch_user(login_id: str) -> RawUser | None:
    safe = escape_filter_value(login_id)
    settings = get_settings()
    conn = _connect()
    try:
        conn.search(
            settings.ldap_user_search_base,
            f"(&(objectCategory=person)(objectClass=user)(sAMAccountName={safe}))",
            attributes=_ATTRIBUTES,
        )
        entries = [e for e in conn.response or [] if e.get("type") == "searchResEntry"]
        return _to_raw(entries[0]) if entries else None
    finally:
        conn.unbind()


def fetch_all_users() -> list[RawUser]:
    settings = get_settings()
    conn = _connect()
    try:
        entries = conn.extend.standard.paged_search(
            settings.ldap_user_search_base,
            settings.ldap_user_filter,
            attributes=_ATTRIBUTES,
            paged_size=500,
            generator=False,
        )
        return [
            _to_raw(e) for e in entries or [] if e.get("type") == "searchResEntry"
        ]
    finally:
        conn.unbind()


def verify_credentials(dn: str, password: str) -> bool:
    """사용자 DN으로 바인드해 자격증명을 확인 / bind as the user to verify credentials.

    `_connect()`는 서비스 계정으로 붙지만 여기서는 **사용자 자신으로** 붙는다 — 바인드 성공
    여부가 곧 인증 결과다.

    빈 비밀번호를 바인드 전에 거부하는 이유(RFC 4513): DN은 주고 비밀번호를 비운 바인드를
    다수의 서버가 **익명 바인드로 처리해 성공을 돌려준다**. 그대로 믿으면 비밀번호를
    비워두는 것만으로 아무 계정이나 로그인된다.

    접속 자체가 안 되는 경우(LDAPException)는 여기서 삼키지 않는다 — 호출부가 자격증명
    실패(401)와 인증 서버 장애(503)를 구분해야 하기 때문이다.
    """
    if not password:
        return False
    settings = get_settings()
    use_ssl = settings.ldap_url.lower().startswith("ldaps://")
    needs_tls = use_ssl or settings.ldap_start_tls
    server = Server(
        settings.ldap_url, use_ssl=use_ssl, tls=_make_tls() if needs_tls else None
    )
    conn = Connection(server, user=dn, password=password, auto_bind=False)
    try:
        if settings.ldap_start_tls:
            conn.start_tls()
        return bool(conn.bind())
    finally:
        conn.unbind()
