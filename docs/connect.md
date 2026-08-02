# 연결 단계 런북 (정지점 16 → 18)

실DB(MSSQL) 연결은 아래 순서대로 진행한다. **코드는 모두 준비되어 있고, 이 문서의 작업은
전부 설정·임포트·확인이다.** live 전환(3단계)만 보안 승인 후 수행한다.

실행 경로 결정: T2 검증·미리보기의 live 실행은 **n8n W2 워크플로 경유**로 확정
(계획 §4.3의 pyodbc 직결 대신 — 사용자 방침). DB 자격증명은 n8n에만 존재하고,
백엔드는 kind + 식별자 파라미터만 보낸다. 동적 SQL 문자열은 어디서도 오가지 않는다.

---

## 0. 사전 준비 (한 번)

| 항목 | 값/작업 |
|---|---|
| 배포 | `docker-compose up -d --build` → http://182.199.63.71:6678 |
| Keycloak | 클라이언트 `db-viewer-frontend` 등록 — redirect `http://182.199.63.71:6678/*`, post-logout `/login`, **Web origins `http://182.199.63.71:6678`** (누락 시 로그인 복귀 실패 — README 트러블슈팅) |
| `.env` | `AUTH_ENABLED=true`, `DBV_SYSADMINS`, `INGEST_API_KEY`, `LDAP_*` 4종(+`LDAP_CA_BUNDLE`), `N8N_WEBHOOK_BASE=http://182.199.63.71:5678/webhook` |
| n8n 환경변수 | `DB_VIEWER_API_BASE=http://182.199.63.71:6678`, `DB_VIEWER_INGEST_KEY`(백엔드 `INGEST_API_KEY`와 동일), `DB_VIEWER_SOURCE_DB` |
| n8n credential | MSSQL **읽기 전용 계정** 1개 — 모든 워크플로가 공유. `VIEW DEFINITION` 권한 필요 (정찰이 확인해 줌) |

## 1. 정찰 — 정지점 16 (연결 없음 → 읽기만)

1. n8n에 `n8n/workflows/w0_recon_queries.json` 임포트, MSSQL credential 지정.
2. 수동 실행 → 마지막 "Recon report" 노드 출력 확인:
   - `view_definition_permission.blocked > 0` → **VIEW DEFINITION 권한부터 해결** (최우선 — 뷰 역추적의 원천).
   - `warnings` 배열의 DMV 실패 여부, FK 수, 크로스 DB 참조, 중첩 깊이.
3. 리포트를 보고 진행 판단 (사람 결정 — 정지점).

## 2. 실 카탈로그 수집 — 정지점 17 (여전히 live 아님)

1. `n8n/workflows/w1_catalog_snapshot.json`(주기) + `w1a_collect_catalog.json` +
   `w1b_collect_viewdeps.json`(버튼 수집) 임포트, credential 지정, W1a/W1b **활성화**(webhook은 활성 상태에서만 응답).
2. 관리 콘솔 → 카탈로그 수집 → **1단계 → 2단계** (또는 전체 실행). 진행 스테퍼로 확인.
3. 확인 지점: `/parsing` 성공률(실 뷰 SQL 기준), 브라우저·ERD가 실 스키마로 동작.
   - 이 시점 미리보기는 **합성 데이터**(fixture 실행기), T2 검증은 "값 데이터 없음"이 정상.

## 3. live 전환 — 정지점 18 (보안 승인 후에만)

1. `n8n/workflows/w2_query_executor.json` 임포트, credential 지정, **활성화**.
2. 승인 확인 후 `.env`의 `SOURCE_MODE=live` → 백엔드 재기동.
   - 게이트: `N8N_WEBHOOK_BASE` 없이 live를 켜면 기동 시가 아니라 검증·미리보기 호출 시 명시적 오류.
3. 확인 지점:
   - 미리보기 → 실데이터 TOP N (필터 재조회 = 실 WHERE LIKE).
   - ERD 검증 패널 → T2 실행 → 실 containment (LEFT JOIN 집계).
   - 감사 로그(`audit_logs`)에 preview 기록 축적.

## 부하·안전 장치 (이미 코드에 있음)

- T2는 후보 축소 뒤 **페어 단위 핀포인트**만 질의 — 일괄 검증도 타깃 상한 8.
- 미리보기 상한 500 서버 고정, W2 안에서도 limit 1~500 클램프.
- W2는 kind 3종의 고정 템플릿만 실행 — 식별자 브래킷·리터럴 이스케이프, 그 외 kind 거부.
- 대형 테이블 containment 대비 `N8N_QUERY_TIMEOUT`(기본 120초) 조정 가능.

## 남은 결정 (연결 후)

- AI 실 프로바이더 교체 (현재 결정론적 목업 — 어댑터 `create_ai_client` 한 곳).
- T3 탐색 스캔의 야간 운용 정책 (동시 2개 제한은 기본 적용됨).
