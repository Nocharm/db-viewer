# 개발 스택 배포 런북

LDAP 로그인 등 새 기능을 운영 데이터에 손대지 않고 시험하기 위한 **독립** 개발 스택.
`docker-compose-dev.yml`은 운영 `docker-compose.yml`의 오버레이가 아니라 별도 compose
프로젝트(`dbviewer-dev`)다 — 컨테이너·볼륨·네트워크가 운영과 이름부터 갈라진다.
(Keycloak 로그인 흐름을 로컬에서 리허설하는 `docker-compose.local.yml`과는 목적이 다르다 —
그쪽은 운영 스택 위에 얹는 오버레이, `docs/local-test.md` 참고.)

## 1. `.env.dev` 만들기

`.env.dev.example`은 두지 않는다 — `.env.example`과 45개 키 중 40개가 같아 반드시 어긋난다.
아래 델타 표만큼만 바꾸고 나머지는 `.env.example` 값 그대로 둔다.

```bash
cp .env.example .env.dev
```

| 키 | 개발값 | 왜 |
|---|---|---|
| `DEV_APP_PORT` | 운영과 다른 포트 | dev compose 전용 신규 키 |
| `DATABASE_URL` | dev postgres를 가리키게 | 별도 DB (compose가 조립하므로 사실상 참고용 — 아래 §3 참고) |
| `POSTGRES_PASSWORD` | 다른 값 | |
| **`SESSION_SECRET_KEY`** | **새로 생성** | **운영과 공유하면 개발에서 발급한 토큰이 운영에서 통한다.** 생성: `python -c "import secrets; print(secrets.token_urlsafe(48))"` |
| **`SOURCE_SECRET_KEY`** | **새로 생성** | 개발 DB는 별도라 운영 암호문을 못 읽는다. 공유하면 개발 유출이 운영 소스 자격증명을 푼다. 생성: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `PREVIEW_ADMIN_PASSWORD` / `INGEST_API_KEY` | 다른 값 | |
| `AUTH_ENABLED` | `true` | LDAP 로그인을 시험하려면 켜야 한다 |
| `AUTH_LDAP_LOGIN_ENABLED` | `true` | |
| `KEYCLOAK_ISSUER` / `KEYCLOAK_CLIENT_ID` | 비움 또는 개발 전용 클라이언트 | 비우면 Keycloak 버튼이 숨는다 (§4) |
| **`N8N_WEBHOOK_BASE`** | **비움** | **개발 서버가 운영 n8n을 두들기지 않게** |
| `SOURCE_MODE` | `fixture` | |
| `DBV_SYSADMINS` | 본인 login_id | |

두 비밀 키를 굵게 쓴 이유: **운영 키를 그대로 복사하는 것이 가장 하기 쉬운 실수**이고,
`SESSION_SECRET_KEY`의 경우 그 결과가 "개발 서버에서 아무나 만든 토큰이 운영에서 유효"다.

`.env.dev`는 이미 `.gitignore`(`.env` 옆 `.env.dev`, 그리고 `.env.*` 와일드카드)에 걸려 있다 —
`.env`와 동일 취급(`rules/common/security.md`).

## 2. 띄우기

```bash
docker compose --env-file .env.dev -f docker-compose-dev.yml up -d --build
```

`--env-file .env.dev`가 compose 파일의 `${VAR}` 치환 소스다. 운영 compose와 함께 `-f`로
겹쳐 쓰지 않는다 — 이 파일은 독립 스택이라 그럴 이유도 없다.

## 3. `NEXT_PUBLIC_*`는 빌드 인라인

`NEXT_PUBLIC_AUTH_ENABLED` / `NEXT_PUBLIC_LDAP_LOGIN_ENABLED` / `NEXT_PUBLIC_KEYCLOAK_ISSUER` /
`NEXT_PUBLIC_KEYCLOAK_CLIENT_ID`는 Next.js가 **빌드 시점에 번들에 새겨** 넣는다. `.env.dev`를
고치고 `up -d`만 다시 실행하면 컨테이너는 재시작되지만 번들 안 값은 그대로다 — 화면에
바뀐 게 하나도 안 보이는데 설정 파일은 맞게 고쳤다면 대개 이 문제다. 반드시:

```bash
docker compose --env-file .env.dev -f docker-compose-dev.yml up -d --build
```

`--build`를 빼먹지 않았는지가 이 스택에서 가장 먼저 의심할 지점이다.

## 4. Keycloak 등록 (선택)

LDAP 로그인만 시험할 거라면 이 단계는 건너뛰고 `.env.dev`의 `KEYCLOAK_ISSUER`를 비워
Keycloak 버튼 자체를 숨긴다(§1) — `AUTH_ENABLED=true` + `AUTH_LDAP_LOGIN_ENABLED=true`만으로
로그인 화면에 사번·비밀번호 폼이 뜬다.

