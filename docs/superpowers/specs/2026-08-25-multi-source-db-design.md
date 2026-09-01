# 멀티 소스 DB 조회 설계 — PostgreSQL / SQLite

작성일: 2026-08-25

## 배경

db-viewer는 현재 사내 MSSQL 한 곳만 본다. 그런데 같은 71번 서버에는 도커로 배포된 다른
서비스들이 여럿 떠 있고, 각각 자기 DB(PostgreSQL 또는 SQLite)를 갖고 있다. 이 DB들을
별도 도구 없이 db-viewer에서 바로 조회하고 싶다는 요구다. 대상 서비스들의 소스코드와
배포는 우리가 통제할 수 있다.

기술적 출발점은 **"MSSQL만 본다"가 백엔드의 제약이 아니라는 것**이다. 백엔드는 원본 DB에
직접 닿지 않고 수집(W1)·조회(W2)를 전부 n8n webhook 경유로 처리하며, n8n 워크플로가
`microsoftSql` 노드로 고정되어 있을 뿐이다 (`backend/app/adapters/n8n_query.py`).
카탈로그도 이미 `snapshots.source_db` 라벨 + 스냅샷 단위로 저장되고
`resolve_snapshot()`이 `snapshot_id`를 옵션으로 받는다 (`backend/app/api/objects.py:37`).
소스 개념을 얹을 자리가 이미 있다.

## 목표

- 등록된 PostgreSQL / SQLite DB의 **테이블·뷰 목록, 컬럼, 행 미리보기, 실제 FK 기반 ERD**를
  기존 화면에서 그대로 본다.
- 기존 사내 MSSQL 경로(n8n W0/W1/W2)는 무변경으로 계속 동작한다.
- 대상 서비스에 조회용 코드를 넣지 않는다.

## 비목표

명시적으로 하지 않는 것들. 나중에 필요해지면 별도 스펙으로 다룬다.

- **쓰기.** INSERT/UPDATE/DELETE/DDL 경로를 만들지 않는다. 전 구간 읽기 전용.
- **비-MSSQL 소스의 뷰 lineage 역추적·관계 온디맨드 발견·AI 제안.** 이 기능들은 "FK가
  13개뿐인 레거시 MSSQL"을 위해 만든 것이다. 우리가 만든 서비스 DB는 FK가 제대로 있어서
  그 기계가 필요 없다.
- **소스별 사용자 권한 분리.** 앱에 들어온 사람은 등록된 모든 소스를 본다. 값 노출은
  기존대로 미리보기 allowlist가 통제한다.
- **크로스 소스 조인·ERD.** ERD와 조인은 한 소스 안에서만 성립한다.
- **MSSQL 직결 전환.** 사내 MSSQL은 계속 n8n 경유다.

## 확정 결정

브레인스토밍에서 넘어온 네 갈림길의 결론.

| 갈림길 | 결정 | 이유 |
|---|---|---|
| 기능 범위 | 탐색 + 미리보기 + FK ERD | lineage·관계발견은 레거시 MSSQL 전용 기계 |
| 연결 경로 | 신규 소스만 백엔드 직결, MSSQL은 n8n 유지 | 우리 서비스 DB는 사내 MSSQL과 위험 프로파일이 다르다 |
| 소스 등록 | 관리자 UI (암호화 저장) | 서비스가 여럿·가변이라 재배포 없이 늘려야 한다 |
| 네트워크 | B′ — 서비스당 전용 브리지 네트워크 | 서비스 간 격리 유지 + 네트워크가 어느 compose에도 종속되지 않음 |

---

## 1. 데이터 모델

### 1.1 신설 — `data_sources`

```
data_sources
  id              PK
  name            varchar(100)  UNIQUE   -- 화면 표시 라벨
  engine          varchar(16)            -- 'mssql' | 'postgres' | 'sqlite'
  access_mode     varchar(8)             -- 'n8n' | 'direct'
  host            varchar(255)  NULL     -- direct/postgres
  port            integer       NULL
  database        varchar(128)  NULL
  username        varchar(128)  NULL
  password_enc    text          NULL     -- Fernet 암호문 (평문 저장 금지)
  file_path       varchar(500)  NULL     -- direct/sqlite (컨테이너 내부 경로)
  is_enabled      boolean
  is_managed      boolean                -- true = .env/n8n이 소유, UI에서 수정·삭제 불가
  created_at, updated_at, last_ok_at, last_error
```

