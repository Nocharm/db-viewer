# App Design System — db-viewer (v2: ClickHouse 기반)

기준 시스템이 **Cohere(라이트) → ClickHouse(다크 기본)** 로 전환됐다 (사용자 지시,
2026-08-01). 원본 레퍼런스: `rules/frontend/DESIGN-clickhouse.md` (사용자 제공 분석 문서
— 저장 예정, 값 원본은 사용자 메시지). 이전 Cohere 시스템은 `DESIGN-cohere.md`로 동결 유지.

## 핵심 계약

- **다크 기본 + 라이트 변형 + 헤더 토글** (`<html data-theme>`, localStorage `dbv.theme`,
  페인트 전 인라인 스크립트로 플래시 방지)
- 근흑 캔버스 `#0a0a0a` / 서피스 카드 `#1a1a1a` / 중첩 카드 `#242424` / 해어라인 `#2a2a2a`
- **일렉트릭 옐로 `#faff69`** = 유일한 브랜드 전압 — primary CTA(`btn-primary`, 블랙 텍스트),
  선택 상태(조인키 칩·리스트 좌측 보더·앵커 포커스 링), 스탯성 표시(일치율 게이지),
  검색 하이라이트(`mark.hl`). 본문·면색으로 남용 금지
- Inter 단일 패밀리(700 display·600 버튼·400 본문), 코드·식별자는 JetBrains Mono 폴백 스택
- 그림자 없음 — 깊이는 캔버스↔카드 명도 차이. 카드 radius 12px, 버튼 8px, 배지 pill
- 라이트 변형: 화이트 캔버스 + 라이트 그레이 카드, 옐로 CTA는 동일(블랙 텍스트라 양 테마 성립),
  텍스트 링크만 테마별(다크=옐로, 라이트=블루)

## 토큰 구현

`frontend/src/app/globals.css`의 `:root`(다크)와 `[data-theme="light"]` 두 세트.
기존 컴포넌트 호환을 위해 구 토큰명을 별칭으로 유지:
`--soft-stone`(hover 면)→surface-elevated, `--focus-blue`→primary(포커스 링=옐로),
`--action-blue`(링크)→다크 옐로/라이트 블루, `--slate`·`--muted`→그레이 스케일.

## ERD 신뢰도 팔레트 — 테마별 검증 (dataviz validator)

색=신뢰도, 패턴=종류, 배지=색 독립 보조 인코딩 원칙은 불변.

| 상태 | 다크 (`#0a0a0a` 계열 서피스) | 라이트 (`#ffffff`) |
|---|---|---|
| 확정 (fk/confirmed) | `#059669` | `#00926a` |
| 추정 (inferred) | `#2a62cf` | `#1863dc` |
| AI 제안 | `#cf5fd9` | `#9b60aa` |
| 미해석 | `#ef4444` | `#b30000` |
| view lineage (중립) | `#888888` | `#93939f` |

- **다크 세트 검증 (2026-08-01, `--mode dark --pairs all`): ALL CHECKS PASS** —
  Lightness ✓ Chroma ✓ Normal 21.1 ✓ Contrast ≥3:1 ✓, CVD worst 7.4(protan)는
  6–8 합법 대역(파선 패턴 + 필수 배지 보조 인코딩 보유)
- 라이트 세트는 v1에서 검증된 팔레트 그대로
- 팔레트 변경 시 두 테마 모두 재검증:
  `node scripts/validate_palette.js "<4색>" --mode dark|light --pairs all`

## 컴포넌트 클래스 (globals.css)

`btn-primary`(옐로 CTA) · `btn-secondary`(다크 서피스) · `icon-button` · `key-chip(--selected)`
· `list-row(--selected)` · `card` · `panel-section`(중첩 카드) · `badge--*` · `rate-bar`(옐로 fill)
· `scroll-area`(호버 시에만 스크롤바) · `pressable`(ease-in-out + 클릭 스케일) · `mark.hl`
· React Flow 다크 오버라이드(`.react-flow__controls*`, edge label bg)

## Don't

- 옐로 외 제2 브랜드 색 도입 금지 (신뢰도 팔레트는 데이터 채널 — 브랜드 색 아님)
- 그림자 금지, 본문에 옐로 텍스트 금지, pill은 배지 전용
- `data-testid` 규칙은 `identifiers.md` 그대로