Keycloak 로그인도 함께 시험하려면 개발 포트(`DEV_APP_PORT`, 기본 6679)에 대해 Keycloak
클라이언트(`db-viewer-frontend` 또는 개발 전용 클라이언트) 설정에서:

- **Valid redirect URIs**에 `http://<호스트>:<DEV_APP_PORT>/*` 추가
- **Web origins**에 `http://<호스트>:<DEV_APP_PORT>` 추가 — 이걸 빼먹으면 토큰 교환이
  CORS로 막혀 로그인 복귀 시 "failed to fetch"류 에러가 난다(README 트러블슈팅 표와 동일 원인)
- Post-logout redirect URI에 `http://<호스트>:<DEV_APP_PORT>/login` 추가

## 5. 첫 기동 확인

개발 DB는 비어 있으므로 `alembic upgrade head`가 전체 마이그레이션 체인을 처음부터 돈다.
로그에서 확인:

```bash
docker compose -f docker-compose-dev.yml logs backend | grep -i alembic
```

체인이 끝까지 돌고 backend 헬스체크가 healthy로 넘어가는지(`docker compose -f docker-compose-dev.yml ps`)
확인한다. 중간에 멈추면 대개 이전 실행의 `pgdata-dev` 볼륨이 다른 스키마 버전으로 남아있는 경우다.

## 6. 첫 기동 스모크 체크

자동화 테스트가 커버하지 않는 화면 확인. 아래는 반드시 브라우저로 직접 연다.

> **`/login` 화면을 실제 브라우저로 한 번 연다.** 이 저장소의 프론트엔드 테스트는 순수 로직만
> 다루고 컴포넌트를 렌더하지 않으며, 앱이 `useMounted()` 가드로 클라이언트 트리를 하이드레이션까지
> 미루기 때문에 빌드도 SSR도 이 경로를 실행하지 않는다. `KEYCLOAK_ISSUER`를 비운 배포에서 화면이 뜨고
> 사번·비밀번호 폼이 보이는지 눈으로 확인한다. 콘솔에 오류가 없어야 한다.

함께 확인:

- LDAP 사번·비밀번호로 로그인 → `/erd` 또는 `/verify` 진입 성공
- 로그아웃 → 새로고침해도 재로그인되지 않음(세션이 실제로 지워졌는지)
- `KEYCLOAK_ISSUER`를 채운 배포라면 Keycloak 버튼도 동일하게 눈으로 한 번 확인

## 7. 정리

```bash
docker compose -f docker-compose-dev.yml down
```

개발 스택은 독립 프로젝트라 운영에 영향을 주지 않는다. `-v`를 붙이면 `pgdata-dev`까지
지워진다(개발 데이터 전부 삭제 — 운영 `pgdata`는 이름이 달라 영향 없음):

```bash
docker compose -f docker-compose-dev.yml down -v
```

## 8. 트러블슈팅

| 증상 | 확인 |
|---|---|
| 포트 충돌 (`bind: address already in use`) | `DEV_APP_PORT` 기본값(6679)이 다른 프로세스와 겹침 — `.env.dev`에서 `DEV_APP_PORT`를 다른 값으로 |
| 서브넷 충돌 (`Pool overlaps with other one on this address space`) | `172.49.0.0/16`이 이 호스트의 다른 Docker 네트워크와 겹침 — `docker network ls` + `docker network inspect`로 실제 사용 중인 대역 확인 후 `docker-compose-dev.yml`의 subnet을 조정 |
| `NEXT_PUBLIC_*`를 바꿨는데 화면이 그대로 | `--build` 없이 `up -d`만 실행함 (§3) — 반드시 `--build`로 재기동 |
| Keycloak 복귀 시 `failed to fetch` / `No matching state found` | 개발 포트에 **Web origins** 미등록 (§4) |
| 컨테이너는 healthy인데 로그인 폼이 안 보임 | `AUTH_LDAP_LOGIN_ENABLED=true`가 `.env.dev`에 있는지, 그리고 그 값으로 `--build`했는지 (§3) |
| `alembic upgrade head`가 안 끝남 | 이전 실행의 `pgdata-dev` 볼륨이 스키마 불일치 상태 — `down -v` 후 재기동으로 초기화 |

## 관련 문서

- 델타 표의 원본 설계 근거: `docs/superpowers/specs/2026-08-26-ldap-login-dev-deploy-design.md` §B
- 운영 배포·인증 전반: 루트 `README.md` `## 배포`, `## 인증`
- Keycloak을 곁들인 로컬 리허설(오버레이 방식): `docs/local-test.md`
