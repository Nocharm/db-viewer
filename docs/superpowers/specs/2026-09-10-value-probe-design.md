# 값 추적(Value Probe) 설계 — 화면에 보인 값이 어느 컬럼에 있는가

작성일: 2026-09-10

## 배경

운영 화면에 노출된 값(주문번호, 고객명, 금액 등) 하나를 알고 있을 때, 그 값이 원본 DB의
어느 테이블·어느 컬럼에 저장돼 있는지 찾고 싶다. 지금 db-viewer의 검색은 전부 메타데이터
검색(객체명·컬럼명·AI 임베딩)이고, 값 단위 조회는 특정 테이블 하나에 필터를 거는
미리보기뿐이다. 값 하나로 컬럼을 역추적하는 경로는 없다.

순진하게 풀면 모든 컬럼에 `WHERE col = @v`를 날리게 되어 테이블 2,342개 × 컬럼 수만큼
쿼리가 나간다. 운영 DB 부하가 곧 비용이므로 **소스 DB에 보내는 쿼리 수를 줄이는 것**이
이 기능의 본질이다.

이미 있는 재료:

- 카탈로그가 테이블별 `row_count`, 컬럼별 `data_type`·`max_length`·`is_pk`·
  `distinct_count`·`masking_policy`를 갖고 있다 (`backend/app/models/catalog.py`).
- 스키마가 곧 시스템이다 — 실 스키마는 ATM·BCMS·SAP처럼 시스템 단위이고,
  미리보기 허용 목록도 `(data_source_id, schema)` 키다 (`backend/app/models/categories.py`,
  `backend/app/services/preview_policy.py`).
- FK 후보 검증이 같은 문제를 "싼 검사 먼저, 비싼 검사는 상위 몇 개만"으로 이미 풀고 있다
  (`backend/app/domain/scoring.py`, `backend/app/services/scan.py`).
- MSSQL 뷰의 컬럼 단위 lineage(`ViewLineageFlat.mapping_kind` = direct/derived)가 있다.
- MSSQL 쿼리는 n8n W2 웹훅의 고정 템플릿으로만 나가고(`tools/build_n8n_workflow.py`의
  `BUILD_QUERY_JS`), PG/SQLite는 백엔드가 직접 실행한다(`backend/app/sources/preview_sql.py`).

## 목표

- 값 하나 + 소스 + 스키마 범위로 `스키마.객체.컬럼` 후보 목록과 일치 건수를 얻는다.
- 소스 DB 쿼리는 **후보 객체당 1개**(히트 시 컬럼별 건수 쿼리 추가)로 묶는다.
- 카탈로그만으로 판단 가능한 것은 전부 쿼리 없이 걸러낸다.
- 찾은 것부터 화면에 보이고, 사용자가 언제든 멈출 수 있다.
- 기존 게이트(허용 목록·숨김 스키마·마스킹·감사 로그)를 그대로 통과한다.
- MSSQL(n8n)·PostgreSQL·SQLite 소스 모두 지원한다.

## 비목표

- **여러 값의 동일 행 공존 검색.** 화면 값은 조인 결과일 수 있어 같은 행을 전제할 수 없다.
  필요하면 값별로 따로 검색한 결과를 lineage로 잇는 확장으로 다룬다.
- **검색 결과 학습·저장.** 값→컬럼 매핑을 재사용 목적으로 저장하지 않는다. 검색값 저장
  정책이 먼저 필요하다.
- **통계 기반 사전 판정**(`DBCC SHOW_STATISTICS`, `pg_stats`). heavy 객체 처리의 향후
  확장 후보로만 남긴다.
- **값 지문 인덱스 사전 구축.** 수집 비용으로 옮겨질 뿐이고 값 복제 거버넌스 문제가 있다.
- 잡 행 보존 기간·정리. 스캔 잡과 같은 상태이며 한 번에 다룬다.

## 요구 확정 사항

| 항목 | 결정 |
|---|---|
| 입력 | 값 1개(≤100자) + 소스 + 스키마 1개 이상 + 라벨 힌트(선택) + 일치 모드 |
| 일치 모드 | `normalized`(기본): 정확 일치 + 표기 변형. `exact`: 원문 그대로. `contains`: `LIKE '%v%'`, 후보 객체 20개 이하일 때만 |
| 범위 | 스키마를 **명시적으로** 고른다. "허용 스키마 전체"도 선택지이나 기본값이 아니다. 못 찾아도 자동 확장하지 않는다 |
| 결과 | 목록 + 기존 미리보기 딥링크(`컬럼 = 실제 저장값`) |
| 뷰 | 포함. 단 `direct` lineage 컬럼은 제외, 복잡한 뷰는 heavy |
| heavy | `row_count`(뷰는 lineage 베이스의 최대값)가 임계값 초과 또는 미상 → 자동 실행 제외, 사용자가 선택 실행 |

