# 러너 — 자리를 비운 동안 차수를 연속으로 진행

너는 이 세션의 **지휘자**다. 차수를 직접 코딩하지 않는다. 차수마다 서브에이전트를 띄워 맡기고, 결과를 확인하고, 다음 차수로 넘어간다. 차수마다 새 서브에이전트를 쓰는 이유는 맥락을 깨끗하게 유지하기 위해서다. 서브에이전트를 쓸 수 없는 환경이면 `prompts/RUN_ONE.md` 방식으로 직접 한 차수씩 수행한다.

사람은 자리에 없다. 질문하지 않는다.

## 시작 전 확인
- `PROGRESS.md`에서 S00이 `DONE` 계열이 아니면 멈추고 `RUN_SUMMARY.md`에 "S00은 사람이 있을 때 `/stage S00`으로 먼저 실행하세요"라고 적는다(S00은 도구 설치·권한 확인 때문에 사람이 있을 때 권장).
- `IN_PROGRESS`인 차수가 있으면 그 차수부터 이어서 한다(서브에이전트 지시에 RESUME 절차를 포함).

## 반복
1. **다음 차수 고르기** — `PROGRESS.md`와 `prompts/STAGES.md`를 읽고:
   - 상태가 `TODO` 또는 `IN_PROGRESS`이고
   - 모든 의존 차수가 `DONE` 또는 `DONE_NEEDS_HUMAN`인 차수 중
   - 번호가 가장 작은 것.
   - 없으면 '끝내기'로.
2. **맡기기** — 먼저 `node scripts/status.mjs runner "SNN → subagent"`로 보드에 남기고, 서브에이전트(general-purpose)에게 아래 지시를 그대로 준다(`SNN`과 파일명만 바꿔서):
   > CLAUDE.md와 prompts/_PROTOCOL.md를 따르고 prompts/SNN_xxx.md 차수를 끝까지 수행하라. 사람은 자리에 없으니 질문하지 말 것. 이 차수가 IN_PROGRESS로 중단된 상태라면 prompts/RESUME.md를 먼저 따를 것. 게이트 단계에서는 adversarial-reviewer 서브에이전트로 검토할 것. 끝나면 docs/stages/SNN/REPORT.md의 상태와 '한 일' 5줄만 답하라.
3. **확인** — 서브에이전트가 끝나면 지휘자가 직접 확인한다(긴 출력은 읽지 말고 핵심만):
   - `git status`가 깨끗한가, 상태가 DONE 계열이면 태그 `stage-SNN-done`이 있는가
   - `pnpm verify`가 통과하는가
   - `docs/stages/SNN/REPORT.md`가 있고 PROGRESS.md가 갱신됐는가
   - 보드 기록이 PROGRESS.md와 다르면(예: 서브에이전트가 `finish`를 빠뜨림) 지휘자가 `node scripts/status.mjs finish SNN <상태> "<요약>"`으로 맞춘다.
   - 실패가 있으면: `status.mjs runner "SNN retry: <이유>"`를 남기고, 실패 요약을 붙여 같은 차수를 **새** 서브에이전트에게 한 번 더 맡긴다("이전 시도의 실패: … 이것부터 고쳐라"). 그래도 실패하면 PROGRESS에 `BLOCKED`와 원인 한 줄.
4. **기록** — PROGRESS.md '실행 기록'에 한 줄: 시각, 차수, 결과, 소요 시간, 메모.
5. 다음 반복으로.

## 끝내기
- 다음 중 하나면 멈춘다: 남은 차수 없음 / 시작 가능한 차수 없음(전부 의존 대기 또는 BLOCKED) / 연속 2개 차수 BLOCKED.
- 멈출 때 `RUN_SUMMARY.md`에 이번 실행 요약을 **덧붙인다**: 시작·종료 시각, 끝낸 차수, 막힌 차수와 이유, 사람이 할 일 상위 3개(HUMAN_TODO에서), 다음 실행 때 시작할 차수.
- 그 내용을 커밋한다(`runner: summary`).
- 마지막으로 `node scripts/status.mjs runner "stop: <멈춘 이유>"`.

## 주의
- 지휘자의 맥락을 가볍게 유지한다. 서브에이전트의 긴 출력은 요약만 남긴다.
- 차수 문서(`prompts/S*.md`)를 고치지 않는다. 다음 차수에 필요한 변경은 각 REPORT의 '다음 차수에 미치는 영향'으로 전달된다.
- 한도에 걸려 중간에 멈춰도 괜찮다. 각 차수는 체크포인트마다 커밋하므로, 다음에 `/resume`이나 `/run`으로 이어진다.
