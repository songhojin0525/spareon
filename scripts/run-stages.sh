#!/usr/bin/env bash
# spareon 차수 자동 실행 스크립트 (macOS / Linux / WSL / Claude Code 클라우드)
#
# - 한 번에 한 차수씩, 매번 새 Claude Code 프로세스로 실행합니다(매번 깨끗한 맥락).
# - Claude가 .runner/STATUS 에 STOP 을 쓰거나, 상태 파일이 없거나(한도 도달·오류 등),
#   claude가 0이 아닌 종료 코드를 내면 멈춥니다.
# - 아래 CLAUDE_ARGS 의 옵션 이름은 Claude Code 버전에 따라 다를 수 있습니다.
#   처음 한 번 `claude --help` 로 확인하고 필요하면 고치세요.
#
# 사용 예:
#   bash scripts/run-stages.sh            # 기본: 최대 40회, opus
#   MAX_STAGES=3 MODEL=sonnet bash scripts/run-stages.sh
set -u

MAX_STAGES="${MAX_STAGES:-40}"
MODEL="${MODEL:-opus}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
mkdir -p .runner

PROMPT="prompts/RUN_ONE.md 파일을 읽고 그 지시를 그대로 수행하라. 사람은 자리에 없다. 질문하지 말 것."

for ((i = 1; i <= MAX_STAGES; i++)); do
  rm -f .runner/STATUS
  stamp="$(date +%Y%m%d-%H%M%S)"
  log=".runner/log-$stamp.txt"
  echo "[$stamp] $i 번째 실행 시작 (모델: $MODEL)"
  node scripts/status.mjs runner "script run $i start (model $MODEL)" >/dev/null 2>&1 || true

  claude -p "$PROMPT" --model "$MODEL" --permission-mode acceptEdits 2>&1 | tee "$log"
  code="${PIPESTATUS[0]}"

  if [ "$code" -ne 0 ]; then
    echo "claude 종료 코드 $code - 사용 한도 도달이나 오류일 수 있습니다. 멈춥니다. 로그: $log"
    break
  fi
  if [ ! -f .runner/STATUS ]; then
    echo "상태 파일이 없습니다(중간에 끊긴 것 같습니다). 멈춥니다. 다음엔 Claude Code에서 /resume 을 실행하세요."
    break
  fi
  status="$(tr -d '\r' < .runner/STATUS | head -n 1)"
  echo "상태: $status"
  case "$status" in
    CONTINUE*) ;;
    *) break ;;
  esac
done

node scripts/status.mjs runner "script stopped" >/dev/null 2>&1 || true
echo "끝났습니다. 진행 보드: node scripts/board.mjs --web --open · 진행 상황은 PROGRESS.md, 사람이 할 일은 HUMAN_TODO.md 를 보세요."
