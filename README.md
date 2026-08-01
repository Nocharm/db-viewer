# db-viewer

MSSQL 시스템 카탈로그에서 스키마를 수집하고, 뷰를 역추적해 base table lineage를 복원하며, FK가 없는 관계를 온디맨드 검증으로 발견·기록해 ERD로 제공하는 도구.

- 대상 규모: 테이블 409개, 컬럼 약 9,000개
- 백엔드: Python / FastAPI
- 프론트엔드: TypeScript / Next.js

## 상태

프로젝트 초기화 단계. 상세 설계·스캐폴딩은 진행 예정 — setup/실행 방법은 코드가 생기는 시점에 이 문서에 채운다.

## 디렉터리

```
rules/    # 코딩·작업 규칙 (CLAUDE.md에서 import)
docs/     # 프로젝트 문서
```
