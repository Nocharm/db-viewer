# 로컬 리허설 가이드

서버(182.199.63.71) 배포 전, **같은 compose 스택 + 실제 Keycloak 로그인 흐름**을 로컬에서 검증한다.
서버와의 차이는 두 가지뿐: Keycloak을 로컬 컨테이너로 대체, LDAP은 끔(아래 참고).

## 0. 사전 준비 (1회)

- Docker Desktop 실행 (Apple Silicon이면 Settings → *Use Rosetta for x86_64 emulation* 켜기 — MSSQL 프로파일용)
- `/etc/hosts`에 한 줄 추가 — 브라우저와 백엔드 컨테이너가 같은 Keycloak issuer URL을 쓰기 위함:

```bash
echo "127.0.0.1 keycloak.local" | sudo tee -a /etc/hosts
```

## 1. 기동

```bash
cp .env.local.example .env.local
docker compose --env-file .env.local -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

| 서비스 | 주소 | 계정 |
|---|---|---|
| 앱 (UI + API) | http://localhost:6678 | Keycloak 로그인 |
| Keycloak | http://keycloak.local:8080 | 콘솔 admin / admin |
| Keycloak 테스트 유저 | — | `admin.sys` / `admin` (시스템관리자), `hong.gil` / `test` |

realm `ai-portal`·클라이언트 `db-viewer-frontend`·테스트 유저 2명은
`deploy/local/keycloak/ai-portal-realm.json`에서 자동 임포트된다.

## 2. 인증·화이트리스트 리허설 시나리오

1. http://localhost:6678 접속 → Keycloak 로그인 화면으로 리다이렉트
2. **hong.gil / test** 로그인 → "접근 권한이 없습니다" 차단 화면 (화이트리스트 미등록)
3. 로그아웃 → **admin.sys / admin** 로그인 (DBV_SYSADMINS라 화이트리스트 우회) → `/admin`에서 `hong.gil` 추가
4. 다시 hong.gil 로그인 → 정상 접근. `/admin`은 403 안내 확인
5. 감사 확인: whitelist_add·login 기록이 audit_logs에 쌓임

## 3. 데이터 넣기 (둘 중 하나)

**A. 픽스처 (MSSQL 불필요·기본)**

```bash
python3 tools/seed_fixtures.py --base http://localhost:6678 --api-key local-ingest-key
```

**B. 수집 리허설 (W0/W1 — MSSQL + n8n)**

```bash
docker compose --env-file .env.local -f docker-compose.yml -f docker-compose.local.yml --profile collect up -d --build
```

1. http://localhost:5678 (n8n) 접속 → 초기 계정 생성
2. Credentials → *Microsoft SQL* 추가: host `mssql`, port `1433`, db `LOCALTEST`, user `sa`,
   password = `.env.local`의 `MSSQL_SA_PASSWORD`, TLS off
3. `n8n/workflows/w0_recon_queries.json` 임포트 → 실행 → `Recon report` 결과 확인
   (시드 스키마 기준: FK 2, 테이블 4/뷰 2, blocked 0, view_on_view 1)
4. `n8n/workflows/w1_catalog_snapshot.json` 임포트 → 각 MSSQL 노드에 credential 지정 → 실행
   → 앱에서 `T_ORDER` 검색해 ERD 확인 (env는 compose가 주입: `DB_VIEWER_API_BASE=http://frontend:3000`,
   `DB_VIEWER_INGEST_KEY`)
5. T2 리허설: `T_ORDER_LOG.ORDER_ID` 컬럼 후보에서 `T_ORDER.ORDER_ID` 검증
   — 단, fixture 모드 검증기는 픽스처 값 집합 기준이므로 실데이터 검증은 연결 단계(MssqlJoinValidator) 이후

## 4. 서버와 다른 점

| 항목 | 로컬 | 서버 |
|---|---|---|
| Keycloak | 로컬 컨테이너 (`keycloak.local:8080`, realm 자동 임포트) | 182.199.63.71:8080 (기존 realm) |
| LDAP | **끔** — AD 전용 속성(sAMAccountName·userAccountControl)이라 OpenLDAP으로 대체 불가. 꺼지면 동기화만 비활성(정상 동작). 동기화 검증은 단위 테스트(tests/test_auth.py)가 담당 | 사내 AD |
| PKCE | HTTP라 자동 비활성 (`!window.isSecureContext`) — 서버와 동일 조건 | 동일 (HTTPS 전환 시 자동 활성) |
| 주소 | localhost:6678 | 182.199.63.71:6678 |

## 5. 정리

```bash
docker compose --env-file .env.local -f docker-compose.yml -f docker-compose.local.yml --profile collect down -v
```

`/etc/hosts`의 `keycloak.local` 줄은 남겨도 무해.
