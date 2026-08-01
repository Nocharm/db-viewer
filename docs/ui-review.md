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

시드가 만드는 상태: 확정 관계 1건(✓), 고신뢰 inferred(3회 관측), 저신뢰 inferred 2건(고아 포함),
AI 제안 엣지 ~330건, AI 요약 2건, 화이트리스트 2명.

## 2. 체크리스트 (픽스처 seed 42 기준 — 검색어 그대로 사용)

| # | 확인 대상 | 방법 |
|---|---|---|
| 1 | **fk 실선(녹색) + ✓ confirmed** | `HR_APRV` 검색 → 캔버스. ✓ 라벨 엣지가 confirmed |
| 2 | **inferred 파선 — 투명도 1.0** | `HR_LOG` 검색 → HR_MST로 향하는 파란 파선 |
| 3 | **inferred 파선 — 투명도 0.45(저신뢰·고아)** | `BOM_STAT` 또는 `T_ITM_HIST` 검색 |
| 4 | **ai_suggested 보라 파선 + AI 라벨** | 아무 앵커에나 다수 존재 |
| 5 | **view_lineage 점선 + 뷰 접힘/펼침** | `V_CHAIN_05` 검색 → 뷰 노드 ▸ 토글로 펼치면 점선 노출 |
| 6 | **depth_exceeded / cycle 배지** | `V_CHAIN_12`, `V_CYCLE_A` 검색 |
| 7 | **DMV 격리 배지** | `V_DMV` 검색 (매 노드 헤더 배지) |
| 8 | **AI 요약 툴팁 + AI 배지** | HR_APRV·HR_MST 노드 헤더에 AI 배지, hover 시 요약 |
| 9 | **저카디널리티 배지·사유** | 아무 테이블의 `USE_YN` 컬럼 클릭 → 패널에 제외 사유 |
| 10 | **ColumnPanel 전체 플로우** | `HR_LOG` 노드에서 `HR_NO` 클릭 → 후보(신호 배지: 뷰JOIN/명명/PK) → T2 검증 → 결과 카드(containment·cardinality·confidence·패턴 라벨·이력) → 미리보기 20행 → 확정 → ✓ CONFIRMED 배지 |
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
