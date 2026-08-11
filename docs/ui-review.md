# UI/UX 로컬 리뷰 가이드

목적: **프론트 UI/UX만** 로컬에서 확인한다. 통신이 필요한 기능(Keycloak 로그인·차단 화면,
LDAP 동기화, n8n 수집, 실DB 검증)은 서버 배포 후 검증 — 마지막 절 참조.
Docker 불필요, 픽스처 데이터로 모든 시각 상태를 만든다.

## 1. 실행

```bash
# 백엔드 (SQLite — 로컬 UI 리뷰엔 Postgres 불필요)
cd backend
DATABASE_URL=sqlite:////tmp/dbviewer-ui.db .venv/bin/alembic upgrade head
DATABASE_URL=sqlite:////tmp/dbviewer-ui.db .venv/bin/uvicorn app.main:app --port 8000
# 프론트 (새 터미널)
cd frontend && npm run dev
# 상태 프라이밍 (새 터미널, 저장소 루트)
python3 tools/seed_ui_states.py --base http://localhost:8000
```

→ http://localhost:3000 (auth OFF 개발 모드 — 로그인 없이 진입, 사용자 `dev.user`)

첫 화면은 **빈 캔버스 + 시작 가이드**가 정상이다(앵커 방식 — 전체 스키마를 그리지 않음).
가이드의 예시 칩(HR_EMP 등)을 누르면 바로 열리고, 선택 시 앵커 노드 중심으로 자동 줌된다.

시드가 만드는 상태: 확정 관계 1건(✓), inferred 3건(관측 횟수·고아 다양화),
AI 제안 엣지(상한 `AI_SUGGEST_MAX_PAIRS`, 기본 40건까지), AI 요약 2건, 화이트리스트 2명.
더미데이터는 제조 ERP 유사 네이밍(HR_EMP·ORD_SO_HDR·MES_BATCH_HDR·QC_SAMPLE_RSLT 류).

## 2. 체크리스트 (픽스처 seed 42 기준 — 검색어 그대로 사용)

메인(/)은 **테이블 브라우저**, ERD 캔버스는 `/erd` (헤더 내비로 이동).

