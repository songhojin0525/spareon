# 한 차수만 수행 (스크립트 실행용)

`scripts/run-stages.ps1`·`run-stages.sh`가 매번 새 Claude Code 프로세스로 이 파일을 실행한다. 한 번에 **정확히 한 차수**만 하고 끝낸다. 사람은 자리에 없다. 질문하지 않는다.

1. `.runner/` 폴더가 없으면 만든다(gitignore 대상).
2. `prompts/RUNNER.md`의 '시작 전 확인'과 '다음 차수 고르기' 규칙으로 차수 하나를 고른다.
   - 고른 차수는 `node scripts/status.mjs runner "SNN → script run"`으로 보드에 남긴다.
   - S00이 끝나지 않았으면 `.runner/STATUS`에 `STOP: S00 needs a human`을 쓰고 끝낸다.
   - 고를 차수가 없으면 `.runner/STATUS`에 `STOP: <이유>`를 쓰고 끝낸다.
3. 그 차수가 `IN_PROGRESS`(중단됨)이면 `prompts/RESUME.md`를 먼저 따른다.
4. `CLAUDE.md`와 `prompts/_PROTOCOL.md`를 따라 그 차수를 끝까지 **직접** 수행한다(게이트 단계의 적대적 검토는 `adversarial-reviewer` 서브에이전트 사용).
5. PROGRESS.md '실행 기록'에 한 줄 추가하고 커밋한다. 보드 기록이 PROGRESS.md와 다르면 `node scripts/status.mjs finish SNN <상태> "<요약>"`으로 맞춘다.
6. `.runner/STATUS`에 쓴다:
   - 차수가 DONE 또는 DONE_NEEDS_HUMAN → `CONTINUE`
   - 차수가 BLOCKED이고 직전 실행 기록도 BLOCKED → `STOP: blocked twice`
   - 차수가 BLOCKED(처음) → `CONTINUE`
