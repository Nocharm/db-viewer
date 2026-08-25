# 멀티 소스 연결 런북 — 사내 도커 서비스 DB를 db-viewer에 붙이기

사내 71번 서버에 도커로 떠 있는 **다른 서비스의 PostgreSQL/SQLite DB**를 db-viewer에서
읽기 전용으로 조회하기 위한 배포 절차. 사내 MSSQL(n8n 경유, 기존 소스)은 이 문서의 대상이
아니다 — 여기서 다루는 건 백엔드가 **직접 접속**하는 신규 소스뿐이다.

관련 문서: 설계 근거 `docs/superpowers/specs/2026-08-25-multi-source-db-design.md` §7 /
담당자에게 보낼 요청서 `docs/handoff/service-owner-prompt.md` / 기존 MSSQL 연결 런북
`docs/connect.md`(이 문서와 별개 — 그쪽은 정찰→수집→live 전환).

서비스 하나를 새로 연결할 때마다 1~7을 반복한다. 8부터는 db-viewer 쪽 1회 작업.

---

## 1. 네트워크 B′ — 서비스당 전용 브리지 네트워크

**결정: 조회 대상 서비스마다 전용 브리지 네트워크를 외부에서 만들고, db-viewer와 그 서비스
DB 컨테이너 둘만 그 네트워크에 넣는다.** 대상 서비스의 기존 `default` 네트워크 정의
(subnet 172.36~46 부근, 서비스마다 제각각)는 한 줄도 건드리지 않는다.

```bash
docker network create --subnet 172.50.<n>.0/24 dbv-<서비스키>
# 예: docker network create --subnet 172.50.0.0/24 dbv-svca
```

`<n>`은 서비스마다 다른 정수(0, 1, 2, …)로 겹치지 않게 관리한다. `172.50.x.0/24`는
기존 서비스 대역(172.36~172.46)에도, db-viewer 자신의 대역(`172.48.0.0/16`,
`docker-compose.yml` `networks.dbviewer` 참고)에도 겹치지 않는다.

### 왜 이 방식인가 (검토했던 대안)

설계 문서 §7에서 검토·기각한 두 대안:

- **A안 — db-viewer가 대상의 기존 `default` 네트워크에 합류.** 대상을 전혀 안 건드려
  가장 가볍지만 두 가지 문제로 탈락했다. (1) 여러 서비스가 DB 컨테이너를 `postgres`/`db`
  같은 흔한 이름으로 띄웠으면, backend가 여러 서비스의 `default`에 동시 합류한 순간
  이름 해석이 어느 쪽을 가리킬지 보장되지 않는다. (2) 대상 `default`는 대상 compose
  소유라, 대상이 `docker compose down` 되면 네트워크째 사라져 **db-viewer가 기동조차
  못 한다** — db-viewer의 가용성이 남의 compose 운영에 종속된다.
- **B안 — 공용 네트워크 하나에 모든 대상 DB.** (2)는 풀리지만, 서비스A DB와 서비스B DB가
  서로 네트워크로 닿게 된다. 조회 편의 하나 때문에 원래 있던 서비스 간 격리를 깨는 건
  맞바꿀 가치가 없다.
- **B′(채택) — 서비스당 전용 네트워크.** 대상 수정량은 B안과 같지만, 각 네트워크에
  db-viewer와 그 서비스 DB **둘만** 있어 서비스 간 격리가 유지된다. 별칭이 서비스마다
  고유하니 이름 충돌도 없고, 네트워크가 어느 compose에도 종속되지 않아 대상이
  `down` 되어도 db-viewer는 영향받지 않는다. 비용은 네트워크 개수뿐.

---

## 2. 대상 DB 컨테이너 볼륨 사전 확인 — 유일한 데이터 손실 위험 지점

B′는 대상 DB 컨테이너를 **1회 재생성**한다(`docker compose up -d`로 네트워크 항목만
추가). 데이터가 named volume에 있으면 재생성해도 무손실이지만, 볼륨 없이 컨테이너
레이어(rootfs)에만 쓰고 있으면 재생성 순간 데이터가 사라진다.

```bash
docker inspect -f '{{range .Mounts}}{{.Type}} {{.Name}} -> {{.Destination}}{{"\n"}}{{end}}' <DB컨테이너명>
```

