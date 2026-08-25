# LDAP 로그인 병행 + 개발 서버 배포 설계

작성일: 2026-08-26
브랜치: `feature/ldap-login` (`feature/multi-source-db` 위에 스택)

## 배경

지금 이 앱의 로그인은 **Keycloak 전용**이다. 브라우저가 OIDC 리다이렉트로 토큰을 받고
(`react-oidc-context`), 백엔드는 `app/auth.py:get_current_user`에서 Keycloak JWKS로 RS256을
검증한다. `AUTH_ENABLED=false`면 `X-Dev-User` 헤더를 신뢰하는데 이건 개발 전용 백도어다.

LDAP은 이미 있지만 **로그인용이 아니다.** `app/ad/client.py`는 서비스 계정
(`LDAP_BIND_DN`/`LDAP_BIND_CREDENTIALS`)으로 바인드해 사용자 목록을 **읽는** 용도다 — AD 동기화.
사용자 자격증명으로 바인드하는 경로가 없다.

요구는 두 가지이고 서로 독립이다: (A) 사용자가 Keycloak과 LDAP 중 골라 로그인, (B) 다른 포트에
개발 서버를 띄울 수 있는 설정 일체.

## 목표

- 로그인 화면에서 **Keycloak과 LDAP 중 사용자가 고른다.** 두 경로가 상시 동작한다.
- LDAP 경로는 **Keycloak이 죽어도 동작한다** — 백엔드가 직접 LDAP에 바인드하고 자체 토큰을 발급한다.
- 화이트리스트·sysadmin 게이트가 **경로와 무관하게 동일하게** 적용된다.
- 운영과 완전히 분리된 개발 스택을 다른 포트에 띄울 수 있다.

## 비목표

- **갱신 토큰·서버측 폐기.** 토큰 하나, 만료되면 다시 로그인. (사용자 확정)
- **비밀번호 변경·재설정.** 이 앱에서 하지 않는다. AD 쪽 일이다.
- **LDAP 그룹 → 권한 매핑.** sysadmin은 계속 `DBV_SYSADMINS` 환경변수가 정한다.
- **다중 인스턴스 안전한 잠금.** 현재 compose는 단일 인스턴스다 (§4에 한계 명시).
- **로그인 외 엔드포인트의 레이트 리밋.**
- **개발 스택이 운영 소스 DB에 닿는 것.** 기본은 합류하지 않는다.

## 확정 결정

| 갈림길 | 결정 | 이유 |
|---|---|---|
| 폴백의 의미 | **병행** — 사용자가 고른다 | 두 경로 상시 동작, Keycloak 장애 시에도 진입 가능 |
| 바인드 주체 | **백엔드 직결** | Keycloak에 의존하면 "폴백"이 성립하지 않는다 |
| 세션 수명 | **12시간 단일 토큰, 갱신 없음** | 사내 도구의 근무 패턴, 유출돼도 하루면 죽는다 |

---

## A. LDAP 로그인

### A.1 흐름 — search-then-bind

기존 코드를 재사용한다. 신규 함수는 하나뿐이다.

1. **검색** — `app/ad/client.py:fetch_user(login_id)`가 **서비스 계정**으로 바인드해 사용자를 찾고
   `RawUser.dn`을 준다. (이미 존재)
2. **바인드** — 그 `dn`으로 **사용자가 준 비밀번호**를 써서 다시 바인드한다. 성공/실패가 곧 인증
   결과다. (신규: `verify_credentials(dn, password) -> bool`)
3. **발급** — 성공하면 `sub=login_id`인 HS256 JWT를 발급한다.

`login_id`는 `RawUser.login_id` — **AD 동기화와 같은 출처**다. 그래서 화이트리스트와
`DBV_SYSADMINS`의 키가 정확히 맞는다.

바인드 연결은 **항상 닫는다** (`unbind()`), 성공·실패·예외 모두. 기존 `fetch_user`의 `finally`
관용을 따른다.

### A.2 엔드포인트

```
POST /api/auth/ldap-login
  body: {"login_id": str, "password": str}
  200:  {"access_token": str, "token_type": "bearer",
         "expires_at": "<ISO8601>", "login_id": str, "name": str | null}
  401:   자격증명 실패 (아래 A.3 참조)
  429:  시도 횟수 초과
  503:  LDAP 미설정 또는 SESSION_SECRET_KEY 미설정
```

`AUTH_LDAP_LOGIN_ENABLED=false`면 라우터가 아예 등록되지 않는다 — 404. 기능이 꺼진 배포에
엔드포인트가 존재하지 않는 편이 낫다.

### A.3 사용자 열거 방지

**사용자가 LDAP에 없는 경우와 비밀번호가 틀린 경우가 응답에서 구분되면 안 된다.**
둘 다 같은 401, 같은 본문:

