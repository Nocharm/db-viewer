# 배포·연결 런북 (맥 → GitHub → 윈도우 → 사내 서버)

이동 경로: **맥(개발) → GitHub `main` → 윈도우 PC(`git pull`) → 사내 서버(업로드) → Docker 배포**.
사내 서버는 결과 복붙이 어려우므로, 각 단계 끝의 **✅ 통과 기준은 전부 화면으로 눈 확인**만
하면 되게 구성했다. 코드는 모두 준비되어 있고 이 문서의 작업은 설정·임포트·확인이다.

---

## 1. 윈도우에서 받기 — LF 줄바꿈 안전 확인

`.gitattributes`가 전 파일 LF를 강제(`* text=auto eol=lf`)하므로 기본적으로 안전하다.
다만 윈도우 git의 전역 설정이 우선 적용되는 사고를 막기 위해 **클론 전에 1회**:

```bat
git config --global core.autocrlf false
git clone git@github.com:Nocharm/db-viewer.git
```

- ✅ 통과 기준: 클론 폴더에서 `git ls-files --eol | findstr /i crlf` 실행 → **아무것도 출력되지 않으면 통과**
  (한 줄이라도 나오면 `git rm -rf --cached . && git checkout .` 후 재확인).
- 서버 업로드는 폴더 통째 압축(zip) → 전송 → 해제. 압축은 줄바꿈을 건드리지 않는다.

## 2. 서버에서 Docker 배포

서버의 압축 해제 폴더에서:

```bash
cp .env.example .env      # 아래 값 채우기
docker compose up -d --build
```

`.env`에서 반드시 채울 값 (나머지는 기본값 유지 가능):

| 키 | 값 |
|---|---|
| `POSTGRES_PASSWORD` | 임의 강력값 |
| `AUTH_ENABLED` | `true` |
| `DBV_SYSADMINS` | 본인 login_id (콤마 구분) |
| `INGEST_API_KEY` | 임의 강력값 — `/api/ingest/*`를 외부 호출로부터 보호 (n8n은 쓰지 않는다) |
| `N8N_WEBHOOK_BASE` | `http://182.199.63.71:5678/webhook` |
| `SOURCE_MODE` | **`fixture` 유지** — live는 8단계에서 승인 후 |
| `LDAP_*` 4종 | AD 계정 정보 (+사내 CA면 `LDAP_CA_BUNDLE`) |

- ✅ 통과 기준 (전부 브라우저로):
  - `http://182.199.63.71:6678/api/health` → `{"status":"ok"}` 표시
  - `http://182.199.63.71:6678` → 로그인 화면으로 이동
- 안 되면: 서버에서 `docker compose ps` — 세 서비스(postgres/backend/frontend)가 `healthy/running`인지 눈 확인.

## 3. Keycloak 설정 (서버 배포는 되어 있음 — 클라이언트만 등록)

`http://182.199.63.71:8080` 관리 콘솔 → realm **ai-portal** 선택 → Clients → Create client:

| 항목 | 값 |
|---|---|
| Client ID | `db-viewer-frontend` (public, Standard flow) |
| Valid redirect URIs | `http://182.199.63.71:6678/*` |
| Valid post logout redirect URIs | `http://182.199.63.71:6678/login` |
| **Web origins** | `http://182.199.63.71:6678` ← 누락이 최다 사고 원인 |

- ✅ 통과 기준: 앱 접속 → Keycloak 로그인 → **테이블 브라우저로 복귀**하고 우상단에 내 이름 표시.
  - 미등록 계정이면 "화이트리스트에 없습니다" 화면이 정상 — 관리 콘솔(`/admin`, sysadmin 계정)에서 등록.
  - 로그인 복귀 시 `failed to fetch` → Web origins 누락 (README 트러블슈팅 표).

## 4. n8n 워크플로 등록 (기존 n8n에 UI로만)

실서버 n8n은 이미 운영 중이고 **UI로만 접근 가능**하다. 워크플로는 전부 3노드짜리
**단문 쿼리 실행기**라 임포트 후 편집할 값이 없다 — 환경변수도 API 키도 참조하지 않는다
(수집의 연쇄 호출은 백엔드가 주도하고, 결과는 HTTP 응답으로 돌아온다).

윈도우 PC의 `n8n/workflows/*.json` 3개를 브라우저(`http://182.199.63.71:5678`)에서
Import from File — 파일별 역할은 **`n8n/workflows/README.md` 표** 참조:

1. 각 워크플로의 MSSQL 노드(⚠️)에 기존 credential 연결
   (Request Timeout 300000 권장 — 뷰 DMV 배치가 수십 초 걸린다)
2. **W1 catalog query**·**W2 query executor** Activate (webhook은 활성일 때만 응답).
   W0 recon은 사람이 UI에서 1회 실행하는 진단이라 Activate 불필요.

- ✅ 통과 기준: 워크플로 목록에 W0·W1·W2가 보이고, W1/W2가 Active 토글 켜짐 +
  세 워크플로의 노드에 ⚠️(credential 미연결) 표시 없음.

## 5. 정찰 — 정지점 16 (읽기 전용, 복붙 불필요)

n8n에서 **W0 recon queries** 열기 → Execute Workflow → 마지막 **Recon report** 노드 클릭 →
출력 JSON을 화면에서 눈으로 판독:

| 볼 항목 | 통과 기준 | 실패 시 |
|---|---|---|
| `view_definition_permission.blocked` | **0** | 계정에 `VIEW DEFINITION` 권한 요청 (최우선 — 뷰 역추적의 원천) |
| `warnings` 배열 | **비어 있음** | 항목 문구가 곧 조치 내용 (DMV 실패 등) |
| `fk_count`, `object_scale` | 숫자만 메모 (판단 참고) | — |