- **출력에 DB 데이터 경로가 보이면** (예: `volume pgdata -> /var/lib/postgresql/data`)
  → 3으로 진행.
- **출력이 비어 있으면 → 그 서비스는 B′ 적용 금지.** 볼륨을 먼저 붙이거나(그 자체가
  별도 작업이고 이 문서의 범위 밖), 그 서비스만 예외적으로 다른 방식을 검토한다.
  **이 확인을 건너뛰고 진행하지 않는다.**

---

## 3. 대상 compose 수정

기존 `default` 네트워크 정의(driver, ipam, subnet, gateway)는 **그대로 두고**, DB
컨테이너 서비스에 네트워크 항목 하나와 고유 별칭만 추가한다.

```yaml
services:
  postgres:                    # 대상의 DB 컨테이너 서비스명 (예시)
    networks:
      default:                 # 기존 그대로 — 반드시 함께 적는다 (아래 함정 참고)
      dbv-svca:
        aliases: [svca-db]     # 서비스마다 고유해야 한다
networks:
  default:
    ...기존 정의 그대로, 절대 수정 금지...
  dbv-svca:
    external: true
```

**함정 — `default:`를 빠뜨리면 안 된다.** compose는 서비스에 `networks:` 키가 아예 없으면
`default` 네트워크에 자동으로 연결해 준다. 하지만 `networks:`를 하나라도 명시하는 순간
그 자동 연결이 사라진다 — 새 네트워크만 적고 `default:`를 안 적으면, 같은 compose의 다른
서비스들이 서로 이름으로 못 찾아 그 서비스 전체에 장애가 난다. 반드시 기존 `default`를
목록에 함께 적는다.

---

## 4. `docker compose up -d`로 in-place 재생성 — `down` 금지

```bash
docker compose up -d <DB컨테이너의-compose서비스명>
```

**`docker compose down`은 쓰지 않는다.** `down`은 네트워크까지 지우므로 같은 compose에
있는 다른 서비스(대상 서비스의 앱 컨테이너 등)에도 영향이 간다. `up -d`는 바뀐 서비스만
in-place로 재생성한다.

✅ 통과 기준:
```bash
docker inspect -f '{{json .NetworkSettings.Networks}}' <DB컨테이너명>
```
기존 네트워크와 `dbv-<서비스키>` 둘 다 보이고, 별칭이 붙어 있으면 통과. 대상 서비스 자체가
정상 동작하는지(헬스체크·앱 로그)도 확인한다.

---

## 5. 읽기전용 계정 발급 (PostgreSQL)

```sql
-- <강력한 비밀번호>는 직접 생성한다 (예: openssl rand -base64 24)
CREATE ROLE dbviewer_ro LOGIN PASSWORD '<강력한 비밀번호>';

GRANT CONNECT ON DATABASE <DB명> TO dbviewer_ro;
GRANT USAGE ON SCHEMA public TO dbviewer_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO dbviewer_ro;

-- 지금 존재하는 테이블만으로는 부족하다 — 이게 없으면 다음 마이그레이션으로 생긴
-- 테이블은 계속 안 보인다
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO dbviewer_ro;
```

`public` 외의 스키마도 조회 대상이면 스키마마다 `GRANT USAGE` / `GRANT SELECT` /
`ALTER DEFAULT PRIVILEGES`를 반복한다.

✅ 통과 기준 — 다른 세션에서 `dbviewer_ro`로 접속한 뒤:
```sql
SELECT count(*) FROM <아무 테이블>;   -- 성공해야 한다
CREATE TABLE zzz_probe (id int);     -- 반드시 권한 오류가 나야 한다
```

SQLite는 계정 개념이 없다 — db-viewer가 대상 볼륨을 `:ro`로 마운트하고 파일도
`mode=ro` URI로 열어(코드: `backend/app/sources/registry.py` `build_sa_url`) 이중으로
쓰기를 막는다. 이 경우 1~4의 네트워크 작업 자체가 필요 없다 — 볼륨 이름과 컨테이너
내부 파일 경로만 알면 된다.

---

## 6. db-viewer 쪽 배포

### 6.1 `SOURCE_SECRET_KEY` 생성

