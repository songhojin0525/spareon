---
description: 진행 상황과 사람이 할 일을 짧게 요약
---
먼저 `node scripts/board.mjs --once --no-color --rows 45 --cols 110`을 실행해 보드를 한 번 출력하라(실패하면 건너뛴다).
그다음 PROGRESS.md, HUMAN_TODO.md, RUN_SUMMARY.md(있으면)를 읽고 한국어로 짧게 알려 줘:
1. 끝난 차수 / 진행 중 / 막힌 차수 (막힌 이유 한 줄씩)
2. 마지막 실행에서 한 일 3줄
3. 지금 내가(사람이) 해야 할 일 상위 3개와 각각 어디를 보면 되는지
4. 다음에 실행하면 시작할 차수
5. 보드를 계속 띄워 보려면: 다른 터미널에서 `node scripts/board.mjs`(터미널) 또는 `node scripts/board.mjs --web --open`(브라우저)
파일은 고치지 말 것.