## 설계

### 1. 데이터 흐름

```
POST /api/value-probe
  → 게이트(스냅샷·숨김·허용 목록)
  → 플래너 (카탈로그만, 쿼리 0)
      값 해석 → 후보 컬럼 필터 → 객체별 묶기 → 순위 → auto/heavy 분리
  → value_probe_jobs + value_probe_targets 저장, 감사 로그, 202 {job_id}
백그라운드 러너
  → auto 대상을 rank 순으로: 프로브 1쿼리 → 히트면 컬럼별 건수 쿼리 → 대상마다 커밋
GET /api/value-probe/{id}   (1.5s 폴링, 진행 중에도 hits 반환, 러너 한 번 깨움)
POST .../heavy   (선택 heavy → auto, 잡 재큐)
POST .../cancel
```

### 2. 플래너 (`backend/app/domain/value_probe.py`, 순수 함수)

**값 해석** `interpret_value(raw: str, mode) -> ValueInterpretation`

- `text`: 원문, trim, 대문자, 소문자 (중복 제거, 최대 4개). `normalized`에서만 변형 추가.
  하이픈·공백 제거형(`010-1234-5678` → `01012345678`)과 천단위 구분자 제거형(`1,000` → `1000`)도
  텍스트 변형에 포함.
- `int`/`decimal`: 구분자·통화기호·공백 제거 후 숫자로 파싱되면 생성. 정수면 `int` 패밀리에도.
- `date`: `YYYY-MM-DD`, `YYYY.MM.DD`, `YYYY/MM/DD`, `YYYYMMDD`(+ 선택 시각)을 인식하면 ISO
  문자열 생성. 텍스트 변형에 `20260910`·`2026-09-10` 추가.
- `guid`: UUID 형식이면 생성.
- `bit/boolean`은 생성하지 않는다(모든 bit 컬럼이 히트한다).
- 컬럼당 변형값 상한 8개(`PROBE_MAX_VARIANTS`). 초과분은 원문에 가까운 순으로 자른다.

**타입 패밀리** `get_probe_family(engine: str, data_type: str) -> str | None`

scoring의 패밀리(int·char 둘뿐)로는 부족해 프로브 전용 표를 둔다.

| 패밀리 | MSSQL | PostgreSQL | SQLite |
|---|---|---|---|
| `text` | char, varchar, nchar, nvarchar, text, ntext | character, character varying, varchar, text, name | TEXT, VARCHAR… |
| `int` | tinyint, smallint, int, bigint | smallint, integer, bigint, int2/4/8 | INTEGER |
| `decimal` | decimal, numeric, money, smallmoney, float, real | numeric, decimal, real, double precision | REAL, NUMERIC |
| `date` | date, datetime, datetime2, smalldatetime, datetimeoffset | date, timestamp, timestamptz | (없음) |
| `guid` | uniqueidentifier | uuid | (없음) |
| 제외 | bit, binary, varbinary, image, xml, timestamp(rowversion), geography, hierarchyid, sql_variant | boolean, bytea, json, jsonb, array | BLOB |

MSSQL `timestamp`는 rowversion이라 제외하고 PG `timestamp`는 날짜다 — 엔진별로 판정한다.

**후보 컬럼 필터** `select_candidate_columns(columns, interp, settings) -> list[CandidateColumn]`

순서대로 적용하며 전부 카탈로그 정보만 쓴다.

1. 패밀리가 `None`(제외 타입)이면 탈락.
2. 패밀리에 해당하는 변형값이 없으면 탈락 (예: 값이 숫자로 해석 안 되면 `int` 컬럼 탈락).
3. `text`는 길이 검사: `max_length == -1`(MAX)은 통과, 아니면 `max_length >= 가장 짧은 텍스트
   변형의 문자 수`. MSSQL `nchar/nvarchar`의 `max_length`는 바이트라 2로 나눈다.