소스 접속 비밀번호는 Fernet으로 암호화해 DB에 저장한다. 이 키가 없으면 소스 등록
API가 **503**을 반환한다(`backend/app/sources/crypto.py` `CryptoNotConfigured`).
아직 안 만들었다면 최초 1회:

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

값을 `.env`의 `SOURCE_SECRET_KEY=`에 채운다. **이후 키를 바꾸면 그때까지 등록된 모든
소스의 비밀번호를 다시 입력해야 한다** (기존 암호문을 새 키로 복호화할 수 없다 —
`CryptoNotConfigured`가 아니라 복호화 실패로 소스가 통째로 붙지 않게 된다). 키 교체는
계획하지 말고 최초 1회만 생성해 유지한다.

`SOURCE_CONNECT_TIMEOUT`(기본 5초)·`SOURCE_QUERY_TIMEOUT`(기본 15초)은 튜닝값이라
보통 기본값으로 둔다 — 소스 DB가 유난히 느리면 늘린다.

### 6.2 compose에 네트워크 추가

`docker-compose.yml`의 `backend` 서비스에 대상 네트워크를 추가한다(SQLite면 볼륨
마운트도). `docker-compose.yml` 하단의 안내 주석을 참고해 실제 네트워크명·볼륨명으로
채운다:

```yaml
services:
  backend:
    networks: [dbviewer, dbv-svca]
    # SQLite 소스라면:
    # volumes: [svcc_data:/mnt/sources/svcc:ro]
networks:
  dbv-svca: { external: true }
# volumes:
#   svcc_data: { external: true, name: <서비스C_볼륨명> }
```

### 6.3 재기동 + 마이그레이션 확인

```bash
docker compose up -d --build backend
```

**반드시 이 컨테이너의 시작 로그에서 `alembic upgrade head` 출력을 눈으로 확인한다**
(`docker-compose.yml`의 `command`가 `alembic upgrade head && uvicorn ...`으로
기동 시마다 실행한다). 확인 방법:

```bash
docker compose logs backend | grep -i alembic
```

`Running upgrade ... -> 0017` (이 브랜치 시점 head)까지 오류 없이 찍혀야 한다.

> **왜 이걸 눈으로 봐야 하는가.** 이번 브랜치가 추가한 마이그레이션 0015~0017
> (`data_sources` 신설, 스냅샷에 소스 축 추가, 정책 테이블 PK 확장)은 개발 중
> **SQLite에서만** 왕복 검증됐다 — 이 개발 환경에 psql/docker가 없어 PostgreSQL에
> 실제로 실행해 본 적이 없다. SQL은 표준 Alembic 구성이라 문제없을 것으로 보이지만
> 그건 추론이지 실행 확인이 아니다. **실서버 첫 배포가 이 마이그레이션들이
> PostgreSQL에 처음 닿는 순간**이므로 로그를 스킵하지 않는다.
>
> **실패 시 롤백:**
> ```bash
> docker compose exec backend alembic downgrade 0014   # 이 브랜치 이전 상태로
> ```
> `0014`는 이 브랜치 시작 시점의 head다(`backend/alembic/versions/0014_column_sample_stats.py`).
> 다운그레이드 후 `docker compose up -d --build backend`로 이전 이미지를 다시 올린다.

✅ 통과 기준: `docker compose ps`에서 backend가 `healthy`, 로그에 alembic 오류 없음,
`curl -s http://<서버>:6678/api/health` → `{"status":"ok"}`.

---

## 7. `/admin`에서 등록 → 연결 테스트 → 수집 → 미리보기 허용 등록

`/admin` 화면(소스 패널)에서 순서대로 진행한다. 각 단계는 이전 단계가 눈으로 확인될
때까지 넘어가지 않는다.

1. **등록** — 이름·엔진(postgres/sqlite)·host·port·database·username·password
   (postgres) 또는 file_path(sqlite) 입력 후 저장.
   ✅ 통과 기준: 목록에 새 소스가 뜨고 `has_password: true`(postgres).
   `SOURCE_SECRET_KEY`가 비어 있으면 이 폼 자체가 안 뜨고 배너로 안내한다(503을 보고
   나서 알게 하지 않는다) — 뜨면 6.1이 이미 반영된 것.