```json
{"error": {"code": 401, "message": "login failed — check your ID and password", "context": {}}}
```

`context`에 `login_id`를 넣지 않는다. 로그에는 남긴다 (서버 로그는 운영자만 본다).

**타이밍은 정직하게 말한다.** 사용자가 없으면 바인드를 건너뛰므로 응답이 빠르다 — 이 차이를
완전히 없애려면 가짜 바인드를 보내야 하는데, 그건 LDAP에 쓰레기 트래픽을 증폭시킨다.
**타이밍 채널은 잔여 위험으로 수용하고, 실질적 통제는 §A.4의 잠금이 맡는다.** 없는 방어를
있는 척하지 않는다.

### A.4 무차별 대입 방어

인프로세스 카운터. `app/api/me.py:_last_sync_at`의 스로틀 관용을 따른다.

**축은 `login_id` 하나다.** 15분 창에 5회 실패하면 429(`Retry-After` 포함), 성공하면 초기화.

**IP축을 두지 않는 이유 — 백엔드가 클라이언트 IP를 볼 수 없다.** 이 배포는 프론트엔드가 단일
포트를 열고 `/api`를 프록시한다(README 배포 절). 따라서 백엔드가 보는 peer 주소는 **항상
프론트엔드 컨테이너**다. IP축을 만들면 두 결과 중 하나다: 전 사용자가 한 카운터를 공유해
**한 명의 오타가 전원을 잠그거나**, `X-Forwarded-For`를 신뢰해 **공격자가 헤더를 위조해 우회**한다.
없는 방어를 만드는 대신 축을 하나로 둔다. 실제 위협(동료 계정 추측)은 `login_id` 축이 막는다.

**한계를 명시한다**: 프로세스 재기동 시 초기화되고, 다중 인스턴스에서 공유되지 않는다.
현재 compose는 백엔드 단일 인스턴스라 실효가 있지만, 스케일아웃하면 이 방어는 약해진다.
그때는 공유 저장소(예: 서비스 DB 테이블)로 옮겨야 한다. 계정 전반을 훑는 스프레이 공격은
이 설계가 막지 않는다 — 그건 공유 카운터가 필요하고, 그 카운터는 그 자체로 전원 잠금 지렛대가 된다.

### A.5 토큰

```json
{"iss": "db-viewer", "sub": "<login_id>", "name": "<표시명>",
 "iat": <발급>, "exp": <iat + SESSION_TTL_HOURS>}
```

HS256, 키는 `SESSION_SECRET_KEY`. **비어 있으면 로그인 엔드포인트가 503** —
`SOURCE_SECRET_KEY`와 같은 fail-closed 관용이다. 약한 기본키로 조용히 서명하는 경로를 만들지 않는다.

### A.6 `get_current_user` 분기 — 알고리즘 혼동 차단

```
토큰의 iss를 미검증 디코드로 읽는다  ← 라우팅에만 쓴다
  iss == "db-viewer"  → HS256 + SESSION_SECRET_KEY 로 완전 검증
  그 외 / 없음        → 기존 Keycloak 경로 (RS256 + JWKS)
```

**두 경로 모두 `algorithms=[...]`를 명시적으로 고정한다.** 이게 핵심이다 — 고정하지 않으면
공격자가 `iss: "db-viewer"`를 주장하는 토큰을 다른 알고리즘으로 서명해 넣을 수 있다.
로컬 경로는 `["HS256"]`, Keycloak 경로는 기존대로 `["RS256"]`.

미검증 디코드 결과는 **라우팅 외 어떤 용도로도 쓰지 않는다.** 신원·권한은 전부 검증 후 클레임에서 온다.

토큰이 파싱조차 안 되면 기존과 같은 401.

### A.7 하류 게이트 — 변경 없음

`require_whitelisted`, `require_sysadmin`, `require_preview_admin`은 모두
`get_current_user` **하류**다. 따라서 **LDAP으로 들어와도 화이트리스트에 없으면 403**이고,
sysadmin 판정도 동일하다. 이 설계에서 그 파일들은 건드리지 않는다.

### A.8 감사

`AuditLog(action="ldap_login", detail="<login_id> ok" | "<login_id> fail", ...)`.
**비밀번호는 어디에도 남기지 않는다** — 로그·예외 메시지·감사 행 전부.
실패도 남긴다(인증 감사의 목적이 그것이다). 무차별 대입이 감사 테이블을 채우는 것은 §A.4의 잠금이 막는다.

### A.9 프론트엔드

- `/login` 카드에 **[Keycloak으로 로그인] 버튼과 사번·비밀번호 폼을 나란히.**
  각각 독립적으로 켜고 끈다:
  - LDAP 폼 — `NEXT_PUBLIC_LDAP_LOGIN_ENABLED === "true"`
  - Keycloak 버튼 — `NEXT_PUBLIC_KEYCLOAK_ISSUER`가 비어 있지 않을 때
