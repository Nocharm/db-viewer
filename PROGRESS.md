# Progress

프로젝트 진행 현황 로그. 커밋 직전 갱신한다 (`rules/common/git.md` 규칙).

## 2026-08-01

- **Step 0 개편안 승인** — 신뢰도 4색 팔레트를 dataviz validator로 검증해 확정(`#00926a`는 deep-green 램프 확장 — 원본은 선 색으로 명도·채도 미달). staleness는 투명도 대신 배지(confidence 인코딩과 충돌), 다크모드 v1 제외. 확장 토큰·ERD 시각 언어는 `rules/frontend/design-app.md` 신설로 분리(원본 DESIGN-cohere.md 동결).
- **프로젝트 초기화** — claude-code-template 기반 셋업. 스택은 FastAPI(Python) + Next.js(TypeScript)로 결정, 백엔드/프론트엔드/양 언어 룰 모두 유지. 템플릿 메타 문서(docs/template/)와 템플릿 개발 이력(PROGRESS) 제거. 상세 설계·스캐폴딩은 후속 계획으로 진행 예정.
