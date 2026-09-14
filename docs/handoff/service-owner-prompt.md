# 서비스 담당자 전달용 — db-viewer 조회 연결 요청

각 서비스 담당자에게 보내는 작업 요청서. **db-viewer 담당자가 아래 ① 표를 채운 뒤**
문서 전체를 담당자에게 전달한다. 담당자는 ②를 터미널에서 실행해 ✅를 확인하고, ③ 블록을
터미널에서 돌려 나온 출력을 자기 저장소의 Claude Code에 붙여넣으면 된다.

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
| 서비스가 오래 멈추나 | `docker compose up -d`로 in-place 재생성 — 해당 컨테이너만 수 초. 다만 **그 순간 앱의 DB 커넥션은 끊긴다**(재접속을 스스로 안 하는 앱이면 앱도 한 번 재기동). 한산한 시간대에 한다 |
| DB에 쓰기가 일어나나 | db-viewer는 `SELECT`만 실행합니다. 읽기전용 계정으로 이중으로 막습니다 — 여러분 테이블의 `INSERT`·`UPDATE`·`DELETE`는 DB가 거부합니다(`CREATE`는 PostgreSQL 15+ 기본에서 거부, 그 이하는 ④에서 확인) |
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
- **전용**: 네트워크를 만든다. 먼저 이미 쓰인 `dbv-*` 서브넷을 본다 — 출력이 비면 아직 하나도 없는 것.

```bash
for n in $(docker network ls --filter name=dbv- --format '{{.Name}}'); do docker network inspect -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}' "$n"; done
echo "── 사용 중인 dbv- 서브넷 끝 ──"
```

  아래 두 줄만 내 값으로 바꾼다 — `svca`는 예시 서비스 키, `N`은 위 목록에 없는 번호
  (`0`=공유, `1`=첫 연결이 사용 중이라 `2`부터). 성공하면 네트워크 ID와 ✅가 찍힌다.

```bash
SVC_KEY=svca
N=2
docker network create --subnet "10.203.$N.0/24" "dbv-$SVC_KEY" && echo "✅ dbv-$SVC_KEY (10.203.$N.0/24) 생성"
```

만든 **직후**, db-viewer `docker-compose.yml`의 `backend`를 그 네트워크에 합류시키고 재기동한다
(공유 `dbv-shared`는 이미 들어가 있어 이 단계가 없다). `networks:` 목록에는 전용 서비스마다
한 항목씩 늘어난다:

```yaml
services:
  backend:
    networks: [dbviewer, dbv-shared, dbv-<서비스키>]
networks:
  dbv-<서비스키>: { external: true }
```

db-viewer 서버에서:

```bash
docker compose up -d backend && docker compose ps backend
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

> **이 절차가 다루는 범위** — 같은 서버의 **docker compose로 떠 있는 PostgreSQL/SQLite**다.
> DB가 다른 서버에 있거나(RDS 등) MySQL·Oracle이면 자동 감지가 실패한다. 그 경우 여기서 멈추고
> db-viewer 담당자와 방식을 먼저 정한다.

**이 문서의 모든 명령은 여기서 만든 변수를 쓴다.** 명령 중간에 이름을 바꿔 넣을 곳이
없으니 블록째 복사해 붙여넣으면 된다. **한 터미널에서 이어서** 실행한다. 여러 줄짜리 로직은
`cat > 파일 <<'SH' … SH`로 파일에 저장한 뒤 실행하는 모양이다 — 붙여넣는 동안 아무것도
실행·치환되지 않아 SSH·tmux 어디서 붙여넣어도 안전하다. **블록마다 반드시 결과(✅/❌ 또는
값)가 찍힌다** — 아무 출력이 없다면 붙여넣기가 잘못된 것이다.

**손으로 채우는 건 두 줄뿐이다** — 둘 다 ① 표에서 받은 값을 그대로 옮긴다. `svca`는
예시라서 그대로 두면 아래 자가진단이 ❌를 낸다.

```bash
export DBV_NET=dbv-shared
export SVC_KEY=svca
echo "DBV_NET=$DBV_NET SVC_KEY=$SVC_KEY"
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

