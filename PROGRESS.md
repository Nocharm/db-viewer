# Progress

프로젝트 진행 현황 로그. 커밋 직전 갱신한다 (`rules/common/git.md` 규칙).

## 2026-08-01

- **정지점 6(프론트): ERD 뷰어** — Next.js 15 + React Flow + elkjs(bundled — 메인 엔트리는 web-worker require로 번들 깨짐) + Tailwind v4. 앵커 검색→1-hop 확장, 뷰 기본 접힘(펼치면 lineage 점선 노출), 40노드 임계치 확인 모달(이미 초과 상태에선 재확인 안 함), design-app.md 토큰 CSS 변수화. 순수 로직(엣지 스타일·병합·크기 추정·ELK 결정성) vitest 12건 + 빌드·lint 통과. 스모크: 픽스처 시드 후 프록시 경유 검색 확인(브라우저 확장 미연결로 시각 확인은 보류).
- **정지점 6(백엔드): 조회 API** — objects 검색 / 앵커 N-hop 그래프(depth≤3 강제, 전체 그래프 반환 없음) / 뷰 lineage / 스냅샷 목록·diff. FK diff는 이름이 아니라 (src, tgt, 컬럼페어) 시그니처로 매칭(자동 생성 이름 변동 대비). 그래프 응답에 lineage_flag·unresolved_dep_count 포함해 UI 배지 데이터 제공. 레이아웃 엔진은 ELK 선정(결정적 배치·계층 표현·가변 노드 크기 — d3-force는 비결정성으로 기각).
- **정지점 5: lineage 재귀 엔진** — 순수 도메인 함수(경로 기반 순환 감지, 깊이 상한, 메모이제이션, 플래그 전파 — cycle이 depth_exceeded보다 우선). view-deps ingest 완료 시 동기 실행해 `view_lineage_flat` 적재. 픽스처 기대치와 전체 집합 동일성 검증 통과(중첩 뷰의 부모 전체 집합 상속 포함). 혼합 케이스(테이블 직접 참조 + 순환 참조)는 해석 행 유지 + 플래그 행 추가로 결정. `LINEAGE_DEPTH_LIMIT` 튜닝 설정 추가.
- **정지점 4: 수집 SQL + ingest** — FastAPI 앱 + `/api/ingest/catalog`·`/api/ingest/view-deps` (픽스처 포맷 = 계약). is_pk는 key_constraints에서 파생, 미해석 참조는 텍스트 식별자 보존, 에러는 승인된 `{"error": {code, message, context}}` 규약. 스키마 추가 2건(0002): `objects.definition`(Phase 2 파싱 입력 영속화 — raw POST는 재조회 불가), `objects.dmv_unresolved`. 수집 T-SQL 7종은 `n8n/sql/` — 07은 커서 + TRY/CATCH로 객체별 개별 호출(일괄 CROSS APPLY 전체 실패 방지).
- **정지점 3: 픽스처 생성기** — `tools/fixture_gen.py` (stdlib only, 시드 결정론). 409 테이블 / 9,000 컬럼 + 필수 케이스 전부(12단 체인, 순환 뷰, 크로스 DB, definition NULL, PIVOT/APPLY/힌트, DMV 실패, 함정 컬럼). 기대치는 두 벌: lineage_full(컬럼 정밀, Phase 2용) / lineage_phase1(set-level — 중첩 뷰는 부모의 전체 참조 집합 상속, deps만으로는 좁힐 수 없음). 값 집합은 관계 DAG 위상 순서로 생성하고 containment를 최종 집합에서 재계산해 데이터·기대치 불일치를 원천 차단.
- **정지점 2: 서비스 DB 스키마** — PostgreSQL 16 + SQLAlchemy 2.0 + Alembic 확정. 계획 DDL에 3개 필드 추가: `view_deps.referenced_database/name`(미해석·크로스 DB 참조의 텍스트 식별자 보존 — 없으면 Phase 2 재해석 불가), `view_lineage_flat.flag`(cycle/depth_exceeded), `columns.masking_policy`(§3.5 선반영). 테스트는 SQLite로 실행(dialect 중립), drift는 alembic compare_metadata로 검증.
- **Step 0 개편안 승인** — 신뢰도 4색 팔레트를 dataviz validator로 검증해 확정(`#00926a`는 deep-green 램프 확장 — 원본은 선 색으로 명도·채도 미달). staleness는 투명도 대신 배지(confidence 인코딩과 충돌), 다크모드 v1 제외. 확장 토큰·ERD 시각 언어는 `rules/frontend/design-app.md` 신설로 분리(원본 DESIGN-cohere.md 동결).
- **프로젝트 초기화** — claude-code-template 기반 셋업. 스택은 FastAPI(Python) + Next.js(TypeScript)로 결정, 백엔드/프론트엔드/양 언어 룰 모두 유지. 템플릿 메타 문서(docs/template/)와 템플릿 개발 이력(PROGRESS) 제거. 상세 설계·스캐폴딩은 후속 계획으로 진행 예정.
