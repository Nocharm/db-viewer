"""App settings loaded from environment. / 환경변수 기반 앱 설정."""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

# 로컬 개발은 레포 루트 .env, 컨테이너는 compose 주입 env 사용 (파일 없으면 무시됨)
# local dev reads repo-root .env; containers get env vars from compose (missing file is ignored)
_REPO_ROOT_ENV = Path(__file__).resolve().parents[2] / ".env"


class Settings(BaseSettings):
    """Runtime configuration — values from .env or process env. / 런타임 설정 — .env 또는 프로세스 환경변수."""

    model_config = SettingsConfigDict(env_file=str(_REPO_ROOT_ENV), extra="ignore")

    # Environment: 배포마다 다름 / differs per deployment
    database_url: str = "postgresql+psycopg://dbviewer@localhost:5432/dbviewer"

    # fixture: 합성 데이터 / replay: 실카탈로그 덤프 / live: 실DB 직결
    # live는 보안 승인 후 명시적으로만 켠다 (Phase 3 게이트) / live only after security approval
    source_mode: Literal["fixture", "replay", "live"] = "fixture"

    # 인증 (bpm 패턴) — false면 X-Dev-User 신뢰, 개발·테스트 전용 / auth flag pair with frontend
    auth_enabled: bool = False
    keycloak_issuer: str = "http://182.199.63.71:8080/realms/ai-portal"
    keycloak_audience: str = ""  # 빈 값이면 aud 검증 생략 (Keycloak 기본 aud=account)
    dev_user: str = "dev.user"
    # 시스템관리자 login_id 콤마 목록 — 화이트리스트 우회 + 관리 API 권한
    dbv_sysadmins: str = ""
    # n8n 등 머신 호출용 ingest 키 / machine-caller key for /api/ingest/*
    ingest_api_key: str = ""

    # LDAP (AD 동기화) — 4개가 모두 있어야 켜진다 / all four required to enable
    ldap_url: str = ""
    ldap_bind_dn: str = ""
    ldap_bind_credentials: str = ""
    ldap_user_search_base: str = ""
    ldap_start_tls: bool = False
    ldap_user_filter: str = "(&(objectCategory=person)(objectClass=user)(sAMAccountName=*))"
    # 사내 CA 번들 경로 — 비우면 시스템 신뢰 저장소 사용 (검증 자체는 항상 필수)
    ldap_ca_bundle: str = ""
    # 로그인 시 단건 동기화 스로틀(초) — /api/me로 AD를 두들기지 못하게 (보안 리뷰)
    ldap_sync_min_interval: int = 300

    def sysadmin_login_ids(self) -> set[str]:
        return {x.strip() for x in self.dbv_sysadmins.split(",") if x.strip()}

    @property
    def ldap_enabled(self) -> bool:
        return bool(self.ldap_url and self.ldap_bind_dn
                    and self.ldap_bind_credentials and self.ldap_user_search_base)

    # Tuning: lineage 재귀 상한 — 초과 시 depth_exceeded 플래그 (계획 §1.3)
    lineage_depth_limit: int = 10

    # Environment: FakeJoinValidator가 읽는 픽스처 디렉터리 / fixture dir for the fake validator
    fixture_dir: str = "fixtures"

    # Environment: n8n webhook 베이스 URL — 버튼 트리거 수집용 (예: http://182.199.63.71:5678/webhook)
    # 비우면 replay·live에서 수집 트리거가 503 / empty disables collect triggers outside fixture
    n8n_webhook_base: str = ""

    # Tuning: T3 탐색 스캔 (계획 §4) / exploratory scan tuning
    scan_max_concurrent: int = 2
    scan_full_recheck_top: int = 20   # 풀 재검증 상위 후보 수 / top-K full recheck
    scan_min_containment: float = 0.9  # 이 이상만 관계로 영구 기록 / persistence threshold
    scan_night_start_hour: int = 20
    scan_night_end_hour: int = 6

    # Tuning: 저카디널리티 검증 제외 임계 (계획 §3.3) / low-cardinality exclusion threshold
    low_cardinality_min_distinct: int = 50
    # Tuning: 공통 도메인 블랙리스트 — 이름 기반 콜드스타트 방어 (계획 §3.3)
    low_cardinality_blacklist: list[str] = [
        "USE_YN", "DEL_YN", "STATUS_CD", "TYPE_CD", "KIND_CD", "UNIT_CD",
    ]


@lru_cache
def get_settings() -> Settings:
    """Return cached settings instance. / 설정 싱글턴 반환."""
    return Settings()