4. `masking_policy`가 있으면 탈락 — 마스킹된 값을 찾는 것은 정책 우회다.
5. 기존 `scoring.check_exclusion`(저카디널리티·블랙리스트)에 걸리면 탈락. `distinct_count`가
   NULL이면 통과(정보 없음은 제외 사유가 아니다).
6. 뷰 컬럼은 `ViewLineageFlat`에서 `mapping_kind == 'direct'`인 행이 있으면 탈락 — 베이스
   테이블 프로브가 이미 커버한다. `derived`·set-level(`*`)·lineage 없음은 통과.
7. `is_computed` 컬럼은 통과(값이 실제로 존재한다).

**객체별 묶기와 순위** `plan_targets(candidates, objects, hint, settings) -> list[PlannedTarget]`

- 같은 객체의 후보 컬럼을 하나의 대상으로 묶는다. 컬럼이 40개(`PROBE_MAX_COLUMNS_PER_QUERY`)를
  넘으면 같은 객체를 여러 대상으로 나눈다.
- 순위 키: (객체 종류: 테이블 먼저 뷰 나중) → (힌트 유사도 내림차순: 힌트가 있을 때 컬럼명·객체명과
  `search-rank`와 같은 방식의 토큰 일치 점수) → (`est_rows` 오름차순, NULL은 맨 뒤).
- `est_rows`: 테이블은 `row_count`. 뷰는 `ViewLineageFlat`의 베이스 객체 `row_count` 최대값,
  lineage가 없으면 NULL.
- tier: `est_rows`가 NULL이거나 `value_probe_heavy_rows`를 넘으면 `heavy`. 뷰 정의에
  `GROUP BY`·`DISTINCT`·`UNION`·`TOP`·`OVER (`가 있으면(대소문자 무시) `heavy` — 조건이 뷰
  아래로 내려가지 않아 뷰 전체를 만든 뒤 거르기 때문이다. 그 외 `auto`.

### 3. 쿼리 형태와 실행기

**계약** `ValueProber`(Protocol, `backend/app/domain/value_probe.py`)

```python
class ValueProber(Protocol):
    def probe(self, schema: str, name: str, columns: list[ProbeColumn]) -> list[dict]: ...
    def count(self, schema: str, name: str, column: ProbeColumn, cap: int) -> int: ...

@dataclass(frozen=True)
class ProbeColumn:
    name: str
    family: str            # text | int | decimal | date | guid
    literal: str           # text-narrow | text-wide | number | date | guid  (리터럴 렌더링 방식)
    values: tuple[str | int | float, ...]   # 이 컬럼에 시도할 변형값
    op: str                # eq | contains
```

`literal`이 `text-narrow`(char/varchar)면 `'…'`, `text-wide`(nchar/nvarchar)면 `N'…'`이다.
`varchar` 컬럼에 `N'…'`을 붙이면 컬럼 쪽이 nvarchar로 변환되며 인덱스를 잃는 MSSQL 함정을
피하기 위해서다. 컬럼 쪽에는 어떤 함수도 씌우지 않는다(기존 미리보기의 `UPPER(CAST(...))`는
프로브에 쓰지 않는다). 대소문자는 리터럴 변형으로만 처리하며, 임의 혼합 대소문자는 못 잡는다는
것이 `normalized` 모드의 명시된 한계다.

**MSSQL — W2 `value_probe` / `value_count` 종류** (`tools/build_n8n_workflow.py` → 재생성)

```sql
SELECT TOP 1 [ORD_NO], [CUST_NM], [AMT]
FROM [SAP].[T_ORD]
WHERE [ORD_NO] IN ('ORD-0910-001', 'ord-0910-001') OR [CUST_NM] IN (N'…') OR [AMT] IN (1000)

SELECT COUNT(*) AS n FROM (SELECT TOP 1001 1 AS x FROM [SAP].[T_ORD] WHERE [ORD_NO] IN ('…')) q
```

요청 본문: `{kind: 'value_probe', schema, table, columns: [{name, literal, values, op}]}`,
`{kind: 'value_count', schema, table, column: {…}, cap}`. JS 쪽 렌더링 규칙:

- 식별자는 기존 `esc`, 문자열 리터럴은 기존 `lit`.
- `number`는 `Number.isFinite(Number(v))`를 통과한 값만 `String(Number(v))`로 렌더. 아니면 throw.
- `date`·`guid`는 `'…'`로 `lit` 이스케이프(MSSQL이 리터럴을 컬럼 타입으로 변환한다).
- `contains`는 `LIKE '%…%'`이며 `%`·`_`·`[`를 `[%]`·`[_]`·`[[]`로 이스케이프한다(기존
  `table_preview`는 이스케이프하지 않지만 프로브는 한다).
