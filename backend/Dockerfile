# syntax=docker/dockerfile:1
FROM python:3.12-slim

# 프로덕션 의존성만 설치 / production deps only (docker.md)
WORKDIR /app
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-compile -r requirements.txt

COPY alembic.ini .
COPY alembic ./alembic
COPY app ./app

# non-root 실행 / run as non-root (docker.md)
RUN useradd --create-home appuser
USER appuser

# 환경 기본값은 폴백 — .env via docker-compose가 소스 오브 트루스 (config.md)
ENV SOURCE_MODE=fixture

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
