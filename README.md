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
픽스처로 시작하려면: `python tools/seed_fixtures.py --base <앱주소> --api-key <INGEST_API_KEY>`.

**UI/UX 로컬 리뷰**: `docs/ui-review.md` — Docker 없이 모든 시각 상태를 프라이밍(`tools/seed_ui_states.py`)해 확인.

## 배포

```bash
cp .env.example .env   # POSTGRES_PASSWORD 등 채우기
docker compose up -d --build
```

배포 전 로컬 리허설(로컬 Keycloak + 선택적 MSSQL/n8n 수집 리허설): `docs/local-test.md`

- **앱**: http://182.199.63.71:6678 — 단일 포트 (UI + `/api` 프록시, n8n도 이 주소로 POST)
- **n8n**: http://182.199.63.71:5678 — `n8n/workflows/*.json` 임포트
  - `w0_recon_queries.json` — 정찰 6종 (정지점 16). **[3] blocked > 0 이면 VIEW DEFINITION 권한부터 해결**
  - `w1_catalog_snapshot.json` — 정기 카탈로그 수집. env: `DB_VIEWER_API_BASE=http://182.199.63.71:6678`,
    `DB_VIEWER_INGEST_KEY` = 백엔드 `INGEST_API_KEY`와 동일 값
- Docker 네트워크: `172.48.0.0/16` (사내 대역 충돌 회피 요청값 — RFC1918 사설 대역 아님에 유의)

## 인증 (Keycloak + LDAP + 화이트리스트)

- **Keycloak**: realm `ai-portal` (http://182.199.63.71:8080/realms/ai-portal), public client
  `db-viewer-frontend` 등록 필요 — redirect URI `http://182.199.63.71:6678/*`,
  post-logout redirect `http://182.199.63.71:6678/login`
- **켜는 법**: `.env`에서 `AUTH_ENABLED=true` + `DBV_SYSADMINS=<본인 login_id>` + `INGEST_API_KEY` 설정 후
  `docker compose up -d --build` (NEXT_PUBLIC 값은 빌드 시 인라인 — 재빌드 필수)
- **화이트리스트**: 등록된 login_id만 로그인 가능(시스템관리자는 우회). `/admin` 화면 또는
  `/api/admin/whitelist`로 관리, 변경은 감사 로그에 기록
- **LDAP**: `LDAP_*` 4개 값을 모두 설정하면 활성화 — 로그인 시 단건 동기화 + `/admin`의 전체 동기화(5분 스로틀).
  제외 규칙(외부 조직·서비스 계정)은 `backend/app/ad/org.py`
- **개발 모드**: `AUTH_ENABLED=false`(기본)면 Keycloak 없이 동작 — `X-Dev-User` 헤더 신뢰 (bpm 패턴)

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