- `cap`은 1–5000 클램프. 컬럼 수는 1–40 검증.

**PG/SQLite — `build_probe_sql` / `build_count_sql`** (`backend/app/sources/preview_sql.py`)

```sql
SELECT "ord_no", "cust_nm", "amt" FROM "sap"."t_ord"
WHERE "ord_no" IN (:p0, :p1) OR "cust_nm" IN (:p2) OR "amt" IN (:p3) LIMIT 1

SELECT COUNT(*) AS n FROM (SELECT 1 AS x FROM "sap"."t_ord" WHERE "ord_no" IN (:p0) LIMIT 1001) q
```

식별자는 `quote_ident`, 허용 컬럼 집합 검증(`UnknownIdentifier`), 값은 전부 바운드 파라미터.
`number`는 int/Decimal, `date`는 PG엔 `date`/`datetime` 객체, SQLite엔 ISO 문자열.
`contains`는 기존 `escape_like` + `ESCAPE '\'`. `DirectValueProber(engine)`가 실행하며
행 변환은 `direct_preview._to_jsonable`을 재사용한다.

**실행기 팩토리** `create_value_prober(settings, source)` (`backend/app/adapters/__init__.py`)
— `create_table_preview`와 같은 분기: direct → `DirectValueProber`, live → `N8nValueProber`,
n8n URL이 있는데 live가 아니면 `SyntheticDataRefused`, 아니면 `FakeValueProber`.

`N8nValueProber`는 **재시도하지 않는다.** 타임아웃된 프로브를 다시 보내면 부하만 두 배다.
`_post_query`에 `retries: int` 인자를 추가해 프로브는 0으로 호출한다.

`FakeValueProber`는 `fixtures/value_sets.json`의 컬럼별 값 집합을 그대로 뒤져 히트를 만든다.
fixture 모드의 브라우저 검증과 API 테스트가 이것을 쓴다.

**히트 판정** `match_columns(row: dict, columns: list[ProbeColumn]) -> list[MatchedColumn]`
(순수 함수). 돌아온 행의 후보 컬럼값을 문자열로 정규화해 변형값과 비교한다. `text`는 변형값과
정확 비교(trim 포함), `int/decimal`은 수치 비교, `date`는 날짜 부분 비교. **돌아온 행은 백엔드
밖으로 나가지 않는다** — 응답에는 객체·컬럼·건수·`matched_variant`만 실린다.

**건수**: 히트 컬럼마다 `count(..., cap=1000)`. 1001이면 `match_count=1000, count_capped=True`.
heavy 대상은 건수 쿼리를 생략하고 `match_count=NULL`("확인됨").

**타임아웃**: PG는 엔진에 `statement_timeout`이 이미 걸려 있고 SQLite는 로컬 파일이다.
**MSSQL은 T-SQL로 서버 쪽 타임아웃을 걸 수 없다.** 파이썬 `urlopen` 타임아웃은 DB 쿼리를
취소하지 못하며, n8n MSSQL 자격증명의 `requestTimeout`(mssql 드라이버 기본 15초)이 실질 상한이다.
자격증명은 워크플로 JSON 밖에 있으므로 **배포 체크리스트 항목**으로 README에 적는다
(`n8n/workflows/README.md`).

### 4. 데이터 모델 (alembic 마이그레이션 1개)

```
value_probe_jobs
  id, data_source_id, snapshot_id, value VARCHAR(100), mode VARCHAR(12),
  hint VARCHAR(128) NULL, schemas TEXT(JSON list), status VARCHAR(16)
    CHECK IN ('queued','running','done','failed','cancelled'),
  progress_total INT, progress_done INT, cancel_requested BOOL DEFAULT FALSE,
  triggered_by VARCHAR(64), error TEXT NULL,
  created_at, started_at NULL, finished_at NULL   (timezone=True)

value_probe_targets
  id, job_id FK→value_probe_jobs.id ON DELETE CASCADE,
  object_id INT (catalog objects.id), qname VARCHAR(261), object_type VARCHAR(5),
  columns TEXT(JSON list of ProbeColumn), tier VARCHAR(5) CHECK IN ('auto','heavy'),
  heavy_reason VARCHAR(32) NULL ('rows','unknown_rows','view_shape'),
  rank INT, est_rows BIGINT NULL,
  status VARCHAR(8) CHECK IN ('pending','done','skipped','error','timeout'),
  error VARCHAR(200) NULL
  INDEX (job_id, rank)

value_probe_hits
  id, job_id FK cascade, target_id FK→value_probe_targets.id ON DELETE CASCADE,
  qname VARCHAR(261), column_name VARCHAR(128), match_count INT NULL,
  count_capped BOOL DEFAULT FALSE, matched_variant VARCHAR(100)
  INDEX (job_id)
```