`CHECK (engine IN ('mssql','postgres','sqlite'))`,
`CHECK (access_mode IN ('n8n','direct'))`.

**기존 사내 MSSQL도 소스 1건으로 표현한다.** 마이그레이션에서
`(name='사내 MSSQL', engine='mssql', access_mode='n8n', is_managed=true)` 행을 seed한다.
접속정보는 여전히 `.env`/n8n에만 있고 이 행은 라벨과 라우팅 표식만 담는다.
`is_managed=true`인 행은 API가 수정·삭제를 거부한다.

### 1.2 변경 — 소스 축 추가

```
snapshots          + data_source_id  FK NOT NULL   -- 기존 행은 seed된 MSSQL 소스로 백필
preview_allowlist    PK: schema → (data_source_id, schema)
schema_categories    PK: schema_name → (data_source_id, schema_name)
```

`preview_allowlist`의 PK 확장은 **선택이 아니라 필수**다. 지금 PK가 `schema` 하나라
(`backend/app/models/preview_policy.py`), 소스가 여럿이면 서비스A의 `public`을 허용한 것이
서비스B의 `public`까지 여는 사고가 난다. `schema_categories`도 같은 축이라 함께 옮긴다.

`HIDDEN_SCHEMAS`(전역 env)는 그대로 두고 "모든 소스에 적용"임을 문서화한다. 감춤은
허용보다 우선한다는 기존 규칙도 그대로다.

### 1.3 스냅샷 해석

`resolve_snapshot(db, snapshot_id)` → `resolve_snapshot(db, source_id, snapshot_id)`.
`snapshot_id`가 오면 그것을, 없으면 **그 소스의 최신 `ready` 스냅샷**을 쓴다.
`source_id`도 없으면 기본 소스(seed된 MSSQL)로 — 기존 호출자가 안 깨진다.

### 1.4 마이그레이션 0015 (head = 0014)

1. `data_sources` 생성
2. seed 행 삽입 (id 고정: 1)
3. `snapshots.data_source_id` nullable로 추가 → `UPDATE ... SET data_source_id = 1` →
   NOT NULL 전환
4. `preview_allowlist` / `schema_categories` PK 재구성 + 기존 행 `data_source_id = 1` 백필

downgrade는 역순으로 컬럼 제거 + PK 복원까지 구현한다 — 롤백 가능해야 한다.

---

## 2. 엔진 어댑터

기존 팩토리(`backend/app/adapters/__init__.py`)의 선택 기준이 `settings` → `source`로
바뀐다. **실행 로직은 무변경이고 "누구를 부를지 고르는 곳"만 이동한다.**

포트는 두 개뿐이다.

```python
class CatalogCollector(Protocol):
    def collect(self, source: DataSource) -> CatalogPayload: ...

class TablePreview(Protocol):
    def rows(self, schema: str, table: str, columns: list[dict],
             limit: int, filters: list[dict] | None) -> list[dict]: ...
```

`CatalogPayload`는 **기존 ingest 계약 그대로**다 (`backend/app/schemas/ingest.py`).
수집기가 이걸 채워주면 하류(lineage·ERD·검색·미리보기 정책·스냅샷 diff)는 전부 재사용된다.

| | mssql (n8n) | postgres (direct) | sqlite (direct) |
|---|---|---|---|
| 수집 | 기존 W1 | `pg_catalog` + `information_schema` | `sqlite_master` + `PRAGMA` |
| 미리보기 | 기존 W2 | psycopg | stdlib `sqlite3` |
| 드라이버 | — | `psycopg[binary]` (이미 prod 의존성) | 표준 라이브러리 |

**새 DB 드라이버가 필요 없다.** `psycopg[binary]==3.2.3`은 서비스 DB용으로 이미 들어와
있고 SQLite는 stdlib다. 새로 추가되는 직접 의존성은 `cryptography`(Fernet) 하나뿐이며,
이것도 `pyjwt[crypto]`로 이미 설치돼 있다 — 직접 쓰므로 `requirements.txt`에 명시적으로 핀한다.

### 2.1 PostgreSQL 매핑

