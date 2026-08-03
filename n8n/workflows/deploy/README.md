# 배포용 워크플로 (기존 n8n에 UI로만 임포트)

원본(`../*.json`)은 컨테이너 환경변수(`$env.DB_VIEWER_*`)를 참조하지만, 실서버 n8n은
이미 운영 중이라 env를 추가할 수 없다. 이 폴더의 사본은 **값이 리터럴로 박혀 있어
UI 임포트만으로 동작한다.** 유일한 예외는 비밀키 — git에 커밋할 수 없으므로
플레이스홀더를 UI에서 한 번 교체한다.

## 임포트 절차 (브라우저만 사용)

파일마다 반복 — n8n(`http://182.199.63.71:5678`) → Workflows → Add workflow →
우상단 ⋯ → **Import from File**:

| 파일 | 임포트 후 할 일 | Activate |
|---|---|---|
| `w0_recon_queries.json` | MSSQL 노드에 credential 연결 | ❌ (수동 실행용) |
| `w1a_collect_catalog.json` | credential 연결 + **키 교체** | ✅ |
| `w1b_collect_viewdeps.json` | credential 연결 + **키 교체** | ✅ |
| `w2_query_executor.json` | credential 연결 | ✅ |
| `w1_catalog_snapshot.json` | (선택 — 주기 자동수집 쓸 때만) credential 연결 + **키 교체 2곳** | 쓸 때만 ✅ |

- **credential 연결**: MSSQL 노드(⚠️ 표시) 더블클릭 → Credential 드롭다운에서
  기존에 등록된 MSSQL 계정 선택. 워크플로마다 전체 MSSQL 노드에 반복.
- **키 교체**: `POST catalog` / `POST view-deps` 노드 더블클릭 → Headers의
  `X-API-Key` 값 `PASTE-INGEST-API-KEY-HERE` 를 서버 `.env`의 `INGEST_API_KEY` 값으로 교체.
- **Activate**: 우상단 토글 — webhook은 활성일 때만 프로덕션 URL이 열린다.

박혀 있는 값: API base `http://182.199.63.71:6678`, source_db 라벨 `'MSSQL'`
(실 DB명으로 바꾸려면 w1a/w1의 Code 노드에서 `source_db:` 값 수정 — 표시용 라벨일 뿐 동작 무관).

## 원본과의 동기화

원본 워크플로를 수정하면 이 사본도 같이 갱신할 것. `w0`·`w2`는 원본과 동일 내용,
`w1`·`w1a`·`w1b`는 위 리터럴 치환만 다르다.