계획을 행으로 남기는 이유: 진행률, heavy 목록, 선택 실행, 재시작 복원, 대상별 오류 표시가 전부
여기서 나온다. 값은 잡 행에 저장된다(러너가 DB에서 잡을 집어 가는 기존 패턴). 잡 조회는 `triggered_by == login_id` 또는
sysadmin에게만 허용해 타인의 검색값이 노출되지 않게 한다.

### 5. API (`backend/app/api/value_probe.py`, prefix `/api/value-probe`, `require_whitelisted`)

**`POST /api/value-probe`** → 202

```json
{"source_id": 1, "schemas": ["SAP"], "value": "ORD-0910-001", "mode": "normalized", "hint": "주문번호"}
```

검사 순서와 오류:

1. 소스 없음 → 404 `{"message": "data source not found", "context": {"source_id"}}`
2. 그 소스의 최신 `ready` 스냅샷 없음 → 409 `{"message": "no ready snapshot for source"}`
3. `schemas` 1–50개, 각 항목 `is_schema_hidden` → 403, `is_preview_allowed` 아님 → 403
   `{"message": "schema not allowed for preview", "context": {"schema": "..."}}`
4. `value` 1–100자(trim 후), `hint` ≤128자, `mode` Literal.
5. 플래너 실행. `mode == 'contains'`이고 auto 대상 수가 `value_probe_contains_max_tables`
   초과 → 400 `{"message": "contains mode needs a narrower scope", "context": {"auto_targets", "limit"}}`
6. 잡·대상 저장. 후보가 0이면 `status='done'`, 0/0. `progress_total`은 auto 대상 수.
7. `AuditLog(action="value_probe", detail=f"source={id} schemas={…} mode={mode} value='{value}' targets auto={n} heavy={m}")`
   — 600자 제한에 맞춰 스키마 목록은 앞 10개 + `+N`.
8. `BackgroundTasks`로 러너 한 번 깨움. 응답:

```json
{"job_id": 7, "status": "queued", "plan": {"auto": 38, "heavy": 3, "columns": 112}}
```

**`GET /api/value-probe/{job_id}`** → 200 (소유자·sysadmin 아니면 404)

```json
{
  "job_id": 7, "status": "running", "progress": {"done": 12, "total": 38},
  "error": null, "current_qname": "SAP.T_SHP",
  "value": "ORD-0910-001", "mode": "normalized", "schemas": ["SAP"], "source_id": 1,
  "hits": [
    {"object_id": 501, "qname": "SAP.T_ORD", "object_type": "table", "column": "ORD_NO",
     "match_count": 1, "count_capped": false, "matched_variant": "ORD-0910-001",
     "exposed_by_views": ["SAP.V_ORD_LIST"], "derived_from": null}
  ],
  "heavy": [{"target_id": 91, "qname": "SAP.T_ORD_HIST", "est_rows": 48210000, "reason": "rows"}],
  "failed_targets": [{"qname": "SAP.T_X", "status": "timeout"}]
}
```

`exposed_by_views`는 히트가 테이블 컬럼일 때 `ViewLineageFlat`에서 `base_object_id`·`base_column`이
일치하는 `direct` 행의 뷰 qname들. `derived_from`은 히트가 뷰 컬럼이고 `derived` 행이 있으면
`{"qname", "column"}`. 둘 다 MSSQL에서만 채워지고 다른 엔진은 빈 값. 스캔과 달리 진행 중에도
`hits`를 돌려준다. 이 GET도 러너를 한 번 깨운다(백그라운드 태스크 유실 대비, 스캔과 동일).