| # | 확인 대상 | 방법 |
|---|---|---|
| 0a | **테이블 브라우저 전체 플로우** | 메인(/) — 상단 조인키 칩(EMP_NO 등)으로 필터 → 좌측 카테고리(생산·품질…) → 테이블 선택 → 우측 상세(사용 뷰·유사 테이블 일치율 게이지·FK·관계) |
| 0b | **미리보기 TOP 20 + 어드밴스드 필터** | 상세에서 [미리보기 TOP 20] → 하단 별도 섹션으로 자동 스크롤(페이지 세로 스크롤 생김). 필터 바에서 컬럼+연산자(부분/정확/제외/NULL)+값으로 [필터 추가] — 조건은 AND 결합 칩으로 쌓이고(최대 5), 칩 ×로 개별 제거·[필터 해제]로 전체 해제. 셀 더블클릭 = 그 값 eq 필터. [SQL로 보기]에 WHERE … AND …가 그대로 반영 |
| 0b′ | **강화 검색** | 테이블 목록 검색창 — 컬럼명 검색(`JUDGE` → QC 테이블들, 매칭 컬럼 하이라이트), 초성(`ㅍㅈ` → 품질), 카테고리(`품질`), 하이라이트 표시 |
| 0c | **ERD 딥링크** | 상세에서 [ERD 보기 →] → `/erd`로 이동, 해당 테이블이 앵커로 포커스 |
| 0d | **디자인 공통** | 스크롤바는 호버 시에만 표시, 클릭·호버 효과(ease-in-out), 프레임 overflow hidden |
| 1 | **엣지 4종 총집합** (fk 실선 13·lineage 점선 5·✓ confirmed 1·AI 파선 21, 26노드) | `HR_EMP` 검색 — 히어로 화면 |
| 2 | **✓ confirmed만 좁게** | `HR_SALARY` 검색 (4노드) — EMP_NO → HR_EMP 확정 |
| 3 | **inferred 파선(투명도 0.45단)** | `T_ORG_DUTY` 검색. ※ 투명도 0.7/1.0단은 confidence ≥0.95 필요 — 픽스처 규모(행수 가중치)로는 도달 불가, 실DB 대규모 관측에서 나타남 |
| 4 | **ai_suggested 보라 파선 + AI 라벨** | 아무 앵커에나 다수 존재 |
| 5 | **view_lineage 점선 + 뷰 접힘/펼침** | `V_CHAIN_05` 검색 → 뷰 노드 ▸ 토글로 펼치면 점선 노출 |
| 6 | **depth_exceeded / cycle 배지** | `V_CHAIN_12`, `V_CYCLE_A` 검색 |
| 7 | **DMV 격리 배지** | `V_DMV` 검색 (매 노드 헤더 배지) |
| 8 | **AI 요약 툴팁 + AI 배지** | HR_SALARY·HR_EMP 노드 헤더에 AI 배지, hover 시 요약 |
| 9 | **저카디널리티 배지·사유** | 아무 테이블의 `USE_YN` 컬럼 클릭 → 패널에 제외 사유 |
| 10 | **ERD 조인 빌더 전체 플로우** | `T_ORG_DUTY` 노드의 `DEPTCD` 컬럼 행(`ErdNode-columnRow-*`)에서 드래그 시작 → 후보 컬럼이 하이라이트(같은 행에 `erd-node__row--hl`) → 대상 컬럼 위에 드롭 → 하단 도크(`JoinBuilder-root`)에 스텝 추가(`JoinBuilder-step-*`)되며 자동 검증 → 판정이 증상+처방으로 렌더(`JoinBuilder-stepLevel-*` 배지 + symptom 텍스트, 있으면 "→ remedy") → `JoinBuilder-previewButton` → 모달(`JoinPreviewPanel-root`)에서 SQL 탭(`JoinPreviewPanel-sqlTab`/`-sql`) 확인 후 행 탭(`JoinPreviewPanel-rowsTab`/`-rows`, 최대 20행) 확인 |
| 11 | **40노드 임계 확인 모달** | 노드의 `+` 버튼으로 이웃 확장 반복 (AI 엣지 때문에 2~3회면 초과) |
| 12 | **검색 3종** | 일반 검색 / 타입 필터(테이블·뷰) / `?주문` 처럼 `?` 프리픽스 AI 탐색 |
| 13 | **/parsing 지표 화면** | 헤더 "파싱 지표" — 타일 7개 + 격리 목록(V_PVT 2건: unsupported) |
| 14 | **/admin 관리 콘솔** | 헤더 "관리" — 화이트리스트 2건 표시, 추가·삭제, `AD 전체 동기화` 버튼은 로컬 LDAP off라 503 에러 배너(에러 UX 확인용) |
| 15 | **헤더** | 사용자명 `dev.user` 표시, 파싱/관리 링크 |

디자인 기준: `rules/frontend/design-app.md` (색·패턴·배지가 표와 일치하는지 대조).

> ⚠ **한 번은 LAN IP로도 확인** (`http://<내 IP>:3000`) — bpm 운영 레슨: `localhost`는 secure
> context라 서버(평문 HTTP + 원격 IP)에서만 터지는 문제(`crypto.*` 계열 undefined)가 재현되지
> 않는다. LAN IP 접속이 서버 환경과 같은 조건이다.

## 3. 서버 배포 후에만 검증 가능한 것

- Keycloak 로그인·silent 자동 로그인·로그아웃, 화이트리스트 **차단 화면**(비등록 계정 로그인)
- 헤더 로그아웃 버튼 (auth ON에서만 렌더)
- LDAP 동기화 결과(/admin 동기화 성공 경로), n8n W0/W1, 실DB T2/T3
- PKCE 자동 활성(HTTPS 전환 시)

배포 리허설이 필요해지면 `docs/local-test.md`(Docker 킷) 참조.