| CatalogPayload | 출처 |
|---|---|
| `object_id` | **스냅샷 내 일련번호** (SQLite와 동일). 수집 중에만 `oid → 일련번호` 사전을 들고 제약을 해석한다 |
| `schema` / `name` | `pg_namespace.nspname` / `pg_class.relname` |
| `type` | `relkind IN ('r','p')` → `table`, `('v','m')` → `view` |
| `row_count` | `pg_class.reltuples::bigint` (음수면 NULL — 미분석) |
| `definition` | `pg_get_viewdef(oid, true)` |
| 컬럼 | `pg_attribute` (`attnum > 0 AND NOT attisdropped`) |
| `data_type` | `format_type(atttypid, atttypmod)` |
| `max_length` | `information_schema.columns.character_maximum_length`, NULL → `-1` |
| `is_computed` | `attgenerated <> ''` |
| PK/UQ | `pg_constraint.contype IN ('p','u')` + `conkey` |
| FK | `contype='f'` + `conkey`/`confkey` 페어 |

시스템 스키마 제외: `nspname NOT IN ('pg_catalog','information_schema')`,
`nspname NOT LIKE 'pg\_toast%'`, `NOT LIKE 'pg\_temp%'`.

`reltuples`는 추정치다 — MSSQL 쪽에서 쓰는 `dm_db_partition_stats`와 같은 성격이라
화면 의미가 어긋나지 않는다.

**`oid`를 `object_id`로 그대로 쓰지 않는 이유.** PostgreSQL의 oid는 unsigned 32bit라
최대 4,294,967,295인데 `objects.object_id`는 `Integer`(int4, 최대 2,147,483,647)다. 오래
돌아간 DB에서 oid가 그 선을 넘으면 적재가 터진다. 계약이 요구하는 건
`UniqueConstraint(snapshot_id, object_id)`뿐이므로 일련번호로 충분하다.

### 2.2 SQLite 매핑

| CatalogPayload | 출처 |
|---|---|
| `schema` | `"main"` 고정 (SQLite에 스키마 개념 없음) |
| `object_id` | **스냅샷 내 일련번호** — 계약상 `UniqueConstraint(snapshot_id, object_id)`만 만족하면 된다 |
| `name` / `type` / `definition` | `sqlite_master` (`name NOT LIKE 'sqlite_%'`) |
| 컬럼 | `PRAGMA table_info(<name>)` → `cid`=ordinal, `notnull`, `pk` |
| `data_type` | 선언 타입 문자열 그대로 (빈 값이면 `"BLOB"`) |
| `max_length` | `-1` 고정 (SQLite는 길이 제약을 저장하지 않는다) |
| `is_computed` | `false` (생성 컬럼은 `PRAGMA table_xinfo`가 필요 — 1차 범위 밖) |
| PK | `table_info.pk > 0` |
| FK | `PRAGMA foreign_key_list(<name>)`, `to`가 NULL이면 대상 테이블의 PK로 해석 |
| `row_count` | `SELECT COUNT(*)` (대상이 소규모 서비스 DB라 허용) |

PRAGMA는 바인드 파라미터를 못 받는다. 테이블명은 `sqlite_master`에서 읽은 값이라
외부 입력이 아니지만, 그래도 식별자 인용으로 감싸 넣는다.

파일은 `file:<path>?mode=ro`로 연다. 볼륨도 `:ro`로 마운트한다 — 두 겹으로 막는다.

### 2.3 Phase 2 게이트

뷰 파싱·lineage(`run_phase2`)는 **`engine == 'mssql'`일 때만** 실행한다. 파서가
`sqlglot(dialect=tsql)` 기준이라 PG/SQLite DDL을 먹이면 무의미한 실패만 쌓인다.
비-MSSQL 소스의 객체는 `parse_status`를 NULL로 남긴다.

---

## 3. 미리보기 SQL — 보안 경계

미리보기는 값 데이터가 화면으로 나가는 유일한 경로다. 여기가 이 설계의 보안 경계다.

**식별자.** 스키마·테이블·컬럼 이름은 **그 스냅샷의 카탈로그에 실제로 존재하는 이름과
대조해 통과시킨 것만** 쓴다. 통과한 이름만 엔진별 인용부호로 감싼다. 사용자 입력이
식별자 자리에 직접 들어가는 경로는 존재하지 않는다.

**값.** 전부 바인드 파라미터. Postgres `%s`, SQLite `?`.

**연산자 의미 동등.** 기존 6개 op의 의미는 fixture 구현
(`backend/app/adapters/table_preview.py:_matches_cond`)이 기준이다.