**`POST /api/value-probe/{job_id}/heavy`** `{"target_ids": [91]}` → 200 `{job_id, status, promoted}`.
대상이 이 잡의 `heavy`가 아니면 400. `tier='auto', status='pending'`으로 바꾸고 `progress_total`
증가, 잡이 `done/cancelled`면 `queued`로. 감사 로그 `value_probe_heavy`.

**`POST /api/value-probe/{job_id}/cancel`** → 200 `{job_id, status}`. `cancel_requested=True`.
이미 끝난 잡이면 그대로 반환.

### 6. 러너 (`backend/app/services/value_probe.py`)

`run_startable_probe_jobs(session_factory, settings)` — 스캔 러너와 같은 골격.

- 실행 중(`running`) 잡 수 ≥ `value_probe_max_concurrent`면 반환. 가장 오래된 `queued` 잡 1개.
- 소스를 읽어 `create_value_prober(settings, source)`를 만든다. `SyntheticDataRefused`·
  `CryptoNotConfigured`·`UnsupportedSource`는 잡 `failed`(error에 예외 클래스명).
- `pending`이면서 `auto`인 대상을 `rank` 순으로:
  1. `cancel_requested`면 잡 `cancelled`로 마감하고 반환.
  2. `probe()` → 행이 있으면 `match_columns` → 히트 컬럼마다 `count()`(heavy 대상은 생략)
     → `value_probe_hits` 삽입.
  3. 드라이버 오류(`DBAPIError`·`SATimeoutError`·`DisconnectionError`·`N8nQueryError`)는
     그 대상만 `error`(타임아웃류는 `timeout`)로 기록하고 계속. 오류 문자열은 200자로 자르고
     드라이버 원문 값은 남기지 않는다.
  4. 대상 상태·`progress_done`·`current`를 **대상마다 커밋**(대상 수가 스캔 후보보다 훨씬 적다).
- 전부 끝나면 `done`. 예외로 루프 자체가 깨지면 `failed`.
- 앱 기동 시 `running` 잡을 `failed`로 정리하는 기존 orphan 처리에 이 잡도 포함한다.

### 7. 설정 (`backend/app/config.py`, `.env.example`)

| 필드 | 기본 | 분류 |
|---|---|---|
| `value_probe_heavy_rows` | 2_000_000 | 튜닝 (.env) |
| `value_probe_max_concurrent` | 1 | 튜닝 (.env) |
| `value_probe_contains_max_tables` | 20 | 튜닝 (.env) |

모듈 상수: `PROBE_VALUE_MAX_LEN = 100`, `PROBE_MAX_VARIANTS = 8`, `PROBE_MAX_COLUMNS_PER_QUERY = 40`,
`PROBE_COUNT_CAP = 1000`, `PROBE_MAX_SCHEMAS = 50`.

### 8. 화면 (`frontend/src/app/trace/page.tsx`, "값 추적")

- 헤더 `LINKS`에 `{href: "/trace", key: "nav.trace"}` 추가. `MSSQL_ONLY_HREFS`에는 넣지 않는다.
- 로직은 `frontend/src/lib/value-probe.ts` 순수 함수에 두고 페이지는 얇게 유지한다
  (컴포넌트 테스트 인프라가 없다).
  - `validateProbeRequest(form) -> string | null`
  - `groupHits(hits) -> HitGroup[]` (베이스 히트 + `exposed_by_views` 접기, 뷰 파생 히트 별도)
  - `buildPreviewHref(hit, sourceId) -> string` (`/?table=<object_id>&preview=1&source=<id>&filters=<json>`,
    필터는 `[{column, op: "eq", value: matched_variant}]`)
  - `shouldKeepPolling(status) -> boolean`
  - `remainingSchemas(allowed, searched) -> string[]`
- API 함수(`frontend/src/lib/api.ts`): `startValueProbe`, `fetchValueProbeJob`,
  `runValueProbeHeavy`, `cancelValueProbe`. 타입 `ValueProbeJob`은 `ScanJobStatus` 형태를 따른다.
- 카드 4개: 조건(SourceSelector, 스키마 다중 선택 = 허용 목록 ∩ 숨김 아님, 카테고리별 묶음,
  "허용 스키마 전체" 토글, 값 입력 100자, 힌트, 모드 라디오 + contains 안내 필, [찾기]) →
  진행(상태 배지, 진행 바, 현재 대상, 경과 시간, 계획 칩, [취소]) →
  결과(히트 행: 객체 배지·컬럼·건수·`matched_variant`·[미리보기 열기], 접힌 뷰 목록, 빈 상태 +
  [나머지 허용 스키마로 계속], 접힌 실패 대상) → heavy(힌트 필, 체크박스, [선택 실행]).