**나머지는 자동이다 — 자가진단까지 한 번에.** 아래 블록은 `dbv-setup.sh`를 저장하고 바로
실행한다. 고칠 곳이 없고, **어느 디렉터리에서 실행해도 된다**: compose 파일이 있는 디렉터리면
그 프로젝트 안에서, 아니면 이 서버 전체에서 DB 컨테이너(postgres 계열 이미지)를 찾고, **찾은
컨테이너의 compose 라벨에서 서비스명·프로젝트 이름·compose 파일 조합(`-f` 여러 개 포함)을
읽어 `COMPOSE_PROJECT_NAME`·`COMPOSE_FILE`로 export** 한다. 이후 이 터미널의 모든
`docker compose` 명령은 `-f`/`-p` 없이도 실제 떠 있는 조합을 그대로 쓴다 — 다른 파일 조합으로
컨테이너가 재생성되는 사고가 원천에서 막힌다. 관리자 계정·DB명은 컨테이너 env
(`POSTGRES_USER`·`POSTGRES_DB`)에서 읽고, 비밀번호는 `openssl`이 만든다. 마지막 줄이 `bash`가
아니라 `.`(source)인 이유는 변수를 이 터미널에 남기기 위해서다.

```bash
cat > dbv-setup.sh <<'SH'
# db-viewer 연동 — 값 자동 감지 + 자가진단
# 변수를 이 터미널에 남겨야 하므로 bash 가 아니라 . (source) 로 실행한다
ok(){ printf '✅ %s\n' "$1"; }
ng(){ printf '❌ %s\n' "$1"; DBV_NG=$((DBV_NG+1)); }
wn(){ printf '⚠️ %s\n' "$1"; }
noise(){ grep -vE '^time=|^WARN'; }
lbl(){ docker inspect -f "{{index .Config.Labels \"$1\"}}" "$DB_CONTAINER" 2>/dev/null; }
env_of(){ docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$DB_CONTAINER" 2>/dev/null | sed -n "s/^$1=//p"; }
DBV_NG=0
PG='postgres|postgis|timescale|pgvector'

# 1) DB 컨테이너 — 직접 지정(DB_CONTAINER) > 서비스명 지정(DB_SERVICE) > 자동(현재 디렉터리의 compose 프로젝트 > 이 서버 전체)
PICKED=manual
if [ -n "$DB_CONTAINER" ]; then
  :
elif [ -n "$DB_SERVICE" ]; then
  DB_CONTAINER=$(docker compose ps --format '{{.Name}}' "$DB_SERVICE" 2>/dev/null | head -1)
else
  PICKED=project
  DB_CONTAINER=$(docker compose ps --format '{{.Name}} {{.Image}}' 2>/dev/null | awk -v re="$PG" '$0 ~ re {print $1; exit}')
  if [ -z "$DB_CONTAINER" ]; then
    PICKED=host
    DB_CONTAINER=$(docker ps --format '{{.Names}} {{.Image}}' | awk -v re="$PG" '$0 ~ re {print $1; exit}')
  fi
fi
export DB_CONTAINER

# 2) 실행 중인 컨테이너의 compose 라벨에서 서비스명·프로젝트·파일 조합을 읽어 그대로 재사용
#    이후의 docker compose 명령은 어느 디렉터리에서 쳐도 같은 스택을 가리킨다
s=$(lbl com.docker.compose.service);              [ -n "$s" ] && export DB_SERVICE=$s
p=$(lbl com.docker.compose.project);              [ -n "$p" ] && export COMPOSE_PROJECT_NAME=$p
f=$(lbl com.docker.compose.project.config_files | tr ',' ':'); [ -n "$f" ] && export COMPOSE_FILE=$f

# 3) 관리자 계정·DB명 — 컨테이너 env 가 있으면 그것, 없으면 직접 지정한 값, 그것도 없으면 기본값
v=$(env_of POSTGRES_USER); export DB_SUPER=${v:-${DB_SUPER:-postgres}}
v=$(env_of POSTGRES_DB);   export DB_NAME=${v:-${DB_NAME:-$DB_SUPER}}
export RO_USER=dbviewer_ro
export DB_ALIAS="$SVC_KEY-db"
# 비밀번호는 처음 한 번만 뽑는다 — 다시 실행해도 안 바뀐다
export RO_PASS=${RO_PASS:-$(openssl rand -base64 24)}

# 4) 자가진단
echo "── 자가진단 ──"
if [ -n "$DB_CONTAINER" ] && docker inspect "$DB_CONTAINER" >/dev/null 2>&1; then
  ok "DB 컨테이너   $DB_CONTAINER (서비스 $DB_SERVICE · 프로젝트 ${COMPOSE_PROJECT_NAME:-?})"
else
  ng "DB 컨테이너를 못 찾았습니다 (컨테이너 '$DB_CONTAINER' / 서비스 '$DB_SERVICE') — 아래 '직접 고르기'"
fi
if [ -n "$COMPOSE_FILE" ]; then
  ok "compose 파일  $COMPOSE_FILE"
  [ -n "$COMPOSE_ENV_FILES" ] && ok "env 파일      $COMPOSE_ENV_FILES"
else
  ng "compose 라벨이 없습니다 — docker compose 로 띄운 컨테이너가 아니면 이 안내서 범위 밖입니다"
fi
if docker exec "$DB_CONTAINER" psql -U "$DB_SUPER" -d "$DB_NAME" -Atc 'select 1' >/dev/null 2>&1; then
  ok "DB 접속       $DB_SUPER@$DB_NAME"
else
  ng "psql 접속 실패 ($DB_SUPER@$DB_NAME) — 아래 '직접 고르기'에서 DB_SUPER / DB_NAME 지정"
fi
if docker network inspect "$DBV_NET" >/dev/null 2>&1; then
  ok "복도          $DBV_NET"
else
  ng "네트워크 '$DBV_NET' 이 없습니다 — db-viewer 담당자에게 확인"
fi
case "$SVC_KEY" in
  ''|svca)      ng "서비스 키가 예시값('$SVC_KEY') 그대로입니다 — 받은 값으로 바꾸세요" ;;
  *[!a-z0-9-]*) ng "서비스 키에 소문자·숫자·- 외의 글자가 있습니다 ('$SVC_KEY') — 문패로 못 씁니다" ;;
  *)            ok "서비스 키     $SVC_KEY → 문패 $DB_ALIAS" ;;
esac
n=$(docker compose ps --format '{{.Image}}' 2>/dev/null | grep -cE "$PG")
if [ "$PICKED" = host ]; then
  hn=$(docker ps --format '{{.Image}}' | grep -cE "$PG")
  [ "$hn" -gt 1 ] && wn "현재 디렉터리에 compose 프로젝트가 없어 이 서버 전체에서 골랐습니다 — DB 후보 ${hn}개 중 첫 번째. 프로젝트 이름이 우리 서비스가 맞는지 확인"
fi
if [ "$n" -gt 1 ]; then
  wn "이 프로젝트에 DB 후보가 ${n}개 — 위 컨테이너가 맞는지 확인, 아니면 아래 '직접 고르기'"
else
  ok "DB 후보       ${n}개"
fi
if DRY=$(docker compose up -d --dry-run "$DB_SERVICE" 2>&1); then
  case "$DRY" in
    *Recreate*) ng "compose 로 다시 올리면 컨테이너가 재생성됩니다 (파일·env 와 실행 중인 설정이 다름) — 아래 '재생성 경고'" ;;
    *)          ok "재생성 영향   이번 변경분만" ;;
  esac
else
  ng "docker compose 가 이 스택을 못 읽습니다 — $(printf '%s\n' "$DRY" | noise | head -1)"
fi
printf '비밀번호      %s\n' "$RO_PASS"
if [ "$DBV_NG" -eq 0 ]; then
  export DBV_READY=1
  ok "모두 통과 — 다음(볼륨 확인)으로"
else
  unset DBV_READY
  printf '❌ %s개 — 위 안내대로 고친 뒤 다시:  . ./dbv-setup.sh\n' "$DBV_NG"
fi
SH
. ./dbv-setup.sh
```