| op | 조건식 | 파라미터 |
|---|---|---|
| `eq` | `UPPER(CAST(c AS TEXT)) = UPPER(?)` | value |
| `neq` | `(c IS NULL OR UPPER(CAST(c AS TEXT)) <> UPPER(?))` | value |
| `contains` | `UPPER(CAST(c AS TEXT)) LIKE UPPER(?) ESCAPE '\'` | `%value%` |
| `not_contains` | `(c IS NULL OR NOT (UPPER(CAST(c AS TEXT)) LIKE UPPER(?) ESCAPE '\'))` | `%value%` |
| `is_null` | `c IS NULL` | — |
| `not_null` | `c IS NOT NULL` | — |

두 가지가 의도적이다.

- **`UPPER(CAST(...))` 양변 비교** — MSSQL 기본 collation이 case-insensitive라 기존 필터가
  CI 의미다. PG/SQLite는 CS이므로 명시적으로 맞춘다. SQLite `UPPER()`는 ASCII 한정이지만
  한글에는 대소문자가 없어 실무 영향이 없다.
- **`neq`/`not_contains`의 `c IS NULL OR`** — SQL 3값 논리라면 NULL 행이 빠지지만, fixture
  구현은 NULL을 빈 문자열로 취급해 매칭시킨다. 그 의미에 맞춘다.

`LIKE` 메타문자(`%`, `_`)는 이스케이프한다 — 사용자가 `%`를 넣으면 리터럴로 취급돼야 한다.

**연결.** 소스별 SQLAlchemy 엔진을 캐시하고 `pool_pre_ping=True`, 작은 풀(2~3)을 쓴다.
소스 수정·삭제 시 캐시를 무효화한다. 타임아웃은 연결(5초)과 문장(15초) 둘 다 건다
(PG: `options='-c statement_timeout=15000'`, SQLite: `sqlite3` timeout).

**계정.** 읽기전용 계정을 권장하고 배포 문서에 발급 절차를 넣는다. 코드가 강제할 수는
없으니 문서와 [연결 테스트]가 담당한다.

실행된 SQL을 화면에 보여주는 기존 기능은 그대로 유지한다.

---

## 4. 백엔드 API

### 신규 — `/api/sources`

| 메서드 | 경로 | 비고 |
|---|---|---|
| GET | `/api/sources` | 관리 목록(sysadmin). **비밀번호는 절대 실어보내지 않는다** |
| GET | `/api/sources/options` | 선택기용 최소 목록 — id·이름·엔진·활성 여부뿐. 조회 API와 같은 게이트(화이트리스트 사용자). 관리 목록만 있으면 일반 사용자에게 선택기가 영영 안 떠 비목표("모든 소스를 본다")와 어긋난다 |
| POST | `/api/sources` | 생성 — 2차 게이트 |
| PATCH | `/api/sources/{id}` | 수정 — 2차 게이트, `is_managed`면 거부 |
| DELETE | `/api/sources/{id}` | `is_managed`거나 스냅샷이 있으면 거부(409). 비활성화를 안내 |
| POST | `/api/sources/{id}/test` | 연결 테스트 → `{ok, server_version, database, latency_ms}` |

**2차 게이트**는 기존 `PREVIEW_ADMIN_PASSWORD`를 **그대로 재사용한다** — 별도 비밀번호를
새로 두지 않는다. 이미 "값 노출 범위를 바꾸는 조작"을 막는 용도로 쓰이고 있고, 소스 등록도
정확히 같은 성격이다. 비밀번호를 늘리면 운영자가 관리할 비밀만 하나 더 생긴다.
미설정이면 503 — 기존 allowlist 수정과 같은 동작이다.

**암호화**는 Fernet + `DBV_SECRET_KEY`. **키가 없으면 소스 생성·수정 자체가 503이다** —
평문 저장으로 흘러가는 경로를 만들지 않는다.

`DELETE`를 막고 비활성화로 유도하는 이유: 스냅샷을 CASCADE로 지우면 수집 이력과
allowlist 설정이 조용히 사라진다. 되돌릴 수 없는 삭제는 명시적으로만.

### 변경 — `source_id` 파라미터 추가

