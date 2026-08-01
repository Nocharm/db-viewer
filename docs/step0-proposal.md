# Step 0 — 규약 요약 & 개편안

> 상세 계획 "0. 선행 작업"의 산출물. **승인 전까지 구현 코드 작성 금지** 상태이며, 이 문서 승인이 정지점 1 해제 조건이다.
>
> 대상 파일: 기본 템플릿 규약(`CLAUDE.md` + `rules/*`), 디자인 md(`rules/frontend/DESIGN-cohere.md`)

---

## 1. 현재 규약 요약

### 1.1 기본 템플릿 (CLAUDE.md + rules/)

| 영역 | 현재 규약 |
|---|---|
| 디렉터리 구조 | `rules/{common,backend,frontend,languages}` 규칙 모듈을 CLAUDE.md가 @import. **앱 코드 디렉터리 규약은 아직 없음** (템플릿 상태) |
| 네이밍 | 함수는 동사 시작(공통 verb 표). Python `snake_case` / TS `camelCase`, TS 파일명 kebab-case, bool은 `is_`/`has_` |
| 응답 포맷 | `error-handling.md`: API 에러는 status code + message + context 포함, 구조화 로깅. `security.md`: 경계에서만 검증(Pydantic), 내부 재검증 금지 |
| 테스트 | AAA 패턴, 외부 의존(DB·API) mock, 내부 로직 mock 금지, 기능마다 테스트 동반 |
| Git/문서 | 커밋 영/한 병기 + 커밋 전 PROGRESS.md 갱신, README는 커밋이 무효화한 섹션만 즉시 갱신 |
| 배포 | Docker BuildKit + non-root, 설정 3분류(Environment/Tuning/Business constant), `.env` 소스 오브 트루스 |
| 프론트 | `identifiers.md`: 인터랙티브·상태 요소에 `data-testid="ComponentName-role"`, 리스트는 `-${id}` |

### 1.2 디자인 md (DESIGN-cohere.md)

Cohere 2026 **마케팅 웹사이트** 분석 문서. 토큰과 원칙은 견고하나 컴포넌트 대부분이 마케팅 전용.

- **토큰 4계층** — colors 20여 개(canvas white 중심 + deep-green/dark-navy 다크밴드 + action-blue/coral 액센트), typography 12단계(CohereText display / Unica77 body / CohereMono 기술 라벨), rounded 7단계(4~9999px), spacing 8단계(8px 베이스)
- **원칙** — flat(그림자 금지), 얇은 보더·rule 중심 구획, white canvas 기본, 대문자 mono 라벨, pill CTA, coral·blue는 액센트 한정(면색 금지)
- **컴포넌트 14종** — `button-*` 3종·`research-table`·`capability-card`는 앱에 전용 가능. `announcement-bar`, `hero-photo-card`, `trust-logo-strip`, `blog-filter-chip`, `footer-newsletter`, `dark-feature-band`, `product-card`, `contact-form-card` 등은 마케팅 전용
- **공백** — 데이터 시각화(그래프·노드·엣지) 언어 없음, 신뢰도/상태 표현 없음, 앱 셸(사이드바·패널) 없음

---

## 2. 개편안

### 2.1 유지

- 토큰 4계층 값 전부 (colors / typography / rounded / spacing)
- 디자인 원칙: white canvas 기본, flat + 보더 중심 elevation, CohereMono 기술 라벨, focus-blue 포커스 링
- 템플릿 규약 전부 (naming / error-handling / testing / git / config / docker)
- `identifiers.md` — ERD 노드·컨트롤에 그대로 적용 (`ErdCanvas-node-${objectId}` 등)
- 컴포넌트 중 앱 전용 가능: `button-primary`(pill), `button-secondary`(텍스트 링크), `button-pill-outline`(필터), `research-table`(객체 목록·파싱 실패 목록 화면), `capability-card`

### 2.2 변경

