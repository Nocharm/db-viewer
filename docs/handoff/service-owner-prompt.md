# 서비스 담당자 전달용 — db-viewer 조회 연결 요청

각 서비스 담당자에게 보내는 작업 요청서. **db-viewer 담당자가 아래 ① 표를 채운 뒤**
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

1. DB 컨테이너를 **db-viewer용 브리지 네트워크 하나에 추가로 합류**시킨다 (①에서 정한
   공유 `dbv-shared` 또는 전용 `dbv-<서비스키>`)
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
| 다른 서비스 DB와 서로 보이게 되나 | ①의 **네트워크 방식**에 따릅니다. *전용*이면 아니요 — 그 네트워크에는 db-viewer와 여러분 DB **둘만**. *공유*(`dbv-shared`)면 같은 네트워크의 다른 서비스 DB 컨테이너와 포트 수준에서 서로 닿습니다(각자 계정으로 보호). 닿으면 안 되는 DB라면 전용을 요청하세요 |

---

## ① 채워서 전달할 값 (db-viewer 담당자가 작성)

> 아래 `<...>`를 실제 값으로 바꾼 뒤 담당자에게 보낼 것. 채우지 않은 채로 보내면
> 담당자가 임의로 정하게 되어 이름이 어긋난다.

| 항목 | 값 | 설명 |
|---|---|---|
| 네트워크 방식 | 공유 / 전용 | 기본은 공유. 다른 서비스와 네트워크로 닿으면 안 되는 DB만 전용 (`docs/connect-sources.md` §1) |
| 서비스 키 | `<서비스키>` | 그 서비스를 가리키는 짧은 이름. 소문자·영숫자 (예: `payment`, `inventory`). 문패와 전용 네트워크 이름의 재료 |
| 네트워크 이름 | `dbv-shared` (공유) / `dbv-<서비스키>` (전용) | db-viewer 담당자가 **미리 만들어 둔다** — 공유는 이미 있음 |
| 네트워크 서브넷 (전용만) | `10.203.<n>.0/24` | 서비스마다 다른 번호. `10.203.0.0/24`는 공유, `10.203.1.0/24`는 첫 연결이 이미 사용 중이라 **`2`부터** |
| DB 컨테이너의 compose 서비스명 | `<compose서비스명>` | 예: `postgres`, `db` |
| 네트워크 별칭 | `<서비스키>-db` | db-viewer가 이 이름으로 접속한다. **공유 네트워크에서는 이 이름만이 여러분 DB를 구별한다** — 생략 불가 |
| DB 엔진 | PostgreSQL / SQLite | |
| 읽기전용 계정명 | `dbviewer_ro` | |

**db-viewer 담당자가 먼저 할 일** (담당자에게 보내기 전):

- **공유**: 할 일 없음 — `dbv-shared`는 처음 한 번 만들어 backend가 이미 합류해 있다
  (`docs/connect-sources.md` §1.1). 아직이라면 그 절차부터.
- **전용**: 네트워크를 만든다.

```bash
SVC_KEY=svca          # 서비스 키 (예시 — 실제 값으로)
N=2                   # 비어 있는 번호 (0=공유, 1=첫 연결이 사용 중)
docker network create --subnet "10.203.$N.0/24" "dbv-$SVC_KEY"
```

만든 **직후**, db-viewer `docker-compose.yml`의 `backend`를 그 네트워크에 합류시키고 재기동한다
(공유 `dbv-shared`는 이미 들어가 있어 이 단계가 없다):

```yaml
services:
  backend:
    networks: [dbviewer, dbv-shared, dbv-<서비스키>]   # 전용 서비스마다 한 줄씩
networks:
  dbv-<서비스키>: { external: true }
```

```bash
docker compose up -d backend      # db-viewer 서버에서
```

이걸 빠뜨리면 ⑥ 연결 테스트가 반드시 실패한다 (`docs/connect-sources.md` §6.2).

> `docker network ls`로 기존 이름과 겹치지 않는지, `docker network inspect`로 서브넷이
> 기존 서비스 대역(172.36~46)과 db-viewer 자신의 대역(172.48.0.0/16)에 겹치지 않는지,
> 그리고 다른 `dbv-*` 네트워크가 이미 쓰는 `10.203.<n>`과 겹치지 않는지 확인한다
> (`docs/connect-sources.md` §1의 조회 명령).

