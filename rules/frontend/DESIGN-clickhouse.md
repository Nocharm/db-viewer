---
version: alpha
name: ClickHouse-design-analysis
description: A high-performance database interface anchored on near-pure black canvas with electric yellow as the brand voltage. White typography in confident sans, yellow CTAs, and yellow-text stat numbers carry the brand voice across every page. Code blocks and product UI fragments embed directly in dark cards. The yellow + black pairing (and yellow used scarcely as accent) is the system's signature — brand identity without atmospheric decoration.

colors:
  primary: "#faff69"
  primary-active: "#e6eb52"
  primary-disabled: "#3a3a1f"
  ink: "#ffffff"
  body: "#cccccc"
  body-strong: "#e6e6e6"
  muted: "#888888"
  muted-soft: "#5a5a5a"
  hairline: "#2a2a2a"
  hairline-strong: "#3a3a3a"
  canvas: "#0a0a0a"
  surface-soft: "#121212"
  surface-card: "#1a1a1a"
  surface-elevated: "#242424"
  surface-yellow-band: "#faff69"
  on-primary: "#0a0a0a"
  on-dark: "#ffffff"
  on-yellow: "#0a0a0a"
  accent-emerald: "#22c55e"
  accent-rose: "#ef4444"
  accent-blue: "#3b82f6"
  success: "#22c55e"
  warning: "#f59e0b"
  error: "#ef4444"

typography:
  display-xl: { fontFamily: "Inter, sans-serif", fontSize: 72px, fontWeight: 700, lineHeight: 1.05, letterSpacing: -2.5px }
  display-lg: { fontFamily: "Inter, sans-serif", fontSize: 56px, fontWeight: 700, lineHeight: 1.1, letterSpacing: -2px }
  display-md: { fontFamily: "Inter, sans-serif", fontSize: 40px, fontWeight: 700, lineHeight: 1.15, letterSpacing: -1.5px }
  display-sm: { fontFamily: "Inter, sans-serif", fontSize: 32px, fontWeight: 700, lineHeight: 1.2, letterSpacing: -1px }
  title-lg: { fontFamily: "Inter, sans-serif", fontSize: 24px, fontWeight: 700, lineHeight: 1.3, letterSpacing: -0.3px }
  title-md: { fontFamily: "Inter, sans-serif", fontSize: 18px, fontWeight: 600, lineHeight: 1.4, letterSpacing: 0 }
  title-sm: { fontFamily: "Inter, sans-serif", fontSize: 16px, fontWeight: 600, lineHeight: 1.4, letterSpacing: 0 }
  stat-display: { fontFamily: "Inter, sans-serif", fontSize: 56px, fontWeight: 700, lineHeight: 1.0, letterSpacing: -1.5px }
  body-md: { fontFamily: "Inter, sans-serif", fontSize: 16px, fontWeight: 400, lineHeight: 1.55, letterSpacing: 0 }
  body-sm: { fontFamily: "Inter, sans-serif", fontSize: 14px, fontWeight: 400, lineHeight: 1.55, letterSpacing: 0 }
  caption: { fontFamily: "Inter, sans-serif", fontSize: 13px, fontWeight: 500, lineHeight: 1.4, letterSpacing: 0 }
  caption-uppercase: { fontFamily: "Inter, sans-serif", fontSize: 12px, fontWeight: 600, lineHeight: 1.4, letterSpacing: 1.5px }
  code: { fontFamily: "JetBrains Mono, ui-monospace, monospace", fontSize: 14px, fontWeight: 400, lineHeight: 1.55, letterSpacing: 0 }
  button: { fontFamily: "Inter, sans-serif", fontSize: 14px, fontWeight: 600, lineHeight: 1, letterSpacing: 0 }
  nav-link: { fontFamily: "Inter, sans-serif", fontSize: 14px, fontWeight: 500, lineHeight: 1.4, letterSpacing: 0 }

rounded: { xs: 4px, sm: 6px, md: 8px, lg: 12px, pill: 9999px, full: 9999px }

spacing: { xxs: 4px, xs: 8px, sm: 12px, md: 16px, lg: 24px, xl: 32px, xxl: 48px, section: 96px }
---

## Overview (요약 보존본)

사용자 제공 ClickHouse 디자인 분석 문서의 보존본. 근흑 캔버스(#0a0a0a) + 일렉트릭 옐로(#faff69)
단일 브랜드 전압. Inter 단일 패밀리(700 디스플레이 + 네거티브 트래킹 / 600 버튼 / 400 본문),
코드 블록은 JetBrains Mono로 다크 카드에 직접 임베드. 그림자 없음 — 깊이는 캔버스↔카드
(#1a1a1a) 명도 차. 버튼 radius 8px, 콘텐츠 카드 12px, pill은 배지 전용.

핵심 원칙:
- 옐로는 요소 수준에선 희소하게(CTA·스탯 숫자·포커스), 밴드 수준에선 과감하게(옐로 CTA 카드)
- 제2 브랜드 색 금지 — 시맨틱 악센트는 emerald #22c55e / rose #ef4444 / blue #3b82f6
- hover 스타일은 시스템이 정의한 것 외 추가 금지, Active/Pressed만 문서화
- 연속 밴드에 같은 서피스 모드 반복 금지 (canvas → dark card → yellow band → canvas …)
- 코드가 곧 마케팅 — SQL 목업을 추상 일러스트로 대체하지 말 것

컴포넌트 명세(top-nav 64px, button-primary 40px h·12×20 패딩, text-input 40px h,
category-tab, badge-pill/badge-yellow, cta-band-yellow, footer 등)와 반응형 규칙
(768/1024/1440 브레이크포인트, 히어로 7-5 그리드 → 모바일 1열, 코드 카드는 폰트 유지 +
가로 스크롤)은 원문 유지. Known gaps: 옐로 hex는 스크린샷 샘플, 애니메이션 타이밍 미정의.

> db-viewer 적용 계약(토큰 매핑·테마 토글·검증된 신뢰도 팔레트)은 `design-app.md` 참조.
