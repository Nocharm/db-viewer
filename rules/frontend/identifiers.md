# Frontend Identifiers

UI 요소에 안정적인 식별자(`data-testid`)를 부여해, 나중에 디버깅·테스트·기능개선 때 요소를 빠르게 특정한다. className·텍스트 셀렉터는 리팩터링에 깨지지만 `data-testid`는 식별 전용이라 안정적이다.

---

## 규칙

- **인터랙티브·상태 요소에 `data-testid`를 부여한다** — 사용자가 조작하거나 동작/상태가 바뀌는 요소.
- **형식: `ComponentName-role`** — PascalCase 컴포넌트명 + `camelCase` 역할. 예: `UserProfile-submitButton`, `LoginForm-emailInput`.
- **리스트 항목은 식별 키를 덧붙인다** — `TodoList-item-${todo.id}` 처럼 인스턴스를 유일하게 구분.
- **식별 전용으로만 쓴다** — `data-testid`로 스타일링하거나 동작을 분기하지 않는다. 스타일은 `className`, 동작은 props로.

## 부여 대상 / 비대상

| 부여 | 비부여 |
|------|--------|
| 버튼, 링크, 입력, 셀렉트, 체크박스 | 순수 레이아웃 wrapper (`div`, `section`) |
| 폼, 모달, 드롭다운, 탭 | 장식용 아이콘·텍스트 노드 |
| 로딩 / 에러 / 빈 상태 영역 | 조작·검증할 일이 없는 정적 요소 |
| 리스트 컨테이너 + 각 항목 | |

## 사용처

- **테스트** — `screen.getByTestId(...)`, `page.getByTestId(...)`. className/텍스트보다 리팩터링에 안정적.
- **디버깅** — 브라우저에서 `[data-testid="..."]`로 즉시 선택, 로그·이슈에서 요소를 정확히 지칭.
- **기능개선** — 대화에서 "`UserProfile-submitButton` 동작 바꿔줘"처럼 요소를 모호함 없이 참조.

## Don't

- 의미 없는 값 (`data-testid="btn1"`, `data-testid="div"`) — 컴포넌트·역할이 드러나야 한다.
- 같은 화면에 중복 `data-testid` — 리스트는 키를 붙여 유일하게.
- 프로덕션에서 제거할지는 프로젝트가 정한다 — 용량 영향은 미미하고 운영 디버깅에 유용하다.
