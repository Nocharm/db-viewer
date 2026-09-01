# 서비스 담당자 전달용 — db-viewer 조회 연결 요청

각 서비스 담당자에게 보내는 작업 요청서. **db-viewer 운영자가 아래 ① 표를 채운 뒤**
문서 전체를 담당자에게 전달한다. 담당자는 ②를 눈으로 확인하고, ③을 자기 저장소에서
Claude Code에 그대로 붙여넣으면 된다.

관련 문서: 설계 `docs/superpowers/specs/2026-08-25-multi-source-db-design.md` /
배포 절차 `docs/connect-sources.md`

---

## 무엇을, 왜

사내 db-viewer(스키마 탐색·ERD·행 미리보기 도구)에서 여러분 서비스의 DB를 **읽기 전용으로**
조회하려 합니다. 지금은 사내 MSSQL만 보고 있는데, 같은 71번 서버에 도커로 떠 있는 다른
서비스 DB도 한자리에서 보려는 것입니다.

담당자에게 필요한 작업은 두 가지입니다.

1. DB 컨테이너를 **전용 브리지 네트워크 하나에 추가로 합류**시킨다
2. **읽기전용 DB 계정**을 하나 만들어 전달한다

**서비스 코드는 건드리지 않습니다.** 애플리케이션 수정, 라이브러리 추가, API 노출 전부
없습니다. 바뀌는 것은 `docker-compose.yml`의 네트워크 항목 몇 줄뿐입니다.

### 안 바뀌는 것 (자주 나오는 걱정)

| 걱정 | 사실 |
|---|---|
| 기존 subnet(172.36~46)이 바뀌나 | **안 바뀝니다.** 기존 `default` 네트워크 정의는 한 줄도 손대지 않습니다. 새 네트워크를 *추가로* 붙일 뿐입니다 |
| 데이터가 날아가나 | 데이터는 볼륨에 있고 건드리지 않습니다. 단 컨테이너를 1회 재생성하므로 **②에서 볼륨 여부를 반드시 확인**합니다 |
| 서비스가 오래 멈추나 | `docker compose up -d`로 in-place 재생성 — 해당 컨테이너만 수 초 |
| DB에 쓰기가 일어나나 | db-viewer는 `SELECT`만 실행합니다. 읽기전용 계정으로 이중으로 막습니다 |
| 다른 서비스 DB와 서로 보이게 되나 | **아니요.** 네트워크는 서비스마다 따로 만들고, 각 네트워크에는 db-viewer와 그 서비스 DB **둘만** 들어갑니다 |

---

## ① 채워서 전달할 값 (db-viewer 운영자가 작성)

> 아래 `<...>`를 실제 값으로 바꾼 뒤 담당자에게 보낼 것. 채우지 않은 채로 보내면
> 담당자가 임의로 정하게 되어 이름이 어긋난다.

| 항목 | 값 | 설명 |
|---|---|---|
| 서비스 키 | `<서비스키>` | 소문자·영숫자. 예: `svca` |
| 네트워크 이름 | `dbv-<서비스키>` | db-viewer 운영자가 **미리 만들어 둔다** |
| 네트워크 서브넷 | `172.50.<n>.0/24` | 서비스마다 다른 `<n>` (0, 1, 2, …) |
| DB 컨테이너의 compose 서비스명 | `<compose서비스명>` | 예: `postgres`, `db` |
| 네트워크 별칭 | `<서비스키>-db` | db-viewer가 이 이름으로 접속한다 |
| DB 엔진 | PostgreSQL / SQLite | |
| 읽기전용 계정명 | `dbviewer_ro` | |

**db-viewer 운영자가 먼저 할 일** (담당자에게 보내기 전):

```bash
docker network create --subnet 172.50.<n>.0/24 dbv-<서비스키>
```

> `docker network ls`로 기존 이름과 겹치지 않는지, `docker network inspect`로 서브넷이
> 기존 서비스 대역(172.36~46)과 db-viewer 자신의 대역(172.48.0.0/16)에 겹치지 않는지
> 확인한다.

**아직 안 했다면 `SOURCE_SECRET_KEY`도 미리 준비한다** (db-viewer `.env`, 소스 등록 API가
이 키 없이는 503) — 최초 1회만 생성하고 이후 안 바꾼다(키를 바꾸면 이미 등록된 소스의
비밀번호를 전부 다시 넣어야 한다):

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

값을 db-viewer `.env`의 `SOURCE_SECRET_KEY=`에 채우고 backend를 재기동한다. 담당자
작업과는 무관하지만, ⑥에서 회신받은 정보를 등록하려면 이 키가 먼저 있어야 한다.

---

## ② 담당자 사전 확인 (필수 — 건너뛰지 말 것)

