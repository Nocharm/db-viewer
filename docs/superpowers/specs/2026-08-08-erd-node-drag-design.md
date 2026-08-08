# ERD 노드 드래그 이동 + 헤더 호버 + 위치 초기화 설계

날짜: 2026-08-08
상태: 승인됨 (구현 전)
선행: `2026-08-07-erd-search-ux-design.md` (머지 완료 — 이 설계는 그 결과물 위 개선)

## 요구 원문 → 확정 해석

| # | 요구 | 확정 |
|---|---|---|
| 1 | 테이블 헤더 호버링 효과 | 헤더 배경 틴트 + 커서 `grab`(드래그 중 `grabbing`) — "여기를 잡으면 움직인다"는 드래그 어포던스 |
| 2 | 테이블 클릭 드래그로 위치이동 | **헤더만** 드래그 그립 (`dragHandle`). 수동 위치는 재레이아웃(펼침/접힘)에서도 유지, 세션 한정(새로고침 시 ELK 자동 배치로 복귀) |
| 3 | 위치 초기화 기능 | Controls 스택에 초기화 버튼 — 수동 이동 전부 해제 후 ELK 자동 배치 복원. 수동 이동 없으면 비활성화 |

## 결정 사항 (Q&A로 확정)

- **드래그 그립 = 헤더만.** 컬럼 행의 클릭·스크롤·조인 핸들과 간섭하지 않고, 호버 효과가 그립 위치를 정확히 가리킨다.
- **수동 위치는 재레이아웃에서 유지.** 접근안 A(오버라이드 맵) 채택 — ELK 파이프라인은 그대로 두고 배치 결과 위에 수동 좌표를 덮어쓴다. ELK는 수동 위치를 모르므로 드물게 자동 배치 노드와 겹칠 수 있음(허용, 초기화 버튼이 탈출구). ELK INTERACTIVE 고정 제약(B)은 layered 지원이 불완전해 기각, 드래그 후 자동 레이아웃 영구 중단(C)은 펼침 시 겹침 회귀라 기각.
- **세션만 유지.** localStorage 저장 없음 — 스키마 갱신 시 오래된 좌표 잘못 처리 로직이 필요 없다.

## 구현

### 1. 헤더 호버 효과 — `frontend/src/app/globals.css`

- `.react-flow .erd-node__header` 커서 `pointer` → `grab`, `.react-flow__node.dragging .erd-node__header`는 `grabbing`.
- `.erd-node__header:hover` 배경 틴트 — 컬럼 행 호버(`hover:bg-black/5`)와 같은 계열의 rgba 틴트 + 기존 transition 패턴(0.15s ease-in-out).

### 2. 헤더 드래그 이동 — `frontend/src/components/erd/ErdViewer.tsx`

- `<ReactFlow>`의 `nodesDraggable={false}` 제거(기본 true), 레이아웃 이펙트가 만드는 노드 객체에 `dragHandle: ".erd-node__header"` 지정.
- **완전 제어 컴포넌트라 `onNodesChange` 필요** — `applyNodeChanges`로 `flowNodes`에 반영하되 **`position` 변경만** 통과시킨다. dimension 변경까지 적용하면 기존 `measured` 수동 관리(엣지 1프레임 언마운트 방지)와 충돌한다.
- `onNodeDragStop`에서 최종 좌표를 `movedRef: Map<number, {x, y}>`에 기록. **ref인 이유**: state로 두고 레이아웃 이펙트 deps에 넣으면 드래그가 끝날 때마다 ELK 전체 재실행 — 기존 "호버가 레이아웃을 안 흔든다" 원칙과 동일하게 드래그도 재레이아웃을 유발하지 않는다.
- 같은 시점에 `placedRef`도 갱신 — 검색 픽 센터링(`handleSearchPick`)이 옮긴 위치를 정확히 조준하도록.
- 초기화 버튼 활성 판정용으로 `movedCount` state만 별도 유지(드래그 스톱 시 `movedRef.size` 반영 — ELK와 무관한 가벼운 리렌더).
- 재레이아웃 이펙트는 ELK 배치 후 `movedRef` 좌표로 덮어쓴다. 병합은 순수 함수로 추출:

```ts
// frontend/src/lib/erd-graph.ts
/** ELK 배치 결과에 수동 이동 좌표를 덮어쓴다 — 크기는 ELK 측정값 유지 */
applyManualPositions(placed: Map<number, PlacedNode>, moved: Map<number, {x, y}>): Map<number, PlacedNode>
```

### 3. 위치 초기화 — `ErdViewer.tsx`

- React Flow `<Controls>` 자식으로 `<ControlButton>` 추가 — ↺ 아이콘, i18n 타이틀(`erd.resetPositions` 키 신설), `data-testid="ErdViewer-resetPositionsButton"`.
- `movedCount === 0`이면 `disabled`.
- 클릭 → `movedRef` 클리어 + `movedCount` 0 + `layoutVersion` state 범프(레이아웃 이펙트 deps에 추가) → ELK 재실행으로 자동 배치 복원. 카메라는 건드리지 않는다.

## 테스트·검증

- `applyManualPositions` vitest 단위 테스트 (`erd-graph.test.ts`에 추가) — 덮어쓰기·크기 유지·moved에만 있는 id 무시.
- 브라우저 실측 (dev 서버 + SQLite 픽스처, `docs/ui-review.md` 실행 절차): 헤더 호버 효과 → 헤더 드래그 이동(컬럼 행 스크롤 비간섭 확인) → 다른 노드 펼침 후 수동 위치 유지 → 초기화 버튼으로 복원 → 검색 픽이 옮긴 위치로 센터링.
- 기존 스위트: vitest + tsc + lint 통과.

## 제외 (YAGNI)

- localStorage 영속화, ELK 고정 제약, 다중 선택 드래그, 드래그 중 스냅/정렬 가이드.