- **`AuthProvider`/`UserManager` 생성도 같은 조건으로 감싸야 한다.** 지금
  `keycloak-login.ts:makeManager()`는 issuer가 있다고 가정한다 — 개발 스택에서 그 값을 비우면
  (§B.4) 모듈 로드 시점에 깨질 수 있다. 구현 단계에서 **빈 설정으로 실제 렌더해 확인**하고,
  못 견디면 Provider 자체를 조건부로 마운트한다.
- 둘 다 꺼진 배포는 로그인할 방법이 없다 — 그 조합은 화면에 명시적으로 알린다(조용한 빈 카드 금지).
- 성공 시 토큰을 `localStorage`에 저장하고 `setAuthToken()` 호출.
  **전송 경로는 안 바꾼다** — `api.ts:authHeaders()`가 이미 `Authorization: Bearer`를 보낸다.
- 앱 부팅 시 저장분을 읽어 만료 전이면 `setAuthToken()`.
- **만료 처리**: 갱신이 없으므로 만료된 토큰은 401을 받는다. `api.ts:handle()`이 유일한 응답
  깔때기이므로 거기서 **로컬 세션 401이면 저장분을 지우고 `/login`으로 보낸다.** 이게 없으면
  사용자가 12시간 뒤 정체불명의 오류를 본다.
- 로그아웃은 저장분 삭제. (Keycloak 세션 로그아웃은 기존 경로 그대로)

**`localStorage` 선택의 대가**: 탭을 닫아도 세션이 유지되는 대신 XSS 노출면이 탭 수명보다 길다.
`sessionStorage`면 반대다. 12시간 무갱신 토큰에는 전자가 맞다고 판단했다.

### A.10 설정 (신규 3개)

| 키 | 분류 | 기본 | 역할 |
|---|---|---|---|
| `AUTH_LDAP_LOGIN_ENABLED` | Environment | `false` | 라우터 등록 + 프론트 폼 노출 |
| `SESSION_SECRET_KEY` | Environment | `""` | HS256 서명 키. 비어 있으면 로그인 503 |
| `SESSION_TTL_HOURS` | Tuning | `12` | 토큰 만료 |

**기존 `LDAP_*` 7종을 재사용한다** — 새로 추가하지 않는다. `ldap_enabled` 프로퍼티(4종이 모두
있어야 true)가 그대로 전제 조건이 된다.

프론트는 `NEXT_PUBLIC_LDAP_LOGIN_ENABLED`가 추가로 필요하다 — **빌드 타임 인라인**이라
compose의 build args에 실어야 한다.

---

## B. 개발 서버 배포

### B.1 가장 중요한 함정

**`NEXT_PUBLIC_*`는 빌드 타임에 인라인된다.** README 트러블슈팅 표에도 있는 항목이다.
개발 서버는 `.env` 파일만 바꿔서 되는 게 아니라 **자기 이미지를 따로 빌드**해야 한다.

### B.2 독립 스택 (오버레이 아님)

`docker-compose-dev.yml`은 운영 compose의 오버레이가 아니라 **독립 스택**이다. 오버레이로 하면
같은 프로젝트 이름을 공유해 운영 컨테이너를 갈아치울 위험이 있다.

| 항목 | 값 | 이유 |
|---|---|---|
| `name:` | `dbviewer-dev` | 컨테이너·네트워크·볼륨 이름이 운영과 충돌하지 않게 |
| 공개 포트 | `.env.dev`의 `APP_PORT` | 운영과 다른 포트 |
| DB 볼륨 | `pgdata-dev` (별도) | **운영 데이터를 절대 공유하지 않는다** |
| 네트워크 서브넷 | `172.49.0.0/16` | 운영(172.48/16)과 소스 네트워크(172.50.x/24) 사이의 빈 자리 |
| env | `env_file: .env.dev` | |

### B.3 비밀 파일 취급 — 요청과 다르게 가는 지점

요청은 "`.env.dev` 작성해서 푸쉬"였다. **`.env.dev`를 커밋하지 않는다.**

대신:
- **`.env.dev.example`을 커밋한다** — 플레이스홀더만 든 템플릿
- **`.env.dev`를 `.gitignore`에 추가한다**

이유: `.env`가 이미 gitignore이고 (`rules/common/security.md`: 비밀을 절대 커밋하지 않는다),
`.env.dev`라는 이름으로 커밋 가능한 파일을 만들면 누군가 값을 채워 넣고 그대로 커밋한다.
운영자는 `cp .env.dev.example .env.dev` 후 채운다. **산출물은 그대로 얻고 사고 경로만 닫는다.**

### B.4 Keycloak 쪽 작업

