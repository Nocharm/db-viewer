# db-viewer

MSSQL 시스템 카탈로그에서 스키마를 수집하고, 뷰를 역추적해 base table lineage를 복원하며, FK가 없는 관계를 온디맨드 검증으로 발견·기록해 ERD로 제공하는 도구.

- 대상 규모: 테이블 409개, 컬럼 약 9,000개
- 백엔드: Python / FastAPI
- 프론트엔드: TypeScript / Next.js

## 상태

Phase 1~5 **무연결(fixture) 구현 완료** — 카탈로그 수집/lineage/ERD, sqlglot 파싱, T2 검증·confidence·확정, T3 탐색 스캔, AI 제안까지 Fake 어댑터 기반으로 전 기능 동작. 남은 것은 연결 단계(정지점 16~18): 정찰 쿼리 실행 → replay 덤프 → `MssqlJoinValidator` + live 전환(사내 보안 승인 필요). 로드맵·결정 이력은 `docs/step0-proposal.md`와 `PROGRESS.md` 참고.

## 개발

```bash
# 백엔드
cd backend
uv venv .venv && uv pip install --python .venv/bin/python -r requirements-dev.txt
.venv/bin/python -m pytest tests -q          # 테스트
.venv/bin/ruff check app alembic tests       # 린트
.venv/bin/uvicorn app.main:app --port 8000   # 서버

# 프론트엔드 (백엔드 8000 포트로 프록시)
cd frontend
npm install && npm run dev                   # localhost:3000
npm test                                     # vitest 단위 테스트
```

서비스 DB는 PostgreSQL 16 (마이그레이션: `alembic upgrade head`). 로컬 설정은 `.env.example`를 `.env`로 복사.
픽스처로 시작하려면: `python tools/fixture_gen.py --out fixtures` 후 `catalog.json`·`view_deps.json`을 ingest API로 POST.

## 디렉터리

```
backend/       # FastAPI 백엔드
  app/models/  # 서비스 DB 스키마 (SQLAlchemy)
  alembic/     # 마이그레이션
  tests/
frontend/      # Next.js ERD 뷰어 (React Flow + ELK)
tools/         # fixture_gen.py — 합성 카탈로그 생성기 (회귀 자산)
               #   python tools/fixture_gen.py --out fixtures
n8n/sql/       # 정기 수집용 T-SQL (n8n W1 워크플로가 실행)
rules/         # 코딩·작업 규칙 (CLAUDE.md에서 import)
docs/          # 프로젝트 문서 (step0-proposal 등)
```
