# n8n 워크플로 — 한 세트로 로컬·실서버 겸용

이 폴더의 JSON은 `python tools/build_n8n_workflow.py` 가 생성한다(단일 소스는
`n8n/sql/*.sql` + 생성기). **손으로 고치지 말 것** — 테스트
(`backend/tests/test_n8n_workflow.py`)가 커밋본과 생성 결과의 일치를 강제한다.

값은 `$env.DB_VIEWER_* ?? '폴백'` 표현식이라 환경에 따라 자동 분기된다:

| 환경 | 동작 |
|---|---|
| 로컬 리허설 | compose가 `$env.DB_VIEWER_*` 주입 → env 값 사용 (`docker-compose.local.yml`) |
| 실서버 (기존 n8n, UI 접근만) | env 없음 → 리터럴 폴백 사용, **키만 UI에서 교체** |

## 실서버 임포트 절차 (브라우저만 사용)

파일마다: n8n(`http://182.199.63.71:5678`) → Workflows → Add workflow →
우상단 ⋯ → **Import from File**:

| 파일 | 임포트 후 할 일 | Activate |
|---|---|---|
| `w0_recon_queries.json` | credential 연결 | ❌ (수동 실행 1회용 — 정찰 끝나면 삭제 가능) |
| `w1a_collect_catalog.json` | credential 연결 + **키 교체** | ✅ |
| `w1b_collect_viewdeps.json` | credential 연결 + **키 교체** | ✅ |
| `w2_query_executor.json` | credential 연결 | ✅ |
| `w1_catalog_snapshot.json` | (선택 — 주기 자동수집 쓸 때만) credential 연결 + **키 교체 2곳** | 쓸 때만 ✅ |

- **credential 연결**: MSSQL 노드(⚠️ 표시) 더블클릭 → Credential 드롭다운에서
  등록된 **읽기 전용** MSSQL 계정 선택. 워크플로마다 전체 MSSQL 노드에 반복.
- **키 교체**: `POST catalog` / `POST view-deps` 노드 더블클릭 → Headers의
  `X-API-Key` 값에서 `PASTE-INGEST-API-KEY-HERE` 부분을 서버 `.env`의
  `INGEST_API_KEY` 값으로 교체 (표현식 전체를 지우고 키만 남겨도 된다).
- **Activate**: 우상단 토글 — webhook은 활성일 때만 프로덕션 URL이 열린다.

source_db 라벨은 폴백 `'MSSQL'` — 실 DB명으로 바꾸려면 w1a/w1의 Code 노드에서
`source_db:` 값을 수정한다 (표시용 라벨일 뿐 동작 무관).