작업은 **DB 컨테이너를 1회 재생성**한다. 데이터가 named volume에 있으면 무손실이지만,
볼륨 없이 컨테이너 레이어에 쓰고 있으면 그 순간 사라진다.

```bash
docker inspect -f '{{range .Mounts}}{{.Type}} {{.Name}} -> {{.Destination}}{{"\n"}}{{end}}' <DB컨테이너명>
```

- **출력에 DB 데이터 경로가 보이면** (예: `volume pgdata -> /var/lib/postgresql/data`) → ③으로 진행
- **출력이 비어 있으면** → **작업을 중단하고 db-viewer 운영자에게 알린다.** 그 서비스는
  지금 재기동만 해도 데이터가 사라지는 상태이므로, 연결보다 볼륨을 붙이는 게 먼저다

---

## ③ Claude Code에 붙여넣을 프롬프트

> 자기 서비스 저장소 루트에서 `claude`를 실행하고 아래 블록을 **통째로** 붙여넣는다.
> `<...>` 자리는 ①의 값으로 미리 치환해서 붙여넣을 것.

```text
우리 서비스의 docker-compose.yml을 수정해서, DB 컨테이너를 외부에서 이미 만들어 둔
전용 브리지 네트워크에 "추가로" 합류시켜 줘. 사내 db-viewer가 이 네트워크를 통해
우리 DB를 읽기 전용으로 조회할 예정이야.

## 값
- 합류시킬 네트워크 이름: dbv-<서비스키>   (이미 `docker network create`로 만들어져 있음)
- DB 컨테이너의 compose 서비스명: <compose서비스명>
- 그 네트워크에서 쓸 별칭: <서비스키>-db

## 반드시 지킬 것
1. 기존 `networks:` 블록의 `default` 정의(driver, ipam, subnet, gateway)를 절대 수정하지 마.
   subnet을 바꾸면 다른 서비스와 충돌한다. 새 네트워크를 항목으로 "추가"만 해.
2. DB 컨테이너 외의 다른 서비스는 이 네트워크에 넣지 마. db-viewer와 DB 둘만 있어야 한다.
3. `docker compose down`은 절대 실행하지 마. 네트워크까지 삭제되어 같은 compose의 다른
   서비스에 영향이 간다. 반영은 `docker compose up -d <compose서비스명>` 으로만 해.
4. 애플리케이션 코드, Dockerfile, 의존성은 건드리지 마. 변경은 docker-compose.yml 하나뿐이어야 한다.
5. 포트를 호스트로 새로 노출(`ports:`)하지 마. 같은 네트워크에 있으면 필요 없다.

## 작업 순서
1. docker-compose.yml을 읽고, DB 컨테이너가 현재 어떤 네트워크에 붙어 있는지 보고해.
   compose 파일이 여러 개면(override 포함) 전부 확인해.
2. 아래 형태로 수정안을 만들어서 diff를 먼저 보여줘. 내가 승인하면 적용해.

   services:
     <compose서비스명>:
       networks:
         default:                  # 기존 그대로 (원래 networks 키가 없었다면 default를 명시적으로 추가)
         dbv-<서비스키>:
           aliases: [<서비스키>-db]
   networks:
     default:
       ...기존 정의 그대로, 절대 수정 금지...
     dbv-<서비스키>:
       external: true

   주의: 원래 서비스에 `networks:` 키가 없었다면 compose는 default에 자동 연결한다.
   네트워크를 하나라도 명시하는 순간 자동 연결이 사라지므로 `default:`를 반드시 함께 적어야 한다.
   이걸 빠뜨리면 서비스가 서로 못 찾아서 장애가 난다.

3. 적용 후 `docker compose up -d <compose서비스명>` 으로 해당 컨테이너만 재생성해.
4. 검증하고 결과를 보고해:
   - `docker inspect -f '{{json .NetworkSettings.Networks}}' <DB컨테이너명>` — 기존 네트워크와
     dbv-<서비스키> 둘 다 있는지, 별칭이 붙었는지
   - 우리 서비스가 정상인지 (헬스체크 또는 앱 로그)
   - 기존 default 네트워크의 subnet이 그대로인지: `docker network inspect <프로젝트>_default`

작업 중 위 "반드시 지킬 것"과 충돌하는 상황이 나오면 진행하지 말고 나에게 물어봐.
```

---

## ④ 읽기전용 계정 만들기

### PostgreSQL

```sql
-- <강력한 비밀번호>는 직접 생성한다 (예: openssl rand -base64 24)
CREATE ROLE dbviewer_ro LOGIN PASSWORD '<강력한 비밀번호>';

GRANT CONNECT ON DATABASE <DB명> TO dbviewer_ro;
GRANT USAGE ON SCHEMA public TO dbviewer_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO dbviewer_ro;

-- 앞으로 만들어질 테이블에도 자동 적용 — 이게 없으면 마이그레이션 때마다 안 보인다
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO dbviewer_ro;
```

