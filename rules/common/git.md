# Git Conventions

```
type(scope): English summary — 한국어 요약

# Types: feat, fix, docs, refactor, test, chore, perf
# Scope: optional, module or feature name
```

- Commit messages explain **WHY**, not WHAT.
- **Write the description in both English and Korean** so it's easy to grasp at a glance (`type(scope): English summary — 한국어 요약`).
- One logical change per commit.
- Never amend published commits without explicit request.
- Never force-push to main/master.
- Prefer specific `git add <files>` over `git add .` or `git add -A`.

## Before Every Commit

커밋 직전 항상 확인한 뒤 스테이징·커밋한다:

1. **`PROGRESS.md` 갱신** — 저장소 루트의 진행 현황 로그(없으면 생성)에 무엇을·왜 바꿨는지 기록한다.
   - 항목은 간결하게 — 커밋당 1–3줄, WHAT 나열보다 맥락·결정 위주 (WHAT은 커밋 메시지가 담당).
   - 갱신하는 김에 압축 가능한 기존 항목(같은 작업의 중간 단계, 되돌린 시도)은 요약으로 합친다.
2. **README 영향 확인** — 이번 커밋이 README가 설명하는 내용(커맨드, 구조, 설정, 사용법)을 바꿨으면 해당 섹션을 같은 커밋에서 갱신한다. 영향 없으면 건드리지 않는다. 전수 점검은 `/sync-all` (문서 규칙: `documentation.md`).

## On Branch Merge

브랜치를 main에 머지할 때, 그 브랜치에서 쌓인 `PROGRESS.md` 항목들을 **하나의 요약 항목으로 압축**한다 — 브랜치의 목적·결과·주요 결정만 남기고 중간 시행착오 항목은 삭제한다. 머지 커밋(또는 머지 직후 커밋)에서 수행하며, PROGRESS 머지 충돌도 이 요약본으로 해소한다.
