---
description: 변경된 파일을 감지해 sync-checklist에서 영향받는 동기화 대상만 골라 보고·갱신한다 (일상용).
---

당신은 `/sync` 슬래시 커맨드를 수행 중입니다. 작업 중 바뀐 코드 때문에 **함께 갱신해야 하는 파일**(의존성·Dockerfile·.env·README 등)을, 변경 내용을 근거로 찾아 동기화하는 것이 목표입니다.

## 원칙

- 체크리스트의 **단일 소스는 `rules/backend/sync-checklist.md`** 입니다. 표를 복제하지 말고 그 파일을 읽어 사용합니다.
- 파일을 쓰거나 지우기 전에는 매번 사용자 확인을 받습니다.
- **자동 커밋하지 않습니다.**
- 결론부터: 무엇을 동기화해야 하는지 먼저, 근거는 그다음.

## Step 0: 전제 확인

- git 저장소가 아니면 → "git 저장소가 아니라 변경 감지를 못 합니다." 안내 후 종료.
- `rules/backend/sync-checklist.md` 가 없으면 → "동기화 체크리스트가 없습니다 (백엔드/Docker 프로젝트 전용). 종료합니다." 안내 후 종료.

## Step 1: 변경 감지

바뀐 파일을 모읍니다 (staged + unstaged + untracked):

```bash
git status --porcelain
git diff --stat HEAD
```

변경이 없으면 → "변경 사항이 없어 동기화할 게 없습니다." 한 줄 보고 후 종료.

## Step 2: 체크리스트 매칭

`rules/backend/sync-checklist.md` 의 표를 읽습니다. 각 행의 "When to update" 트리거를 Step 1 의 변경 파일과 대조해, **영향받는 행만** 추립니다.

예: 의존성 파일이 바뀌었다면 → 표에서 Dockerfile·docker-compose 행이 영향권. 코드에서 새 env 를 읽기 시작했다면 → `.env`·docker-compose·Dockerfile ENV 행이 영향권.

추측하지 말고, 실제 변경 diff 를 보고 트리거 충족 여부를 판단합니다.

## Step 3: 보고 + 동기화

영향받는 대상이 있으면 결론부터 보고:

```
[동기화 필요]
- <변경> → <대상 파일>: <무엇을 맞춰야 하는지>
```

각 대상의 실제 수정을 제안하고, 사용자 승인 후 갱신합니다 (쓰기 전 확인).
영향받는 대상이 없으면 → "변경은 있으나 동기화 대상 없음." 한 줄 보고.