`GET /api/objects`, `/api/objects/columns-index`, `/api/erd/*`, `/api/snapshots`,
`POST /api/collect/trigger`에 `source_id`를 옵션으로 추가한다. 생략하면 기본 소스 —
기존 호출자가 안 깨진다.

`GET /api/objects/{id}/detail`과 `/preview`는 객체 id에서 스냅샷 → 소스를 역으로 찾으므로
파라미터가 필요 없다.

---

## 5. 관리자 UI

`frontend/src/components/admin/DataSourcePanel.tsx` 신설 — 기존
`PreviewAllowlistPanel` / `HiddenSchemaPanel`과 같은 자리에 붙인다.

- 목록: 이름, 엔진, 접속 대상, 활성 여부, 마지막 연결 성공 시각, 마지막 오류
- 추가/수정 폼: 엔진 선택에 따라 필드가 바뀐다 (postgres = host/port/db/user/pw,
  sqlite = file_path)
- **비밀번호는 쓰기 전용** — 화면에는 `••••` + [변경] 버튼, 응답에 값이 실리지 않는다
- [연결 테스트] — 실제로 붙은 DB의 이름·버전을 회신해 **눈으로 확인**시킨다.
  여러 서비스가 DB 컨테이너를 `postgres` 같은 흔한 이름으로 띄웠을 때 엉뚱한 곳에 붙는 걸
  잡아내는 장치다
- [수집 실행] — 그 소스의 카탈로그 수집 트리거
- `is_managed` 행(사내 MSSQL)은 읽기 전용으로 표시

`data-testid`는 `DataSourcePanel-<role>` 규칙을 따른다 (`rules/frontend/identifiers.md`).

---

## 6. 브라우저 UI

- 헤더에 **소스 선택기**. 테이블 브라우저와 ERD가 공유한다.
- 선택은 **URL 쿼리(`?source=3`)**에 싣는다 — 링크 공유가 되고 새로고침에 안 죽는다.
- `frontend/src/lib/api.ts`에서 카탈로그를 읽는 함수들(`searchObjects`, `fetchAllObjects`,
  `fetchErdGraph`, 컬럼 인덱스 조회)에 `source_id`를 전달한다.
- **검증(verify)·파싱 탭은 MSSQL 소스에서만 노출한다.** 전 기능 동등을 안 하기로 했으므로
  UI에서도 없는 기능을 남겨두지 않는다.
- 기본 선택은 사내 MSSQL — 기존 사용자 동선이 그대로다.

---

## 7. 배포 — 네트워크 B′

### 결정

**서비스당 전용 브리지 네트워크를 외부에서 만들고, db-viewer와 그 서비스 DB 둘만 넣는다.**

```bash
docker network create --subnet 172.50.0.0/24 dbv-svca
docker network create --subnet 172.50.1.0/24 dbv-svcb
```

```yaml
# 대상 서비스 compose — 기존 default 정의는 한 줄도 안 바꾼다
services:
  postgres:
    networks:
      default:                 # 기존 그대로
      dbv-svca:
        aliases: [svca-db]     # 고유 별칭
networks:
  default: { ...기존 그대로... }
  dbv-svca: { external: true }
```

```yaml
# db-viewer compose
services:
  backend:
    networks: [dbviewer, dbv-svca, dbv-svcb]
    volumes:
      - svcc_data:/mnt/sources/svcc:ro        # SQLite 소스
networks:
  dbv-svca: { external: true }
  dbv-svcb: { external: true }
volumes:
  svcc_data: { external: true, name: <서비스C_볼륨명> }
```

### 왜 B′인가

검토한 대안과 탈락 이유.

- **A안 — db-viewer가 대상의 기존 `default` 네트워크에 합류.** 대상 무수정·무재기동이라
  가장 가볍지만 두 가지 문제가 있다. (1) 여러 서비스가 DB 컨테이너를 `postgres`/`db` 같은
  흔한 이름으로 띄웠으면 backend가 여러 네트워크에 동시 합류한 순간 이름 해석이 보장되지
  않는다. (2) 대상 `default`는 대상 compose 소유라, 대상이 `docker compose down` 되면
  네트워크가 사라져 **db-viewer가 기동조차 못 한다**.
- **B안 — 공용 네트워크 하나에 모든 DB.** (2)는 해결되지만 서비스A DB와 서비스B DB가
  서로 닿게 된다. 조회 하나 하자고 원래 있던 서비스 간 격리를 깨는 건 맞바꿀 가치가 없다.