**아직 안 했다면 `SOURCE_SECRET_KEY`도 미리 준비한다** (db-viewer `.env`, 소스 등록 API가
이 키 없이는 503) — 최초 1회만 생성하고 이후 안 바꾼다(키를 바꾸면 이미 등록된 소스의
비밀번호를 전부 다시 넣어야 한다):

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

값을 db-viewer `.env`의 `SOURCE_SECRET_KEY=`에 채우고 backend를 재기동한다. 담당자
작업과는 무관하지만, ⑥에서 회신받은 정보를 등록하려면 이 키가 먼저 있어야 한다.

---

## ② 값 확인 → 변수 선언 → 볼륨 확인 (필수 — 건너뛰지 말 것)

**이 문서의 모든 명령은 여기서 만든 변수를 쓴다.** 명령 중간에 이름을 바꿔 넣을 곳이
없으니 블록째 복사해 붙여넣으면 된다. **한 터미널에서 이어서** 실행한다.

**손으로 채우는 건 두 줄뿐이다** — 둘 다 ① 표에서 받은 값을 그대로 옮긴다. 서비스 저장소
루트(`docker-compose.yml`이 있는 곳)에서:

```bash
export DBV_NET=dbv-shared     # 어느 네트워크에 합류시킬지 — 받은 값 그대로
export SVC_KEY=svca           # 별칭 이름의 재료 — 받은 값 그대로 (svca는 예시!)
```

**이 두 값이 어디에 쓰이나**

- `DBV_NET` — DB 컨테이너를 *추가로* 합류시킬 도커 네트워크. **그 네트워크에 든 컨테이너끼리만**
  서로 보인다. 호스트 포트를 새로 여는 게 아니라서 사내망·인터넷 쪽 노출은 변하지 않는다.
- `SVC_KEY` — 실제로 붙는 이름은 `$SVC_KEY-db`, 그 네트워크 안의 **별칭(alias)**이다.
  db-viewer는 IP가 아니라 이 이름으로 접속한다. 한 번 정하면 끝까지 따라간다:

  `SVC_KEY=shop` → 별칭 `shop-db` → ⑤ 회신의 host → 관리 콘솔 '호스트' 칸 → `shop-db:5432`로 접속

> **보이는 범위.** 별칭은 그 네트워크 안에서만 통하는 이름이다. 다만 **공유 네트워크**라면
> 같은 네트워크의 다른 서비스 컨테이너도 이 이름을 조회할 수 있다 — 접속은 각자 계정으로
> 막히지만, 이름이 겹치면 엉뚱한 DB에 붙으므로 **서비스마다 다른 키**여야 한다. 이름이
> 보이는 것 자체가 곤란한 DB라면 전용 네트워크를 요청한다(①).

**나머지는 자동이다.** DB 컨테이너·관리자 계정·DB명은 컨테이너에서 직접 읽고, 비밀번호는
`openssl`이 만든다. 이 블록은 고칠 곳이 없다.

```bash
export DB_CONTAINER=$(docker compose ps --format '{{.Name}} {{.Image}}' \
  | awk '/postgres|postgis/{print $1; exit}')
export DB_SERVICE=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$DB_CONTAINER")
env_of() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$DB_CONTAINER" | sed -n "s/^$1=//p"; }
export DB_SUPER=$(env_of POSTGRES_USER); export DB_SUPER=${DB_SUPER:-postgres}
export DB_NAME=$(env_of POSTGRES_DB);    export DB_NAME=${DB_NAME:-$DB_SUPER}
export RO_USER=dbviewer_ro
export DB_ALIAS="$SVC_KEY-db"
export RO_PASS=$(openssl rand -base64 24)
```

**값이 맞는지 기계가 확인한다.** 안 고쳤거나 잘못 잡혔으면 여기서 ❌로 드러난다.

```bash
ok(){ printf '✅ %s\n' "$1"; }; ng(){ printf '❌ %s\n' "$1"; }
[ -n "$DB_CONTAINER" ] && ok "DB 컨테이너  $DB_CONTAINER ($DB_SERVICE)" \
  || ng "DB 컨테이너를 못 찾았습니다 — docker compose ps 로 보고 아래처럼 직접 지정"
docker compose exec -T "$DB_SERVICE" psql -U "$DB_SUPER" -d "$DB_NAME" -Atc 'select 1' >/dev/null 2>&1 \
  && ok "DB 접속     $DB_SUPER@$DB_NAME" || ng "psql 접속 실패 — DB_SUPER / DB_NAME 을 직접 지정"
docker network inspect "$DBV_NET" >/dev/null 2>&1 \
  && ok "복도        $DBV_NET" || ng "네트워크 $DBV_NET 이 없습니다 — db-viewer 담당자에게 확인"
case "$SVC_KEY" in ''|svca) ng "서비스 키가 예시값($SVC_KEY) 그대로입니다 — 받은 값으로 바꾸세요";;
  *) ok "서비스 키   $SVC_KEY → 별칭 $DB_ALIAS";; esac
printf '비밀번호     %s\n' "$RO_PASS"
```

