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

    # Tuning: lineage 재귀 상한 — 초과 시 depth_exceeded 플래그 (계획 §1.3)
    lineage_depth_limit: int = 10


@lru_cache
def get_settings() -> Settings:
    """Return cached settings instance. / 설정 싱글턴 반환."""
    return Settings()