- **B′ — 서비스당 전용 네트워크.** 대상 수정량은 B와 같고, 각 네트워크에 db-viewer와 그
  서비스 DB **둘만** 있어 격리가 유지된다. 별칭이 고유하니 이름 충돌도 없고, 네트워크가
  어느 compose에도 종속되지 않아 (2)도 없다. 비용은 네트워크 개수뿐이며 `172.50.x.0/24`로
  256개까지 나온다.

### 기존 대역과의 관계

기존 서비스들은 `172.36.0.0/16`부터 `172.46` 부근까지 각자 `default` subnet을 잡아 쓰고
있고, db-viewer는 `172.48.0.0/16`이다 (`docker-compose.yml`). `172.50.x.0/24`는 어느
쪽과도 겹치지 않는다. **기존 subnet 정의는 전혀 건드리지 않는다.**

### 사전 체크리스트 (서비스별, 착수 전 필수)

B′는 대상 DB 컨테이너를 **1회 재생성**한다. 데이터가 named volume에 있으면 무손실이지만,
볼륨 없이 컨테이너 레이어에 쓰고 있으면 그 순간 날아간다.

```bash
docker inspect -f '{{range .Mounts}}{{.Type}} {{.Name}} -> {{.Destination}}{{"\n"}}{{end}}' <db컨테이너>
```

출력이 비어 있으면 **그 서비스는 B′ 적용 금지** — 볼륨부터 붙이거나 그 서비스만 A안으로 간다.

재생성은 `docker compose up -d`로 in-place. **`docker compose down`은 쓰지 않는다** —
네트워크까지 지워져 같은 compose의 다른 서비스에 영향이 간다.

### 네트워크에 붙는 것만으로는 조회되지 않는다

한 소스가 실제로 보이려면 세 가지가 모두 있어야 한다.

1. 네트워크 도달 (B′)
2. 그 DB의 읽기전용 계정
3. db-viewer 관리자 UI에 소스 등록

값(행) 조회는 여기에 더해 미리보기 allowlist에 그 소스의 스키마가 등록돼야 열린다.
기본은 전부 차단이므로 등록만으로 데이터가 새지 않는다.

---

## 8. 설정

| 키 | 분류 | 설명 |
|---|---|---|
| `SOURCE_SECRET_KEY` | Environment | Fernet 키(urlsafe base64 32B). 소스 접속정보 암호화. 미설정이면 소스 등록 503 |
| `SOURCE_QUERY_TIMEOUT` | Tuning | direct 소스 미리보기 문장 타임아웃(초, 기본 15) |
| `SOURCE_CONNECT_TIMEOUT` | Tuning | direct 소스 연결 타임아웃(초, 기본 5) |

`.env.example` · `docker-compose.yml` 환경변수 목록 · README에 반영한다
(`rules/backend/config.md`, `rules/backend/sync-checklist.md`).

**기존 값은 그대로다.** `N8N_WEBHOOK_BASE`, `SOURCE_MODE`는 유지되고,
`SOURCE_MODE=live` 게이트는 이제 **MSSQL 소스 전용 게이트**로 의미가 좁아진다.
direct 소스는 항상 실데이터라 이 플래그의 영향을 받지 않는다.

---

## 9. 에러 처리

- 소스 연결 실패는 **그 소스만** 실패한다. 목록·ERD는 다른 소스로 계속 동작하고,
  화면에는 연결 실패 배지와 마지막 오류가 뜬다.
- 오류 메시지에 호스트·DB명·소스명을 싣되 **자격증명은 절대 싣지 않는다**.
- 일시 오류는 1회 재시도 후 마지막 오류를 올린다 (`rules/common/error-handling.md`,
  기존 `n8n_query.py`와 같은 정책).
- 수집 실패는 스냅샷을 `failed`로 남기고 직전 `ready` 스냅샷을 계속 서빙한다 — 기존 동작.

---

## 10. 테스트 전략