**SQLite 서비스라면** DB 컨테이너가 따로 없다 — `export DB_SERVICE=<앱 컨테이너의 compose 서비스명>`으로
지정하고 `DB_CONTAINER`는 아래 덮어쓰기 블록으로 채운 뒤, **DB 접속·네트워크 두 줄의 ❌는 무시한다**
(네트워크도 계정도 쓰지 않는다). ② 볼륨 확인과 ⑤ SQLite 회신만 하면 된다.

**✅ 네 줄이 다 떠야 다음으로 간다.** ❌를 안고 진행하면 엉뚱한 DB에 계정을 만들게 된다.
자동 감지가 틀렸다면(DB가 여럿이거나 이미지 이름이 특이할 때) 그 값만 덮어쓰고 확인을 다시 돌린다:

```bash
docker compose ps                 # SERVICE 열에서 DB를 고른다
export DB_SERVICE='여기에 SERVICE 값'
export DB_CONTAINER=$(docker compose ps -q "$DB_SERVICE" | head -1 \
  | xargs docker inspect -f '{{.Name}}' | sed 's|^/||')
export DB_NAME='여기에 DB명' DB_SUPER='여기에 관리자 계정'
```

변수는 이 터미널에서만 산다. 창을 닫았다면 위 세 블록을 다시 실행한다 — 단 계정을 이미
만든 뒤라면 `RO_PASS`는 새로 뽑지 말고 `export RO_PASS='아까 그 값'`으로 되살리고,
④의 `PROBE_TABLE` 한 줄도 다시 실행해야 ⑤ 회신의 읽기 확인이 제대로 찍힌다.

**볼륨 확인.** 작업은 **DB 컨테이너를 1회 재생성**한다. 데이터가 named volume에 있으면
무손실이지만, 볼륨 없이 컨테이너 레이어에 쓰고 있으면 그 순간 사라진다.

```bash
docker inspect -f '{{range .Mounts}}{{.Type}} {{.Name}} -> {{.Destination}}{{"\n"}}{{end}}' "$DB_CONTAINER"
```

- **출력에 DB 데이터 경로가 보이면** (예: `volume pgdata -> /var/lib/postgresql/data`) → ③으로 진행
- **출력이 비어 있으면** → **작업을 중단하고 db-viewer 담당자에게 알린다.** 그 서비스는
  지금 재기동만 해도 데이터가 사라지는 상태이므로, 연결보다 볼륨을 붙이는 게 먼저다

---

## ③ Claude Code에 붙여넣을 프롬프트

> 아래를 **터미널에** 붙여넣으면 ②의 변수가 채워진 프롬프트가 찍힌다. 그 출력을 복사해,
> 자기 서비스 저장소 루트에서 `claude`를 실행하고 붙여넣는다.