**❌가 하나도 없어야(마지막 줄 `✅ 모두 통과`) 다음으로 간다.** 뒤의 블록들은 이 통과 표시가
없으면 ❌ 한 줄만 찍고 아무것도 하지 않는다 — ❌를 안고 진행하면 엉뚱한 DB에 계정을 만들게
되기 때문이다. ❌는 그 줄의 안내대로 고친 뒤 `. ./dbv-setup.sh`만 다시 실행한다. ⚠️는 멈추라는
뜻이 아니라 눈으로 한 번 확인하라는 표시다(예: DB 후보가 여럿일 때 고른 컨테이너가 맞는지,
서버 전체에서 골랐을 때 프로젝트 이름이 우리 것인지).

> **재생성 경고 — 「compose 로 다시 올리면 컨테이너가 재생성됩니다」가 뜨면 멈춘다.**
> `docker compose up -d`는 네트워크 한 줄만 반영하는 게 아니라 **파일·env와 실제의 차이를
> 전부** 적용한다. 원인은 셋 중 하나다.
> - (a) compose 파일 조합이 다르다 — 컨테이너 라벨에서 읽어 자동으로 맞추므로 보통 아니다.
> - (b) **띄울 때 `--env-file`로 준 env 파일을 지금 안 주고 있다** — 가장 흔하다. env 파일은
>   라벨에 남지 않는다. `export COMPOSE_ENV_FILES=/절대경로/.env.prod` 후 `. ./dbv-setup.sh`를
>   다시 돌리면 `✅ env 파일`이 찍히고 재생성 경고가 사라져야 한다 (Compose 2.24+에서 동작 —
>   `docker compose version`으로 확인. 그 미만이면 이 문서의 compose 명령마다 `--env-file`을
>   붙여야 하므로 compose를 올리는 편이 낫다).
> - (c) 정말로 밀린 변경이 있다 — 파일에는 `postgres:16`인데 실제로는 14가 돌고 있으면 그
>   순간 메이저 업그레이드가 걸려 DB가 안 뜬다. 멈추고 db-viewer 담당자와 상의한다.