2. **연결 테스트** — 등록한 소스 행의 [연결 테스트] 버튼.
   ✅ 통과 기준: 응답에 실린 `database`(현재 붙은 DB명)와 `version`이 **의도한 서비스와
   일치**하는지 반드시 눈으로 확인한다. **왜 이 확인이 중요한가** — 여러 서비스가
   `postgres`/`db` 같은 흔한 컨테이너명을 쓰므로, 네트워크 별칭이나 host 설정을
   잘못 넣어도 "어떤" postgres에는 붙어 **연결 자체는 성공**할 수 있다. 응답의 DB명이
   기대와 다르면 host를 네트워크 alias(예: `svca-db`)나 컨테이너 풀네임으로 바로잡는다.
   실패 시 502(소스 접속 실패, `host`/`database`/`error_type` 표시 — 자격증명·드라이버
   원문은 절대 응답에 안 실린다)와 503(이쪽 설정 문제 — 키 미설정 등)을 화면 메시지로
   구분해 보여준다.

3. **수집** — 소스 행의 [카탈로그 수집] 버튼(비관리 소스에만 뜬다).
   ✅ 통과 기준: 같은 화면의 수집 진행 패널에서 스냅샷이 `ready`로 끝나는 것을 확인.
   direct 소스(postgres/sqlite)는 뷰 의존 단계가 없어 이 한 번으로 끝난다(MSSQL 전용
   n8n W1b 단계는 direct 소스에서 자동 스킵).

4. **미리보기 허용 목록 등록** — 관리자 패널의 *미리보기 허용 스키마*에서 이 소스를
   선택하고 조회를 열 스키마를 추가(`PREVIEW_ADMIN_PASSWORD` 필요).
   ✅ 통과 기준: 브라우저에서 소스를 선택(`?source=`)한 뒤 그 스키마의 테이블 미리보기가
   값을 반환한다. 등록만으로는 아무것도 안 열린다 — 기본은 전부 차단이다.

**비활성 소스에서 되는 것 / 안 되는 것.** 소스를 끄면(`is_enabled=false`) **연결
테스트는 계속 되지만 미리보기·수집 트리거는 막힌다**(409, "disabled — enable it
before connecting"). 의도적 설계다 — 정상 운영 순서는 "자격증명을 고치고 → 테스트로
확인하고 → 재활성화"인데, 테스트까지 막으면 확인 없이 먼저 켜야 하는 반대 순서를
강제하게 된다(근거: `backend/app/sources/registry.py` `get_source`의
`allow_disabled` 분기, `backend/app/api/sources.py` `/test`).

---

## 8. 트러블슈팅

| 증상 | 확인 |
|---|---|
| 소스 등록이 503 | `SOURCE_SECRET_KEY` 미설정 — `.env` 채우고 backend 재기동 (6.1) |
| 연결 테스트가 엉뚱한 DB를 회신 | 여러 서비스가 같은 컨테이너명(`postgres`)을 씀 — host를 네트워크 alias나 컨테이너 풀네임으로 (7-2) |
| backend가 `network ... not found`로 기동 실패 | `dbv-<서비스>` 네트워크가 지워졌다 — `docker network create`로 다시 만든다 (1) |
| 대상 서비스 재기동 후 자기들끼리 못 찾음 | compose에 `networks:`를 명시하면서 `default:`를 빠뜨렸다 (3의 함정) |
| `Pool overlaps with other one on this address space` | 서브넷 `172.50.<n>.0/24`가 이미 쓰이는 중 — 다른 `<n>` 사용 |
| 연결 테스트가 502 | 소스 DB 자체 접속 실패(호스트·포트·자격증명) — 응답의 `error_type`과 backend 로그(`exc_info=True`로 전문 기록) 확인 |
| 연결 테스트가 503 | 소스 장애가 아니라 이쪽 설정 문제 — `SOURCE_SECRET_KEY` 미설정/키 불일치, 또는 engine이 postgres/sqlite가 아님 |
| 소스 삭제가 409 | 그 소스에 수집된 스냅샷이 있거나(스냅샷 1건이라도) 미리보기 허용목록·카테고리에 정책 행이 남아 있다 — 비활성화로 대체하거나 그 행들을 먼저 정리 |
| `alembic upgrade head`가 실패 | 6.3의 롤백 절차(`alembic downgrade 0014`)로 되돌리고 원인 조사 후 재시도. 절대 실패 상태로 backend를 계속 띄워두지 않는다 |