```bash
cat <<EOF
우리 서비스의 docker-compose.yml을 수정해서, DB 컨테이너를 외부에서 이미 만들어 둔
db-viewer용 브리지 네트워크에 "추가로" 합류시켜 줘. 사내 db-viewer가 이 네트워크를 통해
우리 DB를 읽기 전용으로 조회할 예정이야.

## 값
- 합류시킬 네트워크 이름: $DBV_NET   (이미 docker network create로 만들어져 있음)
- DB 컨테이너의 compose 서비스명: $DB_SERVICE
- DB 컨테이너 이름: $DB_CONTAINER
- 그 네트워크에서 쓸 별칭: $DB_ALIAS   (생략 불가 — 공유 네트워크에서는 이 이름으로만 우리 DB를 찾는다)

## 반드시 지킬 것
1. 기존 networks 블록의 default 정의(driver, ipam, subnet, gateway)를 절대 수정하지 마.
   subnet을 바꾸면 다른 서비스와 충돌한다. 새 네트워크를 항목으로 "추가"만 해.
2. 이 네트워크에는 우리 DB 컨테이너만 넣어. 앱 등 다른 컨테이너는 넣지 마.
3. docker compose down 은 절대 실행하지 마. 네트워크까지 삭제되어 같은 compose의 다른
   서비스에 영향이 간다. 반영은 docker compose up -d $DB_SERVICE 으로만 해.
4. 애플리케이션 코드, Dockerfile, 의존성은 건드리지 마. 변경은 docker-compose.yml 하나뿐이어야 한다.
5. 포트를 호스트로 새로 노출(ports:)하지 마. 같은 네트워크에 있으면 필요 없다.

## 작업 순서
1. docker-compose.yml을 읽고, DB 컨테이너가 현재 어떤 네트워크에 붙어 있는지 보고해.
   compose 파일이 여러 개면(override 포함) 전부 확인해.
2. 아래 형태로 수정안을 만들어서 diff를 먼저 보여줘. 내가 승인하면 적용해.

   services:
     $DB_SERVICE:
       networks:
         default:                  # 기존 그대로 (원래 networks 키가 없었다면 default를 명시적으로 추가)
         $DBV_NET:
           aliases: [$DB_ALIAS]
   networks:
     default:
       ...기존 정의 그대로, 절대 수정 금지...
     $DBV_NET:
       external: true

   주의: 원래 서비스에 networks 키가 없었다면 compose는 default에 자동 연결한다.
   네트워크를 하나라도 명시하는 순간 자동 연결이 사라지므로 default 를 반드시 함께 적어야 한다.
   이걸 빠뜨리면 서비스가 서로 못 찾아서 장애가 난다.

3. 적용 후 docker compose up -d $DB_SERVICE 으로 해당 컨테이너만 재생성해.
4. 검증하고 결과를 보고해:
   - docker inspect -f '{{json .NetworkSettings.Networks}}' $DB_CONTAINER — 기존 네트워크와
     $DBV_NET 둘 다 있는지, 별칭이 붙었는지
   - 우리 서비스가 정상인지 (헬스체크 또는 앱 로그)
   - 기존 default 네트워크의 subnet이 그대로인지: docker network inspect <프로젝트>_default

작업 중 위 "반드시 지킬 것"과 충돌하는 상황이 나오면 진행하지 말고 나에게 물어봐.
EOF
```

---

## ④ 읽기전용 계정 만들기

### PostgreSQL

비밀번호는 ②에서 `openssl`이 이미 만들어 뒀다 — 손으로 칠 값이 없다.

```bash
docker compose exec -T "$DB_SERVICE" psql -U "$DB_SUPER" -d "$DB_NAME" <<SQL
CREATE ROLE $RO_USER LOGIN PASSWORD '$RO_PASS';
-- 이미 있던 계정이어도 ⑤ 회신에 적히는 비밀번호와 실제를 맞춘다 (두 번 실행해도 안전)
ALTER ROLE $RO_USER LOGIN PASSWORD '$RO_PASS';

GRANT CONNECT ON DATABASE $DB_NAME TO $RO_USER;
GRANT USAGE ON SCHEMA public TO $RO_USER;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO $RO_USER;

-- 앞으로 만들어질 테이블에도 자동 적용 — 이게 없으면 마이그레이션 때마다 안 보인다
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO $RO_USER;
SQL
```

DB가 compose 밖이면 앞부분만 `psql "postgresql://$DB_SUPER@호스트:5432/$DB_NAME" <<SQL … SQL`
으로 바꾼다.

마지막 `ALTER DEFAULT PRIVILEGES`는 **그 명령을 실행한 계정(`$DB_SUPER`)이 앞으로 만들 테이블**에만
걸린다. 마이그레이션을 다른 롤로 돌린다면 그 롤로 한 번 더 실행한다 —
`ALTER DEFAULT PRIVILEGES FOR ROLE <그 롤> IN SCHEMA public GRANT SELECT ON TABLES TO $RO_USER;`

`public` 외의 스키마도 조회 대상이면 해당 스키마마다 `GRANT USAGE` / `GRANT SELECT` /
`ALTER DEFAULT PRIVILEGES`를 반복한다.

민감 테이블을 빼고 싶으면 `GRANT SELECT ON ALL TABLES` 대신 테이블을 열거해도 된다.
db-viewer 쪽에도 스키마 단위 허용 목록이 따로 있어 이중으로 통제된다.

**확인** — 읽기는 되고 쓰기는 막히는지:

