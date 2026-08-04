"""LLM adapter tests with mocked HTTP. / 사내 LLM 어댑터 테스트 (HTTP 목킹)."""

from app.config import Settings


def test_ai_settings_defaults():
    s = Settings(_env_file=None)  # 개발자 로컬 .env 간섭 차단
    assert s.ai_base_url == ""
    assert s.ai_model == ""
    assert s.ai_api_key == ""
    assert s.ai_timeout == 60
    assert s.ai_suggest_max_pairs == 40