- 폴링은 `CollectPanel`과 같은 `setInterval` 1.5초, `shouldKeepPolling`이 false면 정지.
- **미리보기 딥링크 확장**: `page.tsx`의 `?preview=1` 효과가 `filters` 파라미터를 파싱해
  `preview.refetch(id, {filters})`로 넘긴다. 파싱 결과는 `useMemo`로 고정한다(과거 무한 리렌더
  이슈 지점). 잘못된 JSON은 무시하고 필터 없이 연다.
- 알려진 한계: 직결 소스(PG/SQLite)의 미리보기 eq 필터는 `UPPER(CAST(col AS TEXT))` 비교라,
  소수 컬럼 히트(예: REAL 1000.0 → 변형값 '1000')는 딥링크 미리보기에서 0행이 나올 수 있다.
  MSSQL은 암시 변환으로 영향 없음. 후속 과제.
- 뷰 「쿼리 보기」(`GET /api/views/{id}/definition`): 정의 SQL은 구조 정보라 숨김 스키마만 403이고
  허용 목록·감사는 적용하지 않는다. **정책 결정**: 보이는 스키마의 뷰 정의가 숨김 스키마의
  객체·컬럼명을 본문에 담고 있으면 그대로 보인다 — 기존 `/api/views/{id}/lineage`(base_column
  무필터)·AI 뷰 설명(정의 발췌)과 같은 노출 수준이며, 숨김 정책은 그 스키마 자신의 컬럼과 값을
  막는 것이다. 운영 점검: 정의에 `OPENROWSET`·`PWD=` 같은 자격증명 리터럴이 있는지 실 카탈로그에서
  1회 확인한다. 후속 과제: AI 뷰 설명 경로에는 숨김 스키마 게이트가 없다.
- `data-testid`: `ValueProbePage-root/findButton/cancelButton/progress/emptyState/errorText/
  continueButton/heavyRunButton`, `ValueProbePage-hit-${qname}.${column}`,
  `ValueProbePage-heavy-${targetId}`, `ValueProbePage-schema-${schema}`.

### 9. 테스트

백엔드(pytest, 외부 의존만 mock):

- `test_value_probe_planner.py` — 값 해석, 패밀리·길이, 마스킹·저카디널리티·뷰 direct 제외,
  순위, heavy 분리(임계값·NULL·뷰 키워드·lineage 추정), 40컬럼 분할, `match_columns`.
- `test_probe_sql.py` — `build_probe_sql`/`build_count_sql`: 미허용 식별자 거부, 타입별 파라미터,
  `LIMIT 1`, contains 이스케이프.
- `test_n8n_workflow.py`(기존 파일에 추가) — node로 실행해 `value_probe`/`value_count` SQL 확인:
  `]`·`'` 이스케이프, 숫자 검증이 `1; DROP`을 거부, LIKE 메타문자 이스케이프, 컬럼 수·cap 클램프.
- `test_n8n_value_probe.py` — `urlopen` monkeypatch로 본문 캡처, 5xx 재시도 없음.
- `test_value_probe_api.py` — 404/409/403/400/202, 감사 detail, 타인 잡 404, 진행 중 hits,
  heavy 승격, 취소, 대상 오류 시 잡 계속, lineage 접기. `FakeValueProber` +
  `get_probe_session_factory` 오버라이드.
- `test_direct_value_probe.py` — 임시 SQLite 파일에 테이블·뷰: 올바른 컬럼 발견, 건수 상한,
  대소문자 변형, `1,000`이 숫자 컬럼에 맞음.

프론트엔드(vitest): `lib/value-probe.test.ts` — 위 순수 함수 5개.

수동: fixture 모드에서 `/trace` 클릭 스루와 미리보기 딥링크 필터 적용을 헤드리스 Chrome으로
실측한다. 커밋 전 `pytest`·`ruff`·`npm test`·`npm run lint`·`tsc`.

### 10. 문서·설정 동기화

- `.env.example`에 설정 3개와 주석.
- `README.md` 엔드포인트 표와 설정 표에 추가.
- `n8n/workflows/README.md`에 `value_probe`/`value_count` 종류와 `requestTimeout` 점검 항목.
- `PROGRESS.md` 커밋마다 갱신.