```bash
# 읽기 확인용 테이블 하나를 잡아 둔다 (⑤ 회신에도 쓰인다)
export PROBE_TABLE=$(docker compose exec -T "$DB_SERVICE" psql -U "$DB_SUPER" -d "$DB_NAME" -Atc \
  "SELECT quote_ident(table_name) FROM information_schema.tables
     WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name LIMIT 1")

# 읽기 — 숫자가 나와야 정상
docker compose exec -T -e PGPASSWORD="$RO_PASS" "$DB_SERVICE" \
  psql -U "$RO_USER" -d "$DB_NAME" -Atc "SELECT count(*) FROM public.$PROBE_TABLE"

# 쓰기 — 실제로 시도하되 ROLLBACK이라 아무것도 남지 않는다
docker compose exec -T -e PGPASSWORD="$RO_PASS" "$DB_SERVICE" \
  psql -U "$RO_USER" -d "$DB_NAME" -q -v ON_ERROR_STOP=1 \
  -Atc 'BEGIN; CREATE TABLE zzz_probe(id int); ROLLBACK;'
```

| 쓰기 확인 결과 | 뜻 |
|---|---|
| `ERROR: permission denied for schema public` | ✅ 정상 — 읽기 전용이 제대로 걸렸다 |
| 아무것도 안 나오고 끝남 | ⚠ 쓰기가 허용돼 있다. **PostgreSQL 14 이하**는 `public` 스키마에 누구나 `CREATE`할 수 있는 게 기본값이라 흔하다. `ROLLBACK`이라 테이블은 남지 않았다. 막으려면 DB 소유자 판단으로 `REVOKE CREATE ON SCHEMA public FROM PUBLIC;` — 다른 앱이 그 권한에 기대지 않는지 먼저 확인. 그대로 두어도 db-viewer는 `SELECT`만 실행한다 |
| `psql: error: … FATAL` | ❓ 접속 자체가 안 된 것 — 권한 결과가 아니다. 계정·DB명을 다시 확인 |

`PROBE_TABLE`이 비어 나오면 `public`에 테이블이 아직 없다는 뜻이다 — 읽기 확인만 건너뛴다.
이 확인은 **권한만** 본다(컨테이너 안 접속은 비밀번호를 묻지 않는 게 기본) — 비밀번호가 실제로
맞는지는 db-viewer 쪽 [연결 테스트]에서 판명된다.

### SQLite

계정 개념이 없다. 대신 **DB 파일이 든 볼륨 이름**을 알려주면 된다.

```bash
docker inspect -f '{{range .Mounts}}{{.Name}} -> {{.Destination}}{{"\n"}}{{end}}' "$DB_CONTAINER"
```

db-viewer가 그 볼륨을 `:ro`(읽기 전용)로 마운트하고, 파일도 `mode=ro`로 연다.
이 경우 ③의 네트워크 작업은 필요 없다 — 볼륨 이름과 컨테이너 내부 파일 경로만 회신하면 된다.

---

## ⑤ 완료 보고 — 터미널 출력 그대로

**채울 양식이 없다.** 아래를 ②의 그 터미널에 붙여넣으면 회신에 필요한 값과 검증 결과가
한 번에 찍힌다. **찍힌 내용을 그대로 복사해** db-viewer 담당자에게 메일로 보낸다.
비밀번호도 그 안에 들어 있다 — `SELECT`만 가능한 전용 계정이라 메일 전달을 전제로 한다.