**직접 고르기** — 자동 감지가 엉뚱한 컨테이너를 잡았거나(DB가 여럿, 이미지 이름이 특이)
못 찾았을 때. 서비스명으로 고른다 (첫 줄이 SERVICE·IMAGE 목록을 보여 준다):

```bash
docker compose ps --format '{{.Service}}  {{.Image}}'
export DB_SERVICE='여기에 SERVICE 값'
unset DB_CONTAINER
. ./dbv-setup.sh
```

compose 프로젝트를 아예 못 찾으면 컨테이너 이름으로 직접 고른다 — 라벨은 컨테이너에서
읽으므로 나머지는 그대로 자동이다:

```bash
docker ps --format '{{.Names}}  {{.Image}}'
export DB_CONTAINER='여기에 NAMES 값'
unset DB_SERVICE
. ./dbv-setup.sh
```

관리자 계정·DB명이 잘못 잡히면(엔진이 달라 env 이름이 다를 때) 그 둘만 지정하고 다시 돌린다:

```bash
export DB_SUPER='관리자 계정'
export DB_NAME='DB명'
. ./dbv-setup.sh
```

**SQLite 서비스라면** DB 컨테이너가 따로 없다 — 위 "컨테이너 이름으로" 블록에 **앱 컨테이너**
이름을 넣고, **DB 접속·복도 두 줄의 ❌는 무시한다**(네트워크도 계정도 쓰지 않는다). `모두 통과`가
안 떠도 아래 볼륨 확인과 ⑤ SQLite 회신은 실행된다(둘은 통과 표시를 보지 않는다).

변수는 이 터미널에서만 산다. 창을 닫았다면 값 두 줄과 `dbv-setup.sh` 블록을 다시 실행한다 —
비밀번호가 새로 뽑히므로, 계정을 이미 만든 뒤라면 ④ `dbv-grant.sh`도 다시 실행해 DB의
비밀번호를 새 값으로 맞춘다(⑤ 회신은 비밀번호가 실제로 맞는지 TCP 접속으로 확인하므로,
안 맞으면 ❌로 드러난다).

**볼륨 확인.** 작업은 **DB 컨테이너를 1회 재생성**한다. 데이터가 named volume에 있으면
무손실이지만, 볼륨 없이 컨테이너 레이어에 쓰고 있으면 그 순간 사라진다.

```bash
[ -n "$DB_CONTAINER" ] && docker inspect -f '{{range .Mounts}}{{.Type}} {{.Name}} -> {{.Destination}}{{"\n"}}{{end}}' "$DB_CONTAINER" | grep . || echo "❌ 볼륨을 못 읽었습니다 — DB_CONTAINER 가 비었거나(위 블록부터) 마운트가 하나도 없습니다(작업 중단)"
```

| 출력 | 뜻 |
|---|---|
| `volume pgdata -> /var/lib/postgresql/data` (사람이 읽을 수 있는 이름) | ✅ 이름 붙은 볼륨 — ③으로 진행 |
| `volume 1fd6b73f…959cd -> …` (64자 16진수) | ⚠ **익명 볼륨**. 이번 `up -d`로는 살아남지만 누군가 `docker compose down -v`를 치면 사라지는 상태다. 진행하되 **이 사실을 ⑤ 회신에 함께 적는다** |
| DB 데이터 경로가 아예 안 보임 | ❌ **작업 중단**, db-viewer 담당자에게 알린다. 연결보다 볼륨을 붙이는 게 먼저다 |

공식 postgres 이미지는 볼륨을 안 붙여도 익명 볼륨이 자동 생성되므로 "출력이 비는" 경우는
드물다 — **64자 해시 이름이 위험 신호**다.

---

## ③ Claude Code에 붙여넣을 프롬프트

> 아래를 **②의 그 터미널에** 붙여넣으면 변수가 채워진 프롬프트가 찍힌다(자가진단을 통과하지
> 않았으면 ❌ 한 줄만 나온다). 그 출력을 복사해, **같은 터미널에서** `claude`를 실행하고
> 붙여넣는다 — 같은 터미널이어야 `COMPOSE_FILE` 등 export 된 값이 Claude Code의 명령에도
> 그대로 전달된다.