| 항목 | 변경 내용 | 이유 |
|---|---|---|
| 디자인 문서 체계 | `DESIGN-cohere.md`는 **원본 레퍼런스로 동결**, 앱 확장 토큰·ERD 시각 언어는 `rules/frontend/design-app.md` **신설**에 정의 | 원본 분석 문서 오염 방지, 확장분만 추적 가능 |
| 마케팅 컴포넌트 8종 | 앱 미사용 선언 (announcement-bar, hero-photo-card, trust-logo-strip, blog-filter-chip, footer-newsletter, dark-feature-band, product-card, contact-form-card) | 이 앱에 해당 표면 없음 |
| Display 타이포 | 96/72/60px 스케일 미사용, 앱 최대 `section-heading`(48) 이하 | 도구 화면에 마케팅 스케일 부적합 |
| 주석 규칙 | `comments.md`의 간결·why 원칙 유지하되, 코드 주석은 **EN/KO 이중 병기**로 작성 | 상세 계획 "코드 스타일" 지시 반영 |

### 2.3 추가

**(a) 앱 디렉터리 구조** — 아키텍처 경계(§2)와 어댑터 원칙(§4.1)을 구조로 강제:

```
backend/
  app/
    main.py
    api/          # FastAPI routers — ingest / objects / views / snapshots / validate / jobs / ai
    domain/       # lineage 재귀, 스코어링, confidence — pyodbc·httpx 금지 구역 (순수 로직)
    adapters/     # JoinValidator 구현체(Fake/Mssql), SOURCE_MODE 전환, AI 클라이언트
    models/       # 서비스 DB 모델 (snapshots, objects, columns, ...)
    schemas/      # Pydantic 요청/응답
  tests/
  requirements.txt / requirements-dev.txt
frontend/         # Next.js — 조회·시각화 전용
tools/            # fixture_gen.py (회귀 테스트 자산)
n8n/workflows/    # W1 워크플로 JSON (로직 없음, 수집만)
docs/
```

**(b) API 응답 규약** — `error-handling.md`를 구체화:

- 성공: 도메인 JSON 직접 반환 (envelope 없음)
- 에러: `{"error": {"code", "message", "context"}}` — context에 요청 파라미터 포함
- T3 백그라운드 작업: `POST → 202 {"job_id"}` + `GET /api/jobs/{id} → {"status", "progress"}` 폴링
- 계층 표기: T2/T3 트리거 엔드포인트는 응답에 `observed_at` 포함 (히스토리 §3.4 연동)

**(c) ERD 시각 언어** — §3에 상세.

---

## 3. ERD 시각 언어 (디자인 토큰 확장)

`design-app.md` 신설 문서에 들어갈 핵심 내용. **색상은 dataviz 검증 스크립트로 전 항목 PASS 확인 완료** (§3.3).

### 3.1 확장 토큰

```yaml
# 신뢰도 색 — 색만으로 구분 금지, 선 패턴·배지가 독립 인코딩 (§3.2)
colors:
  rel-confirmed: "#00926a"   # deep-green 램프의 선(line)용 밝은 단계 — 확정 (fk / confirmed)
  rel-inferred: "#1863dc"    # action-blue 재사용 — 추정 (검증 통과)
  rel-ai: "#9b60aa"          # form-focus 재사용 — AI 제안 (미검증)
  rel-unresolved: "#b30000"  # error 재사용 — 미해석 / 파싱 실패
  rel-lineage: "#93939f"     # muted 재사용 — view lineage (신뢰도 아님, 구조 채널)

typography:
  erd-table-name:            # 노드 헤더 — mono-label 축소판
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
  # 컬럼 행은 기존 micro(12px) 재사용 — 신규 토큰 최소화
```

### 3.2 노드·엣지 스펙

**노드** (flat 원칙 유지 — 그림자 금지, 보더로 상태 표현):

| 요소 | 스펙 |
|---|---|
| table 노드 | canvas bg + hairline 1px 보더 + rounded sm(8px), 헤더 `erd-table-name`, 컬럼 행 micro/ink, PK 행 키 아이콘, row_count는 caption/muted |
| view 노드 | soft-stone bg (기본 접힘, §1.5), 펼치면 lineage 엣지 노출 |
| 앵커/선택 | focus-blue 2px ring |
| 상태 배지 | `erd-badge` — `parse_failed`·`unresolved`(rel-unresolved 연한 배경), `저카디널리티`(muted, 사유 툴팁 §3.3), `AI`(rel-ai) |
| hover | 보더 ink 강조 (그림자 대신) |