`public` 외의 스키마도 조회 대상이면 해당 스키마마다 `GRANT USAGE` / `GRANT SELECT` /
`ALTER DEFAULT PRIVILEGES`를 반복한다.

민감 테이블을 빼고 싶으면 `GRANT SELECT ON ALL TABLES` 대신 테이블을 열거해도 된다.
db-viewer 쪽에도 스키마 단위 허용 목록이 따로 있어 이중으로 통제된다.

**확인:**
```sql
-- 다른 세션에서 dbviewer_ro로 접속한 뒤
SELECT count(*) FROM <아무 테이블>;          -- 성공해야 한다
CREATE TABLE zzz_probe (id int);            -- 반드시 권한 오류가 나야 한다
```

### SQLite

계정 개념이 없다. 대신 **DB 파일이 든 볼륨 이름**을 알려주면 된다.

```bash
docker inspect -f '{{range .Mounts}}{{.Name}} -> {{.Destination}}{{"\n"}}{{end}}' <DB컨테이너명>
```

db-viewer가 그 볼륨을 `:ro`(읽기 전용)로 마운트하고, 파일도 `mode=ro`로 연다.
이 경우 ③의 네트워크 작업은 필요 없다 — 볼륨 이름과 컨테이너 내부 파일 경로만 회신하면 된다.

---

## ⑤ 완료 보고 양식

작업이 끝나면 아래를 채워 db-viewer 운영자에게 회신한다.
**비밀번호는 이 문서가 아니라 별도 보안 채널로 전달한다.**

```
서비스 키:            <서비스키>
엔진:                 PostgreSQL / SQLite

[PostgreSQL인 경우]
네트워크 별칭(host):  <서비스키>-db
포트:                 5432
DB명:                 <DB명>
계정:                 dbviewer_ro
비밀번호:             (별도 채널로 전달)
조회 대상 스키마:      public, ...

[SQLite인 경우]
볼륨 이름:            <볼륨명>
컨테이너 내부 파일 경로: /.../app.db

검증 결과:
- docker inspect 네트워크: 기존 + dbv-<서비스키> 확인  [ ]
- 기존 default subnet 무변경 확인                    [ ]
- 서비스 정상 동작 확인                              [ ]
- dbviewer_ro로 SELECT 성공 / CREATE 실패 확인       [ ]
```

---

## ⑥ (db-viewer 운영자) 회신받은 정보 등록하기

담당자의 ⑤ 회신을 받으면 `/admin` → 소스 패널에서 등록한다. 절차와 상세 트러블슈팅은
`docs/connect-sources.md` §7 — 여기서는 요점만.

1. **등록** — 이름·엔진(PostgreSQL/SQLite)·host(네트워크 별칭, 예: `svca-db`)·port·
   database·username·password(PostgreSQL) 또는 file_path(SQLite)를 입력해 저장.
2. **[연결 테스트]** — 저장 직후 반드시 누른다. **네트워크가 붙고 계정이 살아 있어도
   연결 자체는 항상 성공할 수 있다는 게 함정이다** — 여러 서비스가 `postgres`/`db` 같은
   흔한 컨테이너명을 쓰기 때문에, host를 잘못 넣어도(다른 서비스의 별칭이거나 오타여도)
   "어떤" postgres에는 붙어 연결 테스트가 초록으로 뜰 수 있다. 그래서 응답에 실린
   `database`(현재 붙은 DB명)와 `version`이 **회신받은 값과 정확히 일치하는지 눈으로
   대조**해야 한다 — 일치하지 않으면 host를 별칭으로 바로잡고 다시 테스트.
3. **[카탈로그 수집]** → **미리보기 허용 스키마 등록**까지 순서대로 진행 — 등록만으로는
   화면에 아무것도 안 열린다(기본 전부 차단).

---

## ⑦ 문제가 생기면

| 증상 | 원인·조치 |
|---|---|
| `network dbv-<서비스키> not found` | db-viewer 운영자가 아직 네트워크를 안 만들었다. ①의 `docker network create`부터 |
| 재기동 후 서비스가 서로 못 찾음 | `networks:`를 명시하면서 `default:`를 빠뜨렸다. ③의 2번 주의사항 참조 |
| `Pool overlaps with other one on this address space` | 서브넷 `172.50.<n>.0/24`가 이미 쓰이고 있다. db-viewer 운영자에게 다른 `<n>`을 요청 |
| db-viewer 연결 테스트가 엉뚱한 DB를 회신 | 여러 서비스가 `postgres` 같은 흔한 컨테이너명을 쓴다. 별칭(`<서비스키>-db`)이 제대로 붙었는지 확인 |
| DB 컨테이너에 볼륨이 없다 | **작업 중단.** 볼륨부터 붙이는 게 먼저다 (②) |