```bash
[ "$DBV_READY" = 1 ] && cat <<EOF || echo "❌ 자가진단(dbv-setup.sh)을 ✅로 통과한 뒤 실행하세요"
우리 서비스의 compose 설정을 수정해서, DB 컨테이너를 외부에서 이미 만들어 둔
db-viewer용 브리지 네트워크에 "추가로" 합류시켜 줘. 사내 db-viewer가 이 네트워크를 통해
우리 DB를 읽기 전용으로 조회할 예정이야.

## 값
- compose 프로젝트: $COMPOSE_PROJECT_NAME
- compose 파일 (이 조합·이 순서 그대로, 콜론 구분): $COMPOSE_FILE
- env 파일: ${COMPOSE_ENV_FILES:-(따로 없음 — 프로젝트 디렉터리의 .env 가 있으면 자동 적용)}
- 합류시킬 네트워크 이름: $DBV_NET   (이미 docker network create로 만들어져 있음)
- DB 컨테이너의 compose 서비스명: $DB_SERVICE
- DB 컨테이너 이름: $DB_CONTAINER
- 그 네트워크에서 쓸 별칭: $DB_ALIAS   (생략 불가 — 공유 네트워크에서는 이 이름으로만 우리 DB를 찾는다)
- 이 터미널에는 COMPOSE_PROJECT_NAME·COMPOSE_FILE(·COMPOSE_ENV_FILES)이 이미 export 돼 있다.
  docker compose 명령에 -f / -p / --env-file 을 따로 붙이지 말고 그대로 써.

## 반드시 지킬 것
1. 기존 networks 블록의 default 정의(driver, ipam, subnet, gateway)를 절대 수정하지 마.
   subnet을 바꾸면 다른 서비스와 충돌한다. 새 네트워크를 항목으로 "추가"만 해.
2. 이 네트워크에는 우리 DB 컨테이너만 넣어. 앱 등 다른 컨테이너는 넣지 마.
3. docker compose down 은 절대 실행하지 마. 네트워크까지 삭제되어 같은 compose의 다른
   서비스에 영향이 간다. 반영은 docker compose up -d $DB_SERVICE 으로만 해.
4. 애플리케이션 코드, Dockerfile, 의존성은 건드리지 마. 변경은 위 compose 파일 안에서만 —
   파일이 여러 개면 네트워크를 어느 파일에 넣을지 먼저 제안하고 내 승인을 받아.
5. 포트를 호스트로 새로 노출(ports:)하지 마. 같은 네트워크에 있으면 필요 없다.

## 작업 순서
1. 위 compose 파일을 전부 읽고(override 포함), DB 컨테이너가 현재 어떤 네트워크에 붙어
   있는지 보고해.
2. 아래 형태로 수정안을 만들어서 diff를 먼저 보여줘. 내가 승인하면 적용해.

   services:
     $DB_SERVICE:
       networks:
         default:
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
   - 기존 default 네트워크의 subnet이 그대로인지: docker network inspect ${COMPOSE_PROJECT_NAME}_default

작업 중 위 "반드시 지킬 것"과 충돌하는 상황이 나오면 진행하지 말고 나에게 물어봐.
EOF
```

---

## ④ 읽기전용 계정 만들기

### PostgreSQL

비밀번호는 ②에서 `openssl`이 이미 만들어 뒀다 — 손으로 칠 값이 없다. 아래 블록은
`dbv-grant.sh`를 저장하고 실행한다: 계정을 만들고(이미 있으면 `ALTER ROLE`로 비밀번호만
맞춘다 — 두 번 실행해도 안전), `public` 스키마에 `SELECT`를 주고, **읽기는 되고 쓰기는
막히는지**까지 바로 확인해 ✅/⚠️/❌로 찍는다.

