"""App settings loaded from environment. / 환경변수 기반 앱 설정."""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
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
    # 미리보기 허용 목록 수정용 비밀번호 — 값 데이터 노출 범위를 바꾸는 조작이라
    # 관리자 로그인과 별도로 한 번 더 막는다. 비어 있으면 수정 자체가 불가(503).
    preview_admin_password: str = ""

    # Environment: 컬럼을 감출 스키마 — 쉼표로 구분 (예: "MAP,STG"). 이름은 계속 조회되지만
    # 컬럼·조인 검증·ERD 노드가 전부 빠진다. 매핑 테이블처럼 구조는 알려도 되지만 컬럼 단위로
    # 파고들 필요가 없는 스키마용. 대소문자 무시 — 운영자가 케이스를 틀려도 열리면 안 된다.
    # / schemas whose columns are never exposed, comma-separated. Names stay searchable;
    # columns, join validation and ERD nodes are all withheld. Case-insensitive on purpose:
    # a casing typo must not silently fail open.
    hidden_schemas: str = ""

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
    # 상대 경로는 CWD가 아니라 저장소 루트 기준 — resolved_fixture_dir 참조
    fixture_dir: str = "fixtures"

    @property
    def resolved_fixture_dir(self) -> Path:
        """픽스처 디렉터리 절대 경로 / absolute fixture dir.

        상대 경로를 CWD로 풀면 실행 위치마다 다른 곳을 본다 — 픽스처 생성기는 저장소
        루트에 쓰는데(`python tools/fixture_gen.py --out fixtures`) 백엔드는 `backend/`
        에서 띄우므로(docs/ui-review.md) 조용히 빈 값 집합을 읽게 된다. .env와 같은
        앵커로 고정한다. 절대 경로는 그대로 통과 — 컨테이너 마운트 지점 지정용.
        """
        path = Path(self.fixture_dir)
        return path if path.is_absolute() else _REPO_ROOT_ENV.parent / path

    # Environment: n8n webhook 베이스 URL — 버튼 수집(W1a/b)과 live 검증·미리보기(W2) 공용
    # (예: http://182.199.63.71:5678/webhook). 비우면 해당 기능이 비활성.
    n8n_webhook_base: str = ""
    # Tuning: n8n 쿼리 응답 대기 상한(초) — W1 수집 쿼리·W2 검증 쿼리 공용
    n8n_query_timeout: int = 120

    # Environment: 사내 LLM OpenAI 호환 베이스 URL (예: http://<llm-host>:11434/v1).
    # 비우면 FakeAiClient — 로컬·CI는 오프라인 유지 / empty keeps the offline fake
    ai_base_url: str = ""
    # Environment: LLM 서버에 로드된 모델명 그대로 / model name as loaded on the server
    ai_model: str = ""
    # Environment: LLM API 키 — 비우면 Authorization 헤더 생략 (사내 무인증 서버 대응)
    ai_api_key: str = ""
    # Tuning: LLM 응답 대기 상한(초) — CPU 추론 대비 여유 / LLM response wait cap
    ai_timeout: int = 60
    # Tuning: LLM 재판정에 넘길 후보 페어 상한 — 프롬프트 크기·응답 시간 제어
    ai_suggest_max_pairs: int = 40

    # Environment: 임베딩 서버 — 채팅 LLM과 다른 호스트일 수 있어 별도 설정이다.
    # 변수명은 사내 다른 임베딩 사용 서비스(BPM 등)와 동일 — 그쪽 .env 값을 그대로 복사하면 된다.
    # URL은 `/v1` 루트·`/embeddings` 전체 경로 모두 허용. 비우면 임베딩 기능 비활성.
    # 사내 임베딩 서버는 무인증이라 토큰 설정이 없다 (AI_API_KEY는 채팅 전용).
    embed_url: str = ""
    embed_model: str = ""
    # Tuning: 임베딩 응답 대기 상한(초) — 채팅보다 짧다 (배치 호출·질의 경로 블로킹 방지)
    embed_timeout_seconds: int = 30
    # Tuning: 배치당 텍스트 수 / texts per embedding batch
    embed_batch: int = 32
    # Tuning: 인덱싱 잡 상한 — 사용자 부하 제약 (2000 초과 금지) / indexing job cap
    embed_job_cap: int = Field(1000, le=2000)
    # Tuning: 배치 간 대기(ms) — 사용자 요청 우선 / inter-batch sleep
    embed_sleep_ms: int = 500

    # Tuning: 수집 분할 (실측 2,342 테이블 대응 — 소스 DB 부하·전송 크기 관리)
    # W1a 창당 객체 수 — DB 조회·n8n 아이템·POST 크기를 함께 제한 / objects per catalog window
    collect_catalog_chunk_size: int = 300
    # W1b 호출당 뷰 수 — DMV 커서 배치 크기, 커지면 소스 DB 점유 시간 증가 / views per deps call
    collect_deps_chunk_size: int = 100

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
