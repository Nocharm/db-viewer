---
description: Finish setting up a project that was started by copying claude-code-template — prune unused @import lines, clean metadata.
---

당신은 `/setup-from-template` 슬래시 커맨드를 수행 중입니다. 사용자는 `claude-code-template` 을 복사해 새 프로젝트를 시작했고, 이미 `/init` 으로 Project/Commands 섹션을 만든 상태입니다. 이 커맨드의 목표는 **수동 후처리 단계 (사용 안 하는 import 가지치기, 메타 문서 정리, 검증)** 를 자동화하는 것입니다.

## 원칙

- **비가역 작업 (파일 삭제·이동) 전에는 매번 사용자 확인을 받습니다.** "다음을 진행해도 될까요? Y/N" 형태로 명시적으로 묻고, Y 가 아니면 그 단계 건너뜁니다.
- 각 단계 끝에 한 줄로 결과를 요약합니다.
- 마지막에 전체 변경 요약을 출력합니다.

## Step 0: 재실행 체크

다음 휴리스틱으로 이미 셋업된 프로젝트인지 감지합니다:
- `docs/template/` 가 없다 + `README.md` 에 `<project name>` placeholder 가 없다 → 이미 셋업된 것으로 간주.

이미 셋업된 것 같으면 사용자에게 "이미 셋업이 끝난 것 같습니다. 그래도 다시 실행할까요? Y/N" 묻고, N 이면 종료.

## Step 1: 스택 감지

다음 파일들의 존재 여부를 확인합니다:

| 시그널 | 의미 |
|---|---|
| `package.json` | JS/TS 프로젝트 |
| `pyproject.toml` 또는 `requirements.txt` | Python |

감지 결과를 사용자에게 보여줍니다:
```
감지된 스택:
- 언어: <Python | TypeScript | 둘 다 | 없음>
```

모호하면 사용자에게 "Python? TypeScript? 둘 다? 둘 다 아님?" 으로 명시적 확인을 받습니다.

## Step 2: rules @import 블록 정리

`CLAUDE.md` 를 읽고 블록별로 처리:

- `## Working Style` + `@rules/guidelines.md` (행동 가이드, 최우선): **항상 유지. 제거 금지.**
- `## Rules — 범용 (유지)`: 없으면 seed 표준 블록 추가 (`@rules/common/comments.md`~`@rules/common/testing.md`, `naming.md` 포함). 유지.
- `## Rules — 백엔드/Docker`: 백엔드/배포 아니면 블록 통째 제거 후보 (`@rules/backend/*`).
- `## Language-Specific Rules`: 감지 안 된 언어 라인 제거 후보.
  - Python 미감지 → `@rules/languages/python.md`
  - JS/TS 미감지 → `@rules/languages/typescript.md`

제거 전 "이 라인들 제거? Y/N" 한 번 확인(묶음).

## Step 3: 메타 문서 정리

다운스트림 프로젝트에서 보통 필요 없는 템플릿 메타 폴더를 정리합니다.

`docs/template/` 가 존재하면 묻습니다:
"`docs/template/` (이 템플릿의 메타 README/USAGE) 는 다운스트림 프로젝트에서 보통 삭제합니다. 삭제할까요? (Y/N)"

Y 면 `rm -rf docs/template/`. N 이면 그대로 둠.

`docs/superpowers/` 가 존재하면 묻습니다:
"`docs/superpowers/` (템플릿 자체의 plans/specs 작업 산출물) 는 다운스트림 프로젝트에서 보통 삭제합니다. 삭제할까요? (Y/N)"

Y 면 `rm -rf docs/superpowers/`. N 이면 그대로 둠.

## Step 4: 루트 README 안내

루트 `README.md` 를 grep 합니다. `<project name>` 또는 `_TODO_` 가 보이면 사용자에게 한 번 알립니다:
"루트 `README.md` 가 placeholder 상태입니다. `/init` 결과나 직접 작성으로 교체해주세요. `rules/common/documentation.md` 가 이를 강제합니다 — placeholder 상태에서 첫 의미있는 커밋을 진행하지 마세요."

## Step 5: 검증

`CLAUDE.md` 의 모든 `@` 라인을 grep 으로 추출 후, 각 경로가 실제 파일인지 확인:

```bash
grep -E '^@' CLAUDE.md | sed 's/^@//' | while read p; do
  test -e "$p" && echo "OK $p" || echo "MISSING $p"
done
```

`MISSING` 이 하나라도 있으면 사용자에게 경고 후, 잘못된 라인을 제거할지 묻습니다.

## 마무리

전체 변경 사항을 한 표로 요약합니다:

```
[변경 요약]
- 제거된 import: <목록>
- 삭제된 폴더: <목록>
- 검증 결과: 모두 OK / N개 경고
```

다음 권장 작업 안내 (자동 커밋 금지 — 사용자가 직접 수행):
- `README.md` 를 프로젝트 설명으로 교체.
- 커밋은 `rules/common/git.md` 규칙을 따른다: 커밋 직전 `PROGRESS.md` 갱신(없으면 생성) → 영/한 병기 메시지 → specific `git add <files>` (`-A` 지양).