```bash
cat > dbv-grant.sh <<'SH'
# db-viewer 연동 — 읽기 전용 계정 만들기 + 읽기/쓰기 확인
[ "$DBV_READY" = 1 ] || { echo "❌ 자가진단(dbv-setup.sh)을 ✅로 통과한 뒤 실행하세요"; exit 1; }
noise(){ grep -vE '^time=|^WARN'; }
psql_super(){ docker exec -i "$DB_CONTAINER" psql -U "$DB_SUPER" -d "$DB_NAME" -v ON_ERROR_STOP=1 "$@"; }
# 읽기 전용 계정은 컨테이너 자기 IP 로 TCP 접속 — 소켓(trust)과 달리 비밀번호가 실제로 검증된다
DB_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$DB_CONTAINER" | awk '{print $1}')
psql_ro(){ docker exec -i -e PGPASSWORD="$RO_PASS" -e PGHOST="$DB_IP" "$DB_CONTAINER" psql -U "$RO_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 "$@"; }

# 계정이 이미 있으면 CREATE 대신 ALTER — 회신에 적힐 비밀번호와 실제를 맞춘다 (두 번 실행해도 안전)
if [ "$(psql_super -Atc "SELECT 1 FROM pg_roles WHERE rolname='$RO_USER'" 2>/dev/null | noise)" = 1 ]; then
  ROLE_SQL="ALTER ROLE $RO_USER LOGIN PASSWORD '$RO_PASS';"
  ROLE_MSG="이미 있던 계정 — 비밀번호만 새로 맞춤"
else
  ROLE_SQL="CREATE ROLE $RO_USER LOGIN PASSWORD '$RO_PASS';"
  ROLE_MSG="새로 만듦"
fi
# ALTER DEFAULT PRIVILEGES: 앞으로 만들어질 테이블에도 자동 적용 — 없으면 마이그레이션 때마다 안 보인다
if psql_super -q <<SQL
$ROLE_SQL
GRANT CONNECT ON DATABASE "$DB_NAME" TO $RO_USER;
GRANT USAGE ON SCHEMA public TO $RO_USER;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO $RO_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO $RO_USER;
SQL
then
  echo "✅ 계정 $RO_USER ($ROLE_MSG) — public 스키마 SELECT 권한 부여"
else
  echo "❌ 계정 만들기 실패 — 위 오류를 db-viewer 담당자에게 알려 주세요"
  exit 1
fi

# 읽기 확인 — public 의 첫 테이블 하나만 (행 수를 세지 않아 큰 테이블에도 부담이 없다)
PROBE_TABLE=$(psql_super -Atc "SELECT quote_ident(table_name) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name LIMIT 1" 2>/dev/null | noise)
if [ -n "$PROBE_TABLE" ]; then
  READ_OUT=$(psql_ro -Atc "SELECT count(*) FROM (SELECT 1 FROM public.$PROBE_TABLE LIMIT 1) s" 2>&1 | noise | tail -1)
  case "$READ_OUT" in
    0|1) echo "✅ 읽기 — public.$PROBE_TABLE 조회됨 (비밀번호 검증 포함)" ;;
    *)   echo "❌ 읽기 실패 — $READ_OUT" ;;
  esac
else
  echo "⚠️ 읽기 — public 에 테이블이 아직 없어 건너뜀"
fi
# 쓰기 확인 — 실제로 시도하되 ROLLBACK 이라 아무것도 남지 않는다
WRITE_OUT=$(psql_ro -q -Atc 'BEGIN; CREATE TABLE zzz_probe(id int); ROLLBACK;' 2>&1 | noise)
case "$WRITE_OUT" in
  "") echo "⚠️ 쓰기 — 허용돼 있습니다 (롤백해서 남진 않음 · PG14 이하 public 기본값일 수 있음)" ;;
  *"permission denied"*|*"must be owner"*|*"read-only"*)
      echo "✅ 쓰기 — 차단됨 ($(printf '%s\n' "$WRITE_OUT" | head -1))" ;;
  *)  echo "❓ 쓰기 — 확인 실패 ($(printf '%s\n' "$WRITE_OUT" | head -1))" ;;
esac
SH
bash dbv-grant.sh
```

DB가 compose 밖이면 `psql_super`·`psql_ro` 두 함수의 `docker exec … psql` 부분만
`psql "postgresql://…"` 형태로 바꾼다.

마지막 `ALTER DEFAULT PRIVILEGES`는 **그 명령을 실행한 계정(`$DB_SUPER`)이 앞으로 만들 테이블**에만
걸린다. 마이그레이션을 다른 롤로 돌린다면 그 롤로 한 번 더 실행한다 —
`ALTER DEFAULT PRIVILEGES FOR ROLE <그 롤> IN SCHEMA public GRANT SELECT ON TABLES TO $RO_USER;`

`public` 외의 스키마도 조회 대상이면 해당 스키마마다 `GRANT USAGE` / `GRANT SELECT` /
`ALTER DEFAULT PRIVILEGES`를 반복한다.

민감 테이블을 빼고 싶으면 `GRANT SELECT ON ALL TABLES` 대신 테이블을 열거해도 된다.
db-viewer 쪽에도 스키마 단위 허용 목록이 따로 있어 이중으로 통제된다.

**마지막 세 줄 읽는 법** — 읽기·쓰기 확인은 컨테이너 자기 IP로 TCP 접속하므로 **비밀번호까지
실제로 검증**된다(컨테이너 안 소켓 접속은 비밀번호를 묻지 않는다).