```bash
NETS=$(docker inspect "$DB_CONTAINER" \
  -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')
ALIAS_OK=$(docker inspect "$DB_CONTAINER" \
  -f "{{(index .NetworkSettings.Networks \"$DBV_NET\").Aliases}}" 2>/dev/null)
ALIAS_OK=${ALIAS_OK:-"❌ 아직 $DBV_NET 에 안 붙었습니다 (③)"}
READ_OK=$([ -n "$PROBE_TABLE" ] && docker compose exec -T -e PGPASSWORD="$RO_PASS" "$DB_SERVICE" \
  psql -U "$RO_USER" -d "$DB_NAME" -Atc "SELECT count(*) FROM public.$PROBE_TABLE" 2>&1 | tail -1 \
  || echo "(public에 테이블이 없어 건너뜀)")
WRITE_OUT=$(docker compose exec -T -e PGPASSWORD="$RO_PASS" "$DB_SERVICE" \
  psql -U "$RO_USER" -d "$DB_NAME" -q -v ON_ERROR_STOP=1 \
  -Atc 'BEGIN; CREATE TABLE zzz_probe(id int); ROLLBACK;' 2>&1)
case "$WRITE_OUT" in
  "") WRITE_BLOCKED="⚠ 쓰기가 허용돼 있습니다 (롤백해서 남진 않음 · PG14 이하 public 기본값일 수 있음)" ;;
  *"permission denied"*|*"must be owner"*|*"read-only"*)
      WRITE_BLOCKED="차단됨 — $(printf '%s' "$WRITE_OUT" | head -1)" ;;
  *)  WRITE_BLOCKED="❓ 확인 실패 — $(printf '%s' "$WRITE_OUT" | head -1)" ;;
esac

cat <<EOF
──── db-viewer 연동 회신 ────────────────────────
서비스 키:        $SVC_KEY
엔진:             PostgreSQL
네트워크:          $DBV_NET
host (별칭):      $DB_ALIAS
포트:             5432        (컨테이너 안쪽 번호)
DB명:             $DB_NAME
계정:             $RO_USER
비밀번호:          $RO_PASS
조회 대상 스키마:   public

검증
- 붙어 있는 네트워크: $NETS
- 별칭:             $ALIAS_OK
- 읽기 (행 수):      $READ_OK
- 쓰기 차단 확인:    $WRITE_BLOCKED
- 서비스 정상 동작:  (헬스체크/앱 로그 확인함)
─────────────────────────────────────────────
EOF
```

**SQLite**라면 네트워크·계정이 없으니 이것으로 대신한다:

```bash
export SQLITE_DIR=/app/data                  # 파일이 든 디렉터리 (= 볼륨 마운트 지점)
export SQLITE_PATH="$SQLITE_DIR/app.db"      # 컨테이너 안 파일 경로
export SQLITE_VOL=$(docker inspect "$DB_CONTAINER" \
  -f "{{range .Mounts}}{{if eq .Destination \"$SQLITE_DIR\"}}{{.Name}}{{end}}{{end}}")

cat <<EOF
──── db-viewer 연동 회신 (SQLite) ───────────────
서비스 키:        $SVC_KEY
엔진:             SQLite
볼륨 이름:         $SQLITE_VOL
컨테이너 내부 경로: $SQLITE_PATH
저널 모드:         $(docker compose exec -T "$DB_SERVICE" sqlite3 "$SQLITE_PATH" 'PRAGMA journal_mode;')
─────────────────────────────────────────────
EOF
```

저널 모드가 `wal`로 나오면 읽기 전용 열기가 실패할 수 있다 — 그대로 적어 회신하면
db-viewer 담당자가 등록 전에 확인한다.

---

## ⑥ (db-viewer 담당자) 회신받은 정보 등록하기

담당자의 ⑤ 회신을 받으면 `/admin` → *소스·수집* 탭에서 등록한다. 절차와 상세 트러블슈팅은
`docs/connect-sources.md` §7 — 여기서는 요점만.

> **비밀번호가 두 종류다.** 패널 상단의 *관리 비밀번호*는 db-viewer 설정값(`PREVIEW_ADMIN_PASSWORD`)이고,
> 폼 안의 *접속 비밀번호*는 ⑤ 회신에 적힌 `dbviewer_ro`의 것이다. 서로 다른 값이다.

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
| `network <네트워크이름> not found` | db-viewer 담당자가 아직 네트워크를 안 만들었다(전용) 또는 공유 네트워크가 아직 없다. ①의 "먼저 할 일"부터 |
| 재기동 후 서비스가 서로 못 찾음 | `networks:`를 명시하면서 `default:`를 빠뜨렸다. ③의 2번 주의사항 참조 |
| `Pool overlaps with other one on this address space` | (전용) 서브넷 `10.203.<n>.0/24`가 이미 쓰이고 있다. db-viewer 담당자에게 다른 `<n>`을 요청 |
| db-viewer 연결 테스트가 엉뚱한 DB를 회신 | 여러 서비스가 `postgres` 같은 흔한 컨테이너명을 쓴다 — 공유 네트워크에서는 별칭이 유일한 구별 수단이다. 별칭(`<서비스키>-db`)이 제대로 붙었는지 확인 |
| DB 컨테이너에 볼륨이 없다 | **작업 중단.** 볼륨부터 붙이는 게 먼저다 (②) |
