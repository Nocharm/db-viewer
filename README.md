# db-viewer

MSSQL 시스템 카탈로그에서 스키마를 수집하고, 뷰를 역추적해 base table lineage를 복원하며, FK가 없는 관계를 온디맨드 검증으로 발견·기록해 ERD로 제공하는 도구.

- 대상 규모(정찰 실측): 테이블 2,342개, 뷰 882개, FK 13개
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
실DB 연결(정찰 → 수집 → live 전환) 순서와 체크리스트: **`docs/connect.md`**

- **앱**: http://182.199.63.71:6678 — 단일 포트 (UI + `/api` 프록시, n8n도 이 주소로 POST)
- **n8n**: http://182.199.63.71:5678 — `n8n/workflows/*.json` 임포트 (한 세트가 로컬·실서버 겸용:
  `$env` 있으면 그 값, 없으면 리터럴 폴백 — 절차: `n8n/workflows/README.md`)
  - `w0_recon_queries.json` — 정찰 6종 (정지점 16). **[3] blocked > 0 이면 VIEW DEFINITION 권한부터 해결**
- Docker 네트워크: `172.48.0.0/16` (사내 대역 충돌 회피 요청값 — RFC1918 사설 대역 아님에 유의)

## 인증 (Keycloak + LDAP + 화이트리스트)

- **Keycloak**: realm `ai-portal` (http://182.199.63.71:8080/realms/ai-portal), public client
  `db-viewer-frontend` 등록 필요 — redirect URI `http://182.199.63.71:6678/*`,
  post-logout redirect `http://182.199.63.71:6678/login`,
  **Web origins `http://182.199.63.71:6678`** (token 교환 CORS는 redirect URI가 아니라 Web origins가 푼다 — bpm 운영 레슨)
- **Keycloak federation과 백엔드 LDAP bind는 별개 계정** — 로그인·토큰은 realm의 AD federation이,
  `employees` 동기화는 우리 `LDAP_BIND_DN` 서비스 계정(읽기 전용)이 담당. 인프라 담당과 각각 확인
- **토큰 매퍼**: `preferred_username`이 AD `sAMAccountName`이어야 화이트리스트·사용자 매칭이 동작
  (Keycloak LDAP federation 기본 매핑이면 OK)
- **켜는 법**: `.env`에서 `AUTH_ENABLED=true` + `DBV_SYSADMINS=<본인 login_id>` + `INGEST_API_KEY` 설정 후
  `docker compose up -d --build` (NEXT_PUBLIC 값은 빌드 시 인라인 — 재빌드 필수)
- **화이트리스트**: 등록된 login_id만 로그인 가능(시스템관리자는 우회). `/admin` 화면 또는
  `/api/admin/whitelist`로 관리, 변경은 감사 로그에 기록
- **LDAP**: `LDAP_*` 4개 값을 모두 설정하면 활성화 — 로그인 시 단건 동기화 + `/admin`의 전체 동기화(5분 스로틀).
  제외 규칙(외부 조직·서비스 계정)은 `backend/app/ad/org.py`
- **개발 모드**: `AUTH_ENABLED=false`(기본)면 Keycloak 없이 동작 — `X-Dev-User` 헤더 신뢰 (bpm 패턴)
- **미리보기 허용 목록**: 실제 값이 화면에 나가는 경로(테이블 미리보기·조인 샘플)는 **기본 전부 차단**이고,
  `/admin` → *미리보기 허용 스키마*에 등록된 **스키마의 객체 전부**가 열린다. 목록 **수정**은 `PREVIEW_ADMIN_PASSWORD`
  (`.env`) 입력을 추가로 요구하며, 값이 비어 있으면 수정 자체가 막힌다(503). 추가·삭제는 감사 로그에 기록
- **컬럼 비공개 스키마**: `HIDDEN_SCHEMAS`(`.env`, 쉼표 구분·대소문자 무시)에 넣은 스키마는 **이름만 남는다** —
  목록·검색과 다른 테이블의 관계에는 계속 나오지만 컬럼·조인 검증·미리보기·ERD 노드가 전부 빠지고,
  화면에서 그 테이블로 타고 들어갈 수 없다. 미리보기 허용 목록과 **독립**이며(허용돼 있어도 감춤이 이긴다),
  값이 아니라 **구조(컬럼)**를 통제한다는 점이 다르다
- ⚠ **첫 AD 전체 동기화 주의**: 프룬이 스테일 `source=ad` 행을 대량 삭제할 수 있다(퇴사자·비활성).
  local 소스 행은 보존되지만, 운영 데이터가 쌓인 뒤라면 실행 전 사용자 목록 백업 권장 (bpm 운영 레슨)

## 배포 검증·트러블슈팅 (bpm 운영 레슨 이식)

```bash
docker compose ps                                   # 서비스 Up, backend healthy
curl -s http://182.199.63.71:6678/api/health        # {"status":"ok"} — 인증 면제
```

| 증상 | 확인 |
|---|---|
| 로그인 후 redirect 오류 | Keycloak Valid redirect URIs에 `:6678/*` 등록 여부 |
| 복귀 시 `failed to fetch` / `No matching state found` | **Web origins** 누락 — token 엔드포인트 CORS |
| 프론트가 인증을 안 함 | `NEXT_PUBLIC_*`는 빌드 인라인 — `.env` 변경 후 `--build` 했는지 |
| `/api/*` 401 | 토큰 만료 / `KEYCLOAK_ISSUER`가 realm URL과 정확히 일치하는지 |
| 로그인 버튼 무반응 | 콘솔에 `crypto.subtle...secure contexts` — 평문 HTTP는 PKCE 자동 비활성이 정상. Keycloak이 S256 강제면 해제 |
| "로컬은 되는데 서버만" 깨짐 | secure context 차이 — `localhost`는 secure라 재현 불가. **LAN IP(`http://<내IP>:3000`)로 접속해 재현**할 것 |
| 고쳤는데 서버에서 같은 에러 | 이미지 재빌드·해시 청크명 변경 여부 확인 → `docker compose build --no-cache frontend` |
| 특정 사용자가 동기화에서 빠짐 | 의도된 제외 규칙(`ad/org.py`): loginId에 `.` 없음 / 이름에 `_` / 제외 조직 |
| 전체 동기화 503 | `LDAP_*` 4종 중 빈 값 |
| 미리보기 버튼이 잠김 / 403 | `/admin` → 미리보기 허용 스키마에 그 객체의 **스키마**가 있는지 (기본은 전부 차단). 그래도 막히면 `HIDDEN_SCHEMAS`에 잡혀 있는지 확인 — 감춤이 허용보다 우선한다 |
| 허용 목록 수정이 503 | `PREVIEW_ADMIN_PASSWORD` 미설정 — `.env` 채우고 backend 재기동 |
| 미리보기가 빈 표 | 화면 문구로 구분: "원본 소스가 0행" = W2 실행됨(테이블이 비었거나 필터 불일치). 그 외엔 502 메시지에 n8n 상태·본문이 실린다 |

**롤백**: `git checkout <이전 커밋> && docker compose up -d --build` — 데이터는 `pgdata` 볼륨에 유지.
`docker compose down -v`는 볼륨까지 삭제(주의).

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