개발 포트에 대해 **redirect URI와 Web origins를 등록해야 한다.** README가 "Web origins 누락이
최다 사고 원인"이라고 적은 항목이다. 별도 클라이언트를 파거나 기존 클라이언트에 URI를 추가한다 —
운영자 결정이며 런북에 절차를 적는다.

LDAP 로그인만 쓸 거라면 Keycloak 등록 없이 `AUTH_LDAP_LOGIN_ENABLED=true` +
`AUTH_ENABLED=true`로 띄울 수 있다. 그 경우 Keycloak 버튼은 눌러도 실패하므로,
**개발 스택에서는 `NEXT_PUBLIC_KEYCLOAK_*`를 비워 버튼을 숨기는 것**을 기본으로 한다.

### B.5 개발 스택과 소스 네트워크

기본은 **합류하지 않는다.** 개발 서버가 운영 서비스 DB에 닿지 않는 쪽이 안전하다.
필요해지면 `docker-compose-dev.yml`에 `dbv-*` external 네트워크를 추가한다 — 런북에 방법만 적는다.

---

## 오류 처리

- LDAP 서버 접속 실패(네트워크·TLS)는 **자격증명 실패와 구분**한다 — 503, "인증 서버에 연결할 수
  없습니다". 사용자가 비밀번호를 반복 입력하게 만들지 않는다.
- LDAP 예외의 원문을 응답에 싣지 않는다. `type(e).__name__`만, 전문은 `logger`에 `exc_info=True`.
  (이 저장소가 `objects.py`·`sources.py`에서 이미 쓰는 관용)
- 오류를 조용히 삼키지 않는다.

---

## 테스트 전략

**실제 LDAP 서버 없이 전부 테스트한다.** `fetch_user`와 `verify_credentials`를 몽키패치한다 —
`tests/test_auth.py:test_login_sync_is_throttled_per_user`가 이미 쓰는 관용이다.

| 대상 | 검증 |
|---|---|
| 토큰 | 발급→검증 왕복, 만료된 토큰 거부, `exp` 계산 |
| **알고리즘 고정** | `iss: "db-viewer"`를 주장하는 **RS256 서명 토큰이 거부**되는지 — 알고리즘 혼동 회귀 가드 |
| `iss` 라우팅 | 로컬 토큰 → 로컬 검증, Keycloak 토큰 → 기존 경로, 파싱 불가 → 401 |
| 열거 방지 | 없는 사용자와 틀린 비밀번호의 **응답 본문·상태가 동일** |
| 잠금 | 5회 실패 후 429, 성공 시 카운터 초기화, IP 축 별도 동작 |
| 하류 게이트 | LDAP 로그인 사용자가 **화이트리스트에 없으면 403** |
| 기능 플래그 | `AUTH_LDAP_LOGIN_ENABLED=false`면 엔드포인트 404 |
| 키 미설정 | `SESSION_SECRET_KEY=""`면 503 |
| 비밀번호 미노출 | 성공·실패·429·503 **모든 응답 본문에 비밀번호 문자열이 없다** (raw text 검사) |
| 프론트 | 토큰 저장·만료 판정 순수 함수 (vitest) |
| 회귀 | 기존 백엔드 426 / 프론트 123 그린 유지 |

**프론트엔드에 컴포넌트·E2E 테스트가 없다** — 이 저장소의 알려진 공백이다
(`2026-08-25-multi-source-db-design.md` §10 참조). 로그인 폼의 화면 동작은 자동 검증되지 않는다.
순수 로직만 vitest로 덮고, 그 한계를 여기 기록한다.

---

## 단계

| # | 내용 | 검증 |
|---|---|---|
| 1 | 설정 3종 + 토큰 발급·검증 유틸 | 왕복·만료·**알고리즘 고정** 단위 테스트 |
| 2 | `verify_credentials` + 로그인 엔드포인트 + 잠금 | 열거 방지·잠금·503·플래그 |
| 3 | `get_current_user` 분기 | 라우팅 3케이스 + 기존 Keycloak 테스트 그린 |
| 4 | 프론트 로그인 폼 + 저장 + 401 처리 | 순수 함수 vitest, 게이트 4종 |
| 5 | `.env.dev.example` + `docker-compose-dev.yml` + `.gitignore` + 런북 | `docker compose -f ... config -q` |

1~3은 백엔드만이라 독립적으로 검증 가능하다. 4가 붙어야 사람이 쓸 수 있다. 5는 A와 무관하다.

---

## 열린 항목

- **다중 인스턴스 잠금.** 스케일아웃하면 §A.4가 약해진다. 그때 공유 저장소로 옮긴다.
- **타이밍 채널.** §A.3의 잔여 위험. 완전한 해소는 별도 과제다.
- **개발 스택의 소스 네트워크 합류.** 필요해지면 그때 결정한다 (§B.5).
