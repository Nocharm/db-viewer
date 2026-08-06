# n8n 워크플로 — 단문 쿼리 실행기

**원칙: n8n 워크플로는 짧게 유지한다.** 실행기는 `webhook → Code(고정 SQL 선택) → MSSQL`
3노드가 전부이고, 캐스케이드(객체 목록 → 그 객체들의 컬럼 → 키 → 뷰 정의 …)는
**백엔드가 주도한다**(`backend/app/adapters/collect_runner.py`). n8n은 상태도 분기도 갖지 않는다.

```
백엔드                                   n8n (W1)              MSSQL
  │  kind=totals                          │                      │
  ├─────────────────────────────────────► │ ── SELECT COUNT ───► │
  │  kind=objects (offset/limit)          │                      │
  ├─────────────────────────────────────► │ ── 페이지 1 ───────► │
  │  kind=columns (object_ids=[…])        │                      │
  ├─────────────────────────────────────► │ ── 그 id들만 ─────► │
  │  … 페이지마다 반복, 적재는 백엔드에서
```

이 구조의 이점: 소스 DB 점유·n8n 메모리·응답 크기가 **페이지 하나 크기로 묶인다**.
페이지 크기는 `.env`의 `COLLECT_CATALOG_CHUNK_SIZE`(객체) / `COLLECT_DEPS_CHUNK_SIZE`(뷰).

JSON은 `python tools/build_n8n_workflow.py`가 생성한다(단일 소스는 `n8n/sql/*.sql`).
**손으로 고치지 말 것** — 테스트가 커밋본과 생성 결과의 일치를 강제한다.

## 임포트 절차 (브라우저만 사용)

n8n(`http://182.199.63.71:5678`) → Workflows → Add workflow → 우상단 ⋯ → **Import from File**:

| 파일 | 역할 | 임포트 후 할 일 | Activate |
|---|---|---|---|
| `w1_catalog_query.json` | 수집 쿼리 실행기 (백엔드가 호출) | credential 연결 | ✅ |
| `w2_query_executor.json` | live 검증·미리보기 실행기 | credential 연결 | ✅ |
| `w0_recon_queries.json` | 배포 전 진단 1회용 (사람이 UI에서 실행) | credential 연결 | ❌ |

- **credential 연결**: MSSQL 노드(⚠️ 표시) 더블클릭 → Credential 드롭다운에서 등록된
  **읽기 전용** 계정 선택. Request Timeout은 300000(5분) 권장.
- **Activate**: 우상단 토글 — webhook은 활성일 때만 프로덕션 URL이 열린다.
- **편집할 값 없음** — 환경변수도 API 키도 참조하지 않는다. n8n이 백엔드를 호출하지 않고
  백엔드가 n8n을 호출하기 때문(수집 결과는 HTTP 응답으로 돌아온다).
- **재임포트**: 이미 임포트된 워크플로에 새 JSON을 다시 Import from File 하면 credential
  연결과 Activate 상태가 풀린다 — 매번 credential 재선택 + 재활성화가 필요하다.

## 재임포트 후 미리보기가 안 나올 때

임포트 자체는 성공해도 실행 결과가 화면에 안 붙는 경우가 있다. 위에서부터 확인:

| 화면 증상 | 원인 | 조치 |
|---|---|---|
| **빈 표 + "원본 소스가 0행을 반환했습니다"** | W2는 정상 실행됐고 쿼리 결과가 실제로 0행 | 그 테이블이 비었거나(카탈로그 `row_count` 확인), MSSQL credential이 **다른 DB**를 보고 있다 — 노드의 credential이 W1과 같은지 확인 |
| **502 + `status=404`** | webhook 경로 불일치 또는 워크플로 **비활성** | 우상단 Activate 토글, `path=dbv-query`와 `.env`의 `N8N_WEBHOOK_BASE` 확인 |
| **502 + `status=500`** | MSSQL 노드 실패 (credential 미연결·권한) | 노드의 ⚠ 표시 → 읽기 전용 credential 재선택. W1은 `sys.*`만 읽어서 통과해도, W2는 **사용자 테이블 SELECT 권한**이 따로 필요하다 |
| **502 + `status envelope`** | Respond 설정이 `lastNode`/`allEntries`가 아님 | 임포트본을 그대로 쓸 것 (손으로 고치지 말 것) |
| 미리보기 버튼이 아예 잠김 | n8n 문제가 아니다 | 관리 콘솔 → *미리보기 허용 테이블*에 등록 (기본 전부 차단) |

- 재임포트할 때 **옛 W2를 먼저 비활성/삭제**할 것 — 같은 `dbv-query` 경로를 두 워크플로가
  들고 있으면 어느 쪽이 응답할지 보장되지 않는다.
- 오류 본문(상태코드·n8n 메시지)은 백엔드가 502 응답에 그대로 실어 화면까지 보낸다.

## 워크플로별 계약

- **W1 `dbv-catalog`** — body `{kind, offset/limit 또는 object_ids}`. kind는 `totals`,
  `objects`, `columns`, `key_constraints`, `foreign_keys`, `view_definitions`,
  `view_deps`, `view_refs`. 파라미터는 **정수만** 보간되고 SQL 문자열은 받지 않는다.
- **W2 `dbv-query`** — body `{kind, 식별자…}`. kind는 `containment`, `join_preview`,
  `table_preview`, `multi_join_preview`. 값 데이터에 닿으므로 `SOURCE_MODE=live` 게이트
  뒤에서만 쓰인다(W1은 메타데이터 전용이라 게이트와 무관 — 두 실행기를 분리해 둔 이유).
  - `multi_join_preview` — body `{kind: "multi_join_preview", limit, steps: [...]}`.
    각 step은 `{left_schema, left_table, left_column, right_schema, right_table,
    right_column, join_type}`(`join_type`은 `inner` | `left`). 첫 step의 left가 FROM,
    이후 각 step이 JOIN 한 줄을 추가한다(별칭 t0..tN, `tools/build_n8n_workflow.py` 참고).
  - **노드 4개**(다른 kind와 공유) — `webhook → Build query(Code) → MSSQL →
    Attach query(Code)`. 마지막 `Attach query` 노드가 실행문과 결과를 `{query, rows}`
    단일 객체로 묶어 응답하며, webhook은 `responseData=firstEntryJson`을 쓴다 — W1은
    행마다 아이템 하나씩 내므로 `allEntries`가 필요하지만, W2는 Attach query가 이미
    전 행을 하나로 묶어 두었으니 `allEntries`를 쓰면 그 단일 아이템이 배열에 한 번 더
    감싸여 `{query, rows}` 계약이 깨진다 — **W1과 일부러 다르게 둔다.**
  - **백엔드 하위호환** — `backend/app/adapters/n8n_query.py`의 `_post_query`가 신형
    `{query, rows}` 응답과 구형(행 리스트만) 응답을 모두 받는다. 재임포트가 늦어 구
    W2가 아직 떠 있어도 `containment` / `join_preview` / `table_preview`는 그대로
    동작하고, `multi_join_preview`만 "재배포 필요" 메시지와 함께 502로 멈춘다 —
    깨지는 대신 저하된다(a stale W2 degrades rather than breaks).
- **W0** — 정찰 6종 + 리포트. 유일한 다중 노드 워크플로이며 백엔드 경로가 없다
  (배포 전 1회 진단용, 끝나면 삭제 가능).
