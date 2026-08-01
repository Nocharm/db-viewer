# App Design System — db-viewer

`DESIGN-cohere.md`(동결된 원본 레퍼런스)의 앱 확장. 토큰 값·flat 원칙·white canvas는 원본을 따르고,
이 문서는 **확장 토큰 + ERD 시각 언어**만 정의한다. 근거: `docs/step0-proposal.md` (승인 완료).

## 적용 범위

- 마케팅 컴포넌트 8종 미사용: announcement-bar, hero-photo-card, trust-logo-strip,
  blog-filter-chip, footer-newsletter, dark-feature-band, product-card, contact-form-card
- Display 타이포(96/72/60px) 미사용 — 앱 최대 `section-heading`(48px)
- 다크모드 v1 미지원 (라이트 전용, 승인 결정)

## 확장 토큰

```yaml
# 신뢰도 색 — 색만으로 구분 금지. 선 패턴·배지가 색과 독립적으로 상태를 인코딩한다
colors:
  rel-confirmed: "#00926a"   # deep-green 램프의 선(line)용 밝은 단계 — 확정 (fk / confirmed)
  rel-inferred: "#1863dc"    # action-blue 재사용 — 추정 (containment 검증 통과)
  rel-ai: "#9b60aa"          # form-focus 재사용 — AI 제안 (미검증)
  rel-unresolved: "#b30000"  # error 재사용 — 미해석 / 파싱 실패
  rel-lineage: "#93939f"     # muted 재사용 — view lineage (신뢰도 채널 아님, 구조 채널)

typography:
  erd-table-name:            # ERD 노드 헤더 — mono-label 축소판
    fontFamily: CohereMono
    fontSize: 13px
    fontWeight: 500
    letterSpacing: 0.26px
    textTransform: uppercase
  erd-badge:                 # 상태 배지 (AI / ⚠ / N:M / 저카디널리티)
    fontFamily: CohereMono
    fontSize: 10px
    fontWeight: 500
    textTransform: uppercase
  # ERD 컬럼 행은 기존 micro(12px) 재사용 — 신규 토큰 최소화
```

## ERD 노드

flat 원칙 유지 — 그림자 금지, 보더로 상태 표현.

| 요소 | 스펙 |
|---|---|
| table 노드 | canvas bg + hairline 1px 보더 + rounded sm(8px). 헤더 `erd-table-name`, 컬럼 행 micro/ink, PK 행 키 아이콘, row_count는 caption/muted |
| view 노드 | soft-stone bg, 기본 접힘. 펼치면 lineage 엣지 노출 |
| 앵커/선택 | focus-blue(`#4c6ee6`) 2px ring |
| 상태 배지 | `erd-badge` — parse_failed·unresolved(rel-unresolved 연한 배경), 저카디널리티(muted + 사유 툴팁), AI(rel-ai) |
| hover | 보더 ink 강조 (그림자 대신) |

## ERD 엣지 — 색 = 신뢰도, 패턴 = 종류, 배지 = 색 독립 보조 인코딩

| 상태 | 색 | 패턴 (2px) | 보조 인코딩 |
|---|---|---|---|
| 확정 — fk | `rel-confirmed` | 실선 | — |
| 확정 — 사용자 confirmed | `rel-confirmed` | 실선 | ✓ 배지 (fk와 구분) |
| 추정 — inferred | `rel-inferred` | 파선 8‑4 | 투명도 = confidence |
| AI 제안 — ai_suggested | `rel-ai` | 파선 3‑3 | `AI` 배지 필수 |
| 미해석 — unresolved | `rel-unresolved` | 일점쇄선 | ⚠ 배지 |
| view lineage | `rel-lineage` | 점선 1.5‑4 | 신뢰도 채널 아님 |

- confidence 투명도는 **3단계 스텝** — 1.0 / 0.7 / 0.45. 연속 투명도는 비교 불가, 0.45 미만은 hairline과 혼동
- **staleness는 투명도 재사용 금지** (confidence와 충돌). `last_verified_at` 배지 + 임계 90일 초과 시 배지 회색 (승인 결정 — 계획서 §3.4 "흐리게"를 대체)
- N:M 교차 관계: 양끝 무방향 + `N:M` 배지 — FK로 오독 방지. 1:N은 N쪽 화살표
- 카디널리티 크로우풋 표기는 v1 미채택 (렌더러 마커 제약 확인 후 재검토)

## 색상 검증 기록 (dataviz validator, 2026-08-01)

신뢰도 4색 `--pairs all` (동일 화면 공존) 전 항목 PASS:
Lightness band ✓ · Chroma floor ✓ · CVD worst ΔE 9.3(protan) ✓ · Normal-vision 17.9 ✓ · Contrast ≥3:1 ✓

- 원본 `deep-green #003c33`은 선 색으로 탈락(명도·채도 미달) → 램프 확장 `#00926a`.
  `deep-green`은 면·텍스트 용도로 계속 사용
- 탈락 후보: coral `#ff7759`(대비 2.55:1), slate `#75758a`(채도 미달, violet과 CVD ΔE 4.7)
- `rel-lineage` 회색은 의도적 recessive 중립 — 카테고리 세트 제외, 점선 패턴이 식별 담당
- 팔레트 변경 시 재검증 필수: `node scripts/validate_palette.js "<4색>" --mode light --pairs all`

## data-testid

ERD 요소도 `identifiers.md` 적용: `ErdCanvas-node-${objectId}`, `ErdCanvas-edge-${relationId}`,
`ErdToolbar-expandButton`, `NodeDetail-verifyButton` 형식.