**엣지 — 색 = 신뢰도, 패턴 = 종류, 배지 = 색 독립 보조 인코딩:**

| 상태 | 색 | 패턴 (2px) | 보조 인코딩 |
|---|---|---|---|
| 확정 — fk | `rel-confirmed` | 실선 | — |
| 확정 — 사용자 confirmed | `rel-confirmed` | 실선 | ✓ 배지 (fk와 구분) |
| 추정 — inferred | `rel-inferred` | 파선 8‑4 | 투명도 = confidence (아래) |
| AI 제안 — ai_suggested | `rel-ai` | 파선 3‑3 | `AI` 배지 필수 (§5.3) |
| 미해석 — unresolved | `rel-unresolved` | 일점쇄선 | ⚠ 배지 |
| view lineage | `rel-lineage` | 점선 1.5‑4 | 신뢰도 채널 아님 |

- **confidence 투명도는 3단계 스텝** — 1.0 / 0.7 / 0.45. 연속 투명도는 눈으로 비교 불가하고, 0.45 미만은 hairline과 혼동된다
- **staleness(§3.4 "오래된 결과 흐리게")는 엣지 투명도 재사용 금지** — confidence 인코딩과 충돌한다. 대안: `last_verified_at` 배지를 두고 임계(예: 90일) 초과 시 배지만 회색 처리. ⚠ 계획서 문구와 다른 지점이므로 승인 필요
- **N:M 교차 관계**(§3.2): FK 화살표 대신 양끝 무방향 + `N:M` 배지 — FK로 오독 방지
- 카디널리티 마커: 1:N은 N쪽 화살표. 크로우풋은 v1 미채택 (라이브러리 마커 제약 확인 후 재검토)

### 3.3 색상 검증 결과 (dataviz validator)

신뢰도 4색을 카테고리 세트로 `--pairs all`(동일 화면 공존) 검증:

```
[PASS] Lightness band       all 4 inside L 0.43–0.77
[PASS] Chroma floor         all 4 >= 0.1
[PASS] CVD separation       worst all-pairs #9b60aa↔#1863dc ΔE 9.3 (protan)
[PASS] Normal-vision floor  worst ΔE 17.9
[PASS] Contrast vs surface  all 4 >= 3:1
```

- `deep-green #003c33` 원본은 선 색으로 **탈락** (명도·채도 미달로 무채색처럼 읽힘) → 램프 확장 `#00926a` 선정 (후보 3종 중 tritan 여유 최대). `deep-green`은 배지 텍스트·다크밴드 등 면·텍스트 용도로 계속 유지
- `rel-lineage`(회색)는 의도적 recessive 중립 채널이라 카테고리 세트에서 제외 — 점선 패턴이 식별을 담당
- 탈락 후보: coral `#ff7759` (대비 2.55:1 미달), slate `#75758a` (채도 미달·violet과 CVD ΔE 4.7)
- 다크모드: **v1 라이트 전용 제안** — Cohere 시스템이 white canvas 중심이고, 다크 팔레트는 별도 검증·유지보수가 필요. 필요 시 후속 결정

---

## 4. 미결 사항 (후속 정지점에서 결정)

- **서비스 DB 선택** (SQLite vs PostgreSQL) — 정지점 2(DB 스키마)에서 제안. 라이브러리 추가는 승인 대상(금지사항)이므로 여기서 확정하지 않음
- **ERD 레이아웃 엔진** (ELK vs d3-force) — 정지점 6에서 검토 근거와 함께 보고 (§1.5)
- 프론트 그래프 렌더러 (React Flow 등) — 정지점 6에서 레이아웃 엔진과 함께 제안

## 5. 승인 요청 항목

1. 디렉터리 구조 (§2.3a)
2. `design-app.md` 신설 + DESIGN-cohere.md 동결 (§2.2)
3. 신뢰도 색·선·배지 체계 (§3.1–3.3) — 특히 `#00926a` 램프 확장
4. staleness 표현을 엣지 흐림 → 배지 회색으로 변경하는 안 (§3.2, 계획서 §3.4와 다름)
5. 다크모드 v1 제외 (§3.3)
6. API 응답 규약 (§2.3b)