| 출력 | 뜻 |
|---|---|
| `✅ 쓰기 — 차단됨 (ERROR: permission denied for schema public)` | 정상 — 읽기 전용이 제대로 걸렸다 |
| `⚠️ 쓰기 — 허용돼 있습니다` | **PostgreSQL 14 이하**는 `public` 스키마에 누구나 `CREATE`할 수 있는 게 기본값이라 흔하다. `ROLLBACK`이라 테이블은 남지 않았다. 막으려면 DB 소유자 판단으로 `REVOKE CREATE ON SCHEMA public FROM PUBLIC;` — 다른 앱이 그 권한에 기대지 않는지 먼저 확인. 그대로 두어도 db-viewer는 `SELECT`만 실행한다 |
| `❓ 쓰기 — 확인 실패 (… FATAL …)` / `❌ 읽기 실패` | 접속 자체가 안 된 것 — 권한 결과가 아니다. `password authentication failed`면 비밀번호가 어긋난 것(② 창 닫음 항목), 그 외는 계정·DB명·`pg_hba.conf`를 확인 |
| `⚠️ 읽기 — public 에 테이블이 아직 없어 건너뜀` | 읽기 확인만 건너뛴 것. 쓰기 확인은 그대로 유효 |

### SQLite

계정 개념이 없다. 대신 **DB 파일이 든 볼륨 이름**을 알려주면 된다.

```bash
[ -n "$DB_CONTAINER" ] && docker inspect -f '{{range .Mounts}}{{.Name}} -> {{.Destination}}{{"\n"}}{{end}}' "$DB_CONTAINER" | grep . || echo "❌ 볼륨을 못 읽었습니다 — DB_CONTAINER 가 비었거나(②) 마운트가 없습니다"
```

db-viewer가 그 볼륨을 `:ro`(읽기 전용)로 마운트하고, 파일도 `mode=ro`로 연다.
이 경우 ③의 네트워크 작업은 필요 없다 — 볼륨 이름과 컨테이너 내부 파일 경로만 회신하면 된다.

---

## ⑤ 완료 보고 — 터미널 출력 그대로

**채울 양식이 없다.** 아래를 ②의 그 터미널에 붙여넣으면 `dbv-reply.sh`가 저장·실행되어
회신에 필요한 값과 검증 결과(네트워크·별칭·읽기·쓰기 차단·서비스 상태)가 한 번에 찍힌다.
**찍힌 내용을 그대로 복사해** db-viewer 담당자에게 메일로 보낸다. 비밀번호도 그 안에 들어
있다 — `SELECT`만 가능한 전용 계정이라 메일 전달을 전제로 한다. compose가 stderr로 찍는
경고(`time=…`/`WARN…`)는 판정에서 걸러 낸다.

```bash
cat > dbv-reply.sh <<'SH'
# db-viewer 연동 — 회신 내용 + 검증 결과를 한 번에 출력
[ "$DBV_READY" = 1 ] || { echo "❌ 자가진단(dbv-setup.sh)을 ✅로 통과한 뒤 실행하세요"; exit 1; }
noise(){ grep -vE '^time=|^WARN'; }
psql_super(){ docker exec -i "$DB_CONTAINER" psql -U "$DB_SUPER" -d "$DB_NAME" -v ON_ERROR_STOP=1 "$@"; }
# 읽기 전용 계정은 컨테이너 자기 IP 로 TCP 접속 — 소켓(trust)과 달리 비밀번호가 실제로 검증된다
DB_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$DB_CONTAINER" | awk '{print $1}')
psql_ro(){ docker exec -i -e PGPASSWORD="$RO_PASS" -e PGHOST="$DB_IP" "$DB_CONTAINER" psql -U "$RO_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 "$@"; }

NETS=$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$DB_CONTAINER")
ALIAS_OK=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$DBV_NET\").Aliases}}" "$DB_CONTAINER" 2>/dev/null)
ALIAS_OK=${ALIAS_OK:-"❌ 아직 $DBV_NET 에 안 붙었습니다 (compose 에 문을 아직 안 냈습니다)"}
PROBE_TABLE=$(psql_super -Atc "SELECT quote_ident(table_name) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name LIMIT 1" 2>/dev/null | noise)
if [ -n "$PROBE_TABLE" ]; then
  READ_OUT=$(psql_ro -Atc "SELECT count(*) FROM (SELECT 1 FROM public.$PROBE_TABLE LIMIT 1) s" 2>&1 | noise | tail -1)
  case "$READ_OUT" in
    0|1) READ_OK="✅ public.$PROBE_TABLE 조회됨 (비밀번호 검증 포함)" ;;
    *)   READ_OK="❌ $READ_OUT" ;;
  esac
else
  READ_OK="⚠ public 에 테이블이 없어 건너뜀"
fi
WRITE_OUT=$(psql_ro -q -Atc 'BEGIN; CREATE TABLE zzz_probe(id int); ROLLBACK;' 2>&1 | noise)
case "$WRITE_OUT" in
  "") WRITE_BLOCKED="⚠ 쓰기가 허용돼 있습니다 (롤백해서 남진 않음 · PG14 이하 public 기본값일 수 있음)" ;;
  *"permission denied"*|*"must be owner"*|*"read-only"*)
      WRITE_BLOCKED="✅ 차단됨 — $(printf '%s\n' "$WRITE_OUT" | head -1)" ;;
  *)  WRITE_BLOCKED="❓ 확인 실패 — $(printf '%s\n' "$WRITE_OUT" | head -1)" ;;
esac
SVC_STATUS=$(docker compose ps --format '{{.Service}} {{.Status}}' 2>/dev/null | noise | tr '\n' ' ')
SCHEMAS=$(psql_super -Atc "SELECT string_agg(DISTINCT table_schema, ', ') FROM information_schema.role_table_grants WHERE grantee='$RO_USER'" 2>/dev/null | noise)

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
조회 대상 스키마:   ${SCHEMAS:-public}

검증
- 붙어 있는 네트워크: $NETS
- 별칭:             $ALIAS_OK
- 읽기 확인:         $READ_OK
- 쓰기 차단 확인:    $WRITE_BLOCKED
- 서비스 상태:      ${SVC_STATUS:-(docker compose ps 로 직접 확인해 적어 주세요)}
─────────────────────────────────────────────
EOF
SH
bash dbv-reply.sh
```

