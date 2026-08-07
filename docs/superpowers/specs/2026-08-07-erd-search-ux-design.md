# ERD·검색 UX 개선 설계 (9건)

날짜: 2026-08-07
상태: 승인됨 (구현 전)
선행: `2026-08-07-verify-page-readonly-erd-design.md` (머지 완료 — 이 설계는 그 결과물 위 개선)

## 요구 원문 → 확정 해석

| # | 요구 | 확정 |
|---|---|---|
| 1 | 엣지 꺾은선 | React Flow `smoothstep` + ELK 직교 라우팅 |
| 2 | 엣지 호버 시 양쪽 컬럼 하이라이트, 화면에 컬럼 나오게 | 호버 = 자동 펼침 + 컬럼 행 스크롤 + 하이라이트. 호버 해제 후 펼침 유지(요동 방지), 하이라이트만 해제 |
| 3 | 범례가 확대툴 가림 | 범례 우측 아래로 이동 (Controls는 좌하 유지) |
| 4 | 맵 검색 좌상단 + 클릭 포커싱·네비게이션 | 그래프 노드 클라이언트 검색 드롭다운 → 클릭 시 `setCenter` 애니메이션(500ms) + 포커스 하이라이트 |
| 5 | 엣지-노드 겹침 최소화 | ELK `elk.edgeRouting: ORTHOGONAL` + `spacing.edgeNode`/`edgeEdge` 확대 |
| 6 | 헤더 더블클릭 펼침/접힘 | TableNode 헤더 onDoubleClick → 기존 토글. 토글 버튼 유지 |
| 7 | 엣지 색·라벨 세련되게 | 라벨은 호버 시에만 컬럼 페어 필(`EMP_NO → EMP_NO`). 색은 `--rel-*` 토큰 유지, 기본 톤 감쇠·호버/선택 강조(굵기+1·풀 컬러), 호버 중 타 엣지 감쇠 |
| 8 | 데이터 타입 줄바꿈 | 타입 span `shrink-0 whitespace-nowrap`, 컬럼명이 truncate — 행 한 줄 고정 |
| 9 | 조인 검증 테이블 선택 = 드롭다운&검색 | TablePickerPanel → 콤보박스 (인풋+드롭다운, 선택 시 이름+지우기 버튼) |
| 10 | 모든 검색 정확 > 순서 유사 노출 | 4단계 랭킹 공통 lib — 아래 |

## 검색 랭킹 (공통 lib)

`frontend/src/lib/search-rank.ts` — 순수 함수 + vitest.

- 단계: **① 정확 일치 → ② 접두어 → ③ 부분 포함 → ④ 순서 유사**(검색어 문자가 대상에 순서대로 등장, 예 `HREMP` → `HR_EMP`). 대소문자 무시. 같은 단계 안에서는 이름 오름차순.
- `rankSearchResults<T>(query, items, getText: (item) => string): T[]` 형태 — 매칭 안 되는 항목 제외.
- 적용 3곳: 테이블 브라우저 목록 검색(기존 초성·컬럼명·카테고리 매칭 기능 유지, **정렬만** 이 랭킹 적용), 조인 검증 콤보박스, ERD 맵 검색.
- 제외: AI 자연어 검색(`?`)·챗. 백엔드 `searchObjects`는 변경 없음 — 랭킹은 전량 로드 목록(`fetchAllObjects` 캐시) 위에서 클라이언트 수행.

## 컴포넌트 변경

- `ErdViewer.tsx`: 엣지 type smoothstep, 호버 핸들러(onEdgeMouseEnter/Leave — 펼침·스크롤·하이라이트·강조/감쇠·라벨), 맵 검색 오버레이(좌상), Legend 우하 이동, `setCenter` duration.
- `TableNode.tsx`: 헤더 onDoubleClick, 컬럼 행 nowrap, 하이라이트 행 스크롤 타깃(기존 highlightColumns·columnScroll 활용).
- `Legend.tsx`: 위치 클래스만.
- `components/erd/ErdSearch.tsx` 신설: 맵 검색 인풋+드롭다운 (search-rank 사용).
- `components/verify/TablePickerPanel.tsx`: 콤보박스로 개편 (fetchAllObjects 1회 캐시 + search-rank, HIDDEN 정책은 서버 목록이 이미 반영).
- `lib/layout.ts`: ELK 옵션 추가.
- 브라우저 검색: `lib/search.ts`(기존 강화 검색)의 정렬 단계에 search-rank 통합.

## 에러·경계

- 호버 자동 펼침은 레이아웃 재계산을 유발 — 펼침 유지 정책으로 호버 이탈 시 재계산 없음. 연속 호버 시 강조 상태만 교체.
- 맵 검색은 로드된 그래프 노드만 대상(미검증 테이블은 안 나옴 — ERD 정체성과 일치). 빈 결과 문구 제공.
- 콤보박스 외부 클릭 닫기, 키보드(↑↓·Enter·Esc) 기본 지원.

## 테스트

- `search-rank.test.ts`: 4단계 순위·대소문자·순서 유사 경계(불연속 등장·역순 미매칭)·동단계 이름순.
- 기존 `search.test.ts` 갱신(정렬 변화 반영).
- 컴포넌트 렌더 테스트는 프로젝트 관례상 없음 — tsc·lint·vitest·build 게이트 + 브라우저 스모크(가능 시).