| 대상 | 방식 |
|---|---|
| 미리보기 SQL 빌더 | 단위 — 6개 op × 2엔진, 파라미터화 확인, 식별자 화이트리스트 우회 시도, LIKE 메타문자 이스케이프 |
| 수집기 → `CatalogPayload` 매핑 | 단위 — 엔진별 매핑표대로 |
| SQLite 왕복 | 통합 — `tmp_path`에 실제 `.db`를 만들어 수집→미리보기. **추가 인프라 0, 항상 실행** |
| PostgreSQL 왕복 | 통합 — 로컬 compose의 `dbviewer` DB 자신을 소스로 등록. 환경변수 있을 때만 실행하는 마커 |
| 소스 레지스트리 | 단위 — 암호화 왕복, 비밀번호 미노출, `is_managed` 보호, 스냅샷 있는 소스 삭제 거부 |
| 소스 전환 | 백엔드 통합(TestClient) — 소스별 조회 격리·미리보기 허용 격리·MSSQL 전용 경계. **화면단 자동 검증은 없다** (아래) |
| **회귀** | **기존 335 테스트 그린 유지가 1단계 성공 기준** |

**소스 전환의 화면단 커버리지는 없다.** 이 저장소에 Playwright 스위트가 없기 때문이다 —
`frontend/package.json`에 의존성이 없고 `*.spec.ts`도 없다(초기 계획이 잘못 전제했다).
프런트 자동 검증은 vitest 단위 테스트뿐이고, 그 대상은 순수 헬퍼(`lib/*`)로 한정된다 —
컴포넌트·라우팅·소스 선택기 동작과 관리자 패널은 **수동 확인**에 의존한다.

그래서 **비-MSSQL 소스의 비목표 경계를 UI 게이팅에만 맡기지 않는다.** 화면이 진입점을
감추는 것과 별개로, 백엔드가 다른 소스의 `object_id`/`column_id`를 거부한다
(`validate.resolve_column_ref` / `join-check`의 `ensure_mssql_source` → 400). 클라이언트가
주는 id는 북마크·수동 편집으로 얼마든지 바뀌므로 UI 게이팅은 경계가 될 수 없다.

미리보기 SQL 빌더 테스트에는 **적대적 케이스**를 넣는다: 카탈로그에 없는 컬럼명, 인용부호를
포함한 이름, 필터 값에 `'; DROP` — 전부 거부되거나 리터럴로 처리돼야 한다.

---

## 11. 단계 계획

각 단계는 독립적으로 검증 가능하고, 중간에 멈춰도 기존 기능이 깨지지 않아야 한다.

| # | 내용 | 검증 |
|---|---|---|
| 1 | 소스 모델 + 마이그레이션 0015 + 백필, 팩토리 선택 기준을 source로 이동 | 기존 335 그린, MSSQL 화면 무변경, upgrade/downgrade 왕복 |
| 2 | 엔진 어댑터 인터페이스 + PostgreSQL 수집기·미리보기 | 로컬 PG 수집→미리보기 왕복, SQL 빌더 단위 테스트 |
| 3 | 소스 선택 UI + 관리자 패널 | 소스 전환은 수동 확인(§10 — E2E 스위트 없음), 비밀번호 미노출은 API 단위 테스트 |
| 4 | SQLite 수집기·미리보기 | tmp 파일 왕복 |
| 5 | 배포 문서 — B′ 절차, 볼륨 사전 체크, 읽기전용 계정 발급 | 문서 리뷰 |

**순서에 대한 기록.** 엔지니어링만 보면 SQLite를 먼저 만드는 게 낫다 — 인프라 없이
테스트가 돌아 인터페이스를 먼저 굳힐 수 있다. 그럼에도 승인된 순서(PostgreSQL 우선)를
유지하는 이유는 실제 필요가 PostgreSQL이기 때문이다. 대신 2단계에서 인터페이스를 엔진
중립으로 설계하고, 4단계가 그 일반성을 검증하는 역할을 맡는다.

---

## 12. 열린 항목

지금 결정하지 않고 넘기는 것들. 필요해지면 별도 스펙으로 다룬다.

- **소스별 사용자 권한.** "A팀은 A서비스 DB만" 요구가 생기면 데이터 모델이 다시 흔들린다.
  현재는 없다고 확인받았다.
- **SQLite 생성 컬럼**(`PRAGMA table_xinfo`) — 1차 범위 밖, `is_computed=false`로 둔다.
- **PostgreSQL materialized view** — `view`로 취급한다. 별도 타입이 필요해지면 그때.
- **소스 자동 수집 스케줄.** 지금은 관리자 버튼 수동 트리거만. 서비스 배포마다 스키마가
  바뀌므로 나중에 필요해질 수 있다.
