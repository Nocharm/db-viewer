# Progress

프로젝트 진행 현황 로그. 커밋 직전 갱신한다 (`rules/common/git.md` 규칙).

## 2026-08-01

- **정지점 3: 픽스처 생성기** — `tools/fixture_gen.py` (stdlib only, 시드 결정론). 409 테이블 / 9,000 컬럼 + 필수 케이스 전부(12단 체인, 순환 뷰, 크로스 DB, definition NULL, PIVOT/APPLY/힌트, DMV 실패, 함정 컬럼). 기대치는 두 벌: lineage_full(컬럼 정밀, Phase 2용) / lineage_phase1(set-level — 중첩 뷰는 부모의 전체 참조 집합 상속, deps만으로는 좁힐 수 없음). 값 집합은 관계 DAG 위상 순서로 생성하고 containment를 최종 집합에서 재계산해 데이터·기대치 불일치를 원천 차단.
- **정지점 2: 서비스 DB 스키마** — PostgreSQL 16 + SQLAlchemy 2.0 + Alembic 확정. 계획 DDL에 3개 필드 추가: `view_deps.referenced_database/name`(미해석·크로스 DB 참조의 텍스트 식별자 보존 — 없으면 Phase 2 재해석 불가), `view_lineage_flat.flag`(cycle/depth_exceeded), `columns.masking_policy`(§3.5 선반영). 테스트는 SQLite로 실행(dialect 중립), drift는 alembic compare_metadata로 검증.
- **Step 0 개편안 승인** — 신뢰도 4색 팔레트를 dataviz validator로 검증해 확정(`#00926a`는 deep-green 램프 확장 — 원본은 선 색으로 명도·채도 미달). staleness는 투명도 대신 배지(confidence 인코딩과 충돌), 다크모드 v1 제외. 확장 토큰·ERD 시각 언어는 `rules/frontend/design-app.md` 신설로 분리(원본 DESIGN-cohere.md 동결).
- **프로젝트 초기화** — claude-code-template 기반 셋업. 스택은 FastAPI(Python) + Next.js(TypeScript)로 결정, 백엔드/프론트엔드/양 언어 룰 모두 유지. 템플릿 메타 문서(docs/template/)와 템플릿 개발 이력(PROGRESS) 제거. 상세 설계·스캐폴딩은 후속 계획으로 진행 예정.