- 여기서 멈추고 판단 — blocked>0이면 권한 해결 후 재실행. 숫자 몇 개만 메모하면 되고 복붙은 필요 없다.

## 6. 실 카탈로그 수집 — 정지점 17

앱 → **관리** → 카탈로그 수집 → **[1단계: 카탈로그 수집]** → 스테퍼가 "카탈로그 적재 완료"가 되면
**[2단계: 뷰 의존·파싱]** (다음부턴 [전체 실행] 하나로 가능).

> `.env`의 `N8N_WEBHOOK_BASE`가 비어 있으면 실수집이 아니라 **픽스처 리플레이로 falls back**하고,
> 배포 이미지엔 픽스처가 없어 `fixture ... not found`로 실패한다. 값을 채운 뒤
> `docker compose up -d backend`로 재기동할 것 (SOURCE_MODE는 `fixture` 그대로 둔다).

- ✅ 통과 기준 (전부 화면):
  - 수집 패널 스테퍼 4단계 전부 ✓ + 카운트(objects/columns/deps/lineage)가 실 규모(테이블 2,342·뷰 882 — 정지점 16 실측)와 부합
  - **파싱 지표** 페이지 → 성공률 표시 + 격리 목록 확인 (실 뷰 SQL 기준 — 낮으면 격리 뷰 이름 메모)
  - **테이블** 페이지 → 실 테이블명 목록, ERD → 실 관계선
- 이 시점 미리보기는 아직 **합성 데이터**, T2 검증은 "값 데이터 없음"이 정상.

## 7. (보안 승인 대기 중에도 가능) 화이트리스트·AD 확인

관리 콘솔에서 **[AD 전체 동기화]** → 아래 **AD 사용자** 목록에 인원이 채워지면, 접속시킬 사람의
행에서 **[허용 추가]**를 눌러 화이트리스트에 넣는다 (동기화만으로는 로그인이 열리지 않는다 —
두 목록은 별개 테이블).
- ✅ 통과 기준: 동기화 완료 메시지의 스캔/반영 수가 상식적 규모 + **AD 사용자 목록에 실제 인원 표시**
  + 허용 추가한 사람이 화이트리스트 표에 나타남.

## 8. live 전환 — 정지점 18 (보안 승인 후에만)

서버 `.env`에서 `SOURCE_MODE=live`로 변경 → `docker compose up -d backend` (재기동).

- ✅ 통과 기준 (전부 화면):
  - 아는 테이블 미리보기 → **실제 값**이 보임 (합성 "샘플…" 문구가 아님) + 필터 재조회 동작
  - ERD에서 확실한 FK 페어 하나 T2 검증 → containment **100%** 근처 + 1:N
  - 마스킹 대상 컬럼이 ●●● 로 보임 (지정했다면)
- 실패 시: W2가 Active인지, `.env`의 `N8N_WEBHOOK_BASE` 오타 여부 — 백엔드 오류 메시지에 원인이 명시된다.

## 9. AI 실 LLM 연결 (선택 — 언제든 가능, n8n과 무관)

서버 `.env`에 사내 LLM 정보를 채우고 backend만 재기동:

```
AI_BASE_URL=http://<사내LLM호스트>:<포트>/v1   # OpenAI 호환 (Ollama/vLLM/LiteLLM)
AI_MODEL=<서버에 로드된 모델명>
AI_API_KEY=            # 무인증 서버면 비워둔다
```

`docker compose up -d backend` (재기동).

- ✅ 통과 기준 (전부 화면):
  - 테이블 상세 → AI 요약 재생성 → 휴리스틱 문장("주요 컬럼: …")이 아닌 자연어 요약
  - 검색창 `?` 프리픽스 질의 → 관련도 순 결과
  - ERD 페이지의 AI 관계 제안 버튼 → 『N건 판정, M건 생성』 안내 + 생성분이 ERD에
    `ai_suggested`(파선) 엣지로 유입 (상한 `AI_SUGGEST_MAX_PAIRS`=40)
- 재실행은 다음 순위 후보로 페이징된다 — `생성 0·판정 40`은 후보 소진이 아니라
  현재 창 전량 기각일 수 있다(`temperature=0`이라 같은 창은 재실행해도 같은 결과).
- 실패 시: 연결 실패(LLM 서버 다운 등)는 화면에 502와 함께 url·모델이 표시되고,
  응답 파싱 실패는 응답 원문 발췌가 표시된다 — `AI_BASE_URL` 오타, 모델명 불일치 순으로 확인.
  응답이 느리면 `AI_TIMEOUT` 상향 (재시도 1회 포함 최악 지연은 `2×AI_TIMEOUT`).
- `AI_BASE_URL`을 비우면 즉시 기존 목업으로 복귀한다 (재기동 필요).

## 부하·안전 장치 (이미 코드에 있음)

- T2는 후보 축소 뒤 **페어 단위 핀포인트** 질의만 — 일괄 검증도 타깃 상한 8.
- 미리보기 상한 500 서버 고정 + W2 내부에서도 1~500 클램프.
- W2는 고정 템플릿 3종만 실행(식별자·리터럴 이스케이프, 그 외 kind 거부) — 동적 SQL 미수신.
- DB 자격증명은 n8n에만 존재 — 백엔드는 원본 DB에 직접 닿지 않는다.
- 대형 테이블 containment 대비 `N8N_QUERY_TIMEOUT`(기본 120초).

## 남은 결정 (연결 후)

- T3 탐색 스캔 야간 운용 정책 (동시 2개 제한은 기본 적용).
