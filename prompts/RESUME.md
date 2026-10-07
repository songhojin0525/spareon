# 끊긴 작업 이어가기

한도 도달, 창 닫힘, 오류 등으로 작업이 중간에 끊겼을 때 쓴다. 사람은 자리에 없다고 가정하고 질문하지 않는다.

1. 상태 파악: `git status`, `git log --oneline -15`, `git stash list`, `git tag --list "stage-*"`.
2. `PROGRESS.md`에서 `IN_PROGRESS` 차수와 `현재 체크포인트`를 찾고, `docs/stages/SNN/PLAN.md`를 읽는다.
3. 커밋되지 않은 변경이 있으면 내용을 본다:
   - 체크포인트를 이어서 완성할 수 있으면 → 마저 완성 → 테스트 → 커밋.
   - 엉망이면(빌드가 깨지고 의도를 알 수 없음) → **지우지 않는다.** `git stash push -u -m "resume-backup SNN <시각>"`으로 보관하고 마지막 커밋에서 다시 시작한다. 보관 사실을 PROGRESS.md 가정 기록에 남긴다.
4. 보드에 알린다: `node scripts/status.mjs start SNN`(이어서 시작으로 기록됨). 체크포인트 수를 알면 `plan`, 이미 끝낸 체크포인트가 있으면 `cp SNN <번호>`로 맞춘다.
5. `prompts/_PROTOCOL.md`의 '3. 구현 루프'부터 이어서 진행한다. 이미 끝난 체크포인트는 다시 하지 않는다(커밋 로그로 판단).
6. `IN_PROGRESS` 차수가 없으면 `prompts/RUNNER.md`(대화형) 또는 `prompts/RUN_ONE.md`(스크립트)의 규칙대로 다음 차수로 간다.