회신을 보냈으면 이 디렉터리에 남은 `dbv-setup.sh`·`dbv-grant.sh`·`dbv-reply.sh`는 지워도
된다 — 값은 전부 터미널 변수에서 오므로 파일 안에는 비밀번호가 없다.

**SQLite**라면 네트워크·계정이 없으니 이것으로 대신한다. 첫 두 줄은 예시다 — 볼륨이 마운트된
디렉터리와 그 안의 DB 파일을 실제 경로로 바꾼다:

```bash
export SQLITE_DIR=/app/data
export SQLITE_PATH="$SQLITE_DIR/app.db"
cat > dbv-reply-sqlite.sh <<'SH'
# db-viewer 연동 (SQLite) — 회신 내용 출력
[ -n "$DB_CONTAINER" ] && [ -n "$SVC_KEY" ] || { echo "❌ 값 두 줄과 dbv-setup.sh 를 먼저 실행하세요"; exit 1; }
[ -n "$SQLITE_DIR" ] && [ -n "$SQLITE_PATH" ] || { echo "❌ SQLITE_DIR / SQLITE_PATH 를 먼저 export 하세요"; exit 1; }
SQLITE_VOL=$(docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$SQLITE_DIR\"}}{{.Name}}{{end}}{{end}}" "$DB_CONTAINER")
[ -n "$SQLITE_VOL" ] || echo "⚠ 볼륨을 못 찾았습니다 — SQLITE_DIR 이 실제 마운트 지점인지 확인"
JOURNAL=$(docker exec "$DB_CONTAINER" sqlite3 "$SQLITE_PATH" 'PRAGMA journal_mode;' 2>/dev/null) || JOURNAL=""
cat <<EOF
──── db-viewer 연동 회신 (SQLite) ───────────────
서비스 키:        $SVC_KEY
엔진:             SQLite
볼륨 이름:         ${SQLITE_VOL:-❌ 못 찾음}
컨테이너 내부 경로: $SQLITE_PATH
저널 모드:         ${JOURNAL:-(확인 못 함 — 컨테이너에 sqlite3가 없으면 공란)}
─────────────────────────────────────────────
EOF
SH
bash dbv-reply-sqlite.sh
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
| 자가진단이 「재생성됩니다」 ❌ | 대개 띄울 때 준 `--env-file`을 지금 안 주고 있는 것. `export COMPOSE_ENV_FILES=/절대경로/.env.prod` 후 `. ./dbv-setup.sh` 다시 (② 재생성 경고) |
| 블록을 붙여넣었는데 `❌ 자가진단…통과한 뒤` 한 줄만 나옴 | 새 터미널이거나 ②를 건너뛴 것. 값 두 줄 → `dbv-setup.sh` 순으로 다시 |
| `Pool overlaps with other one on this address space` | (전용) 서브넷 `10.203.<n>.0/24`가 이미 쓰이고 있다. db-viewer 담당자에게 다른 `<n>`을 요청 |
| db-viewer 연결 테스트가 엉뚱한 DB를 회신 | 여러 서비스가 `postgres` 같은 흔한 컨테이너명을 쓴다 — 공유 네트워크에서는 별칭이 유일한 구별 수단이다. 별칭(`<서비스키>-db`)이 제대로 붙었는지 확인 |
| DB 컨테이너에 볼륨이 없다 | **작업 중단.** 볼륨부터 붙이는 게 먼저다 (②) |
