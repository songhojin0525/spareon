<#
  binjari 차수 자동 실행 스크립트 (Windows PowerShell 5.1 / PowerShell 7)

  - 한 번에 한 차수씩, 매번 새 Claude Code 프로세스로 실행합니다(매번 깨끗한 맥락).
  - Claude가 .runner/STATUS 에 STOP 을 쓰거나, 상태 파일이 없거나(한도 도달·오류 등),
    claude가 0이 아닌 종료 코드를 내면 멈춥니다.
  - 아래 $ClaudeArgs 의 옵션 이름은 Claude Code 버전에 따라 다를 수 있습니다.
    처음 한 번 `claude --help` 로 확인하고 필요하면 고치세요.

  사용 예:
    powershell -ExecutionPolicy Bypass -File scripts\run-stages.ps1
    powershell -ExecutionPolicy Bypass -File scripts\run-stages.ps1 -MaxStages 3 -Model sonnet
#>
param(
  [int]$MaxStages = 40,
  [string]$Model = "opus"
)

# PowerShell 5.1에서 네이티브 명령의 stderr를 오류로 취급해 멈추지 않도록 Continue로 둡니다.
$ErrorActionPreference = "Continue"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot
New-Item -ItemType Directory -Force -Path ".runner" | Out-Null

$Prompt = "prompts/RUN_ONE.md 파일을 읽고 그 지시를 그대로 수행하라. 사람은 자리에 없다. 질문하지 말 것."
$ClaudeArgs = @("-p", $Prompt, "--model", $Model, "--permission-mode", "acceptEdits")

for ($i = 1; $i -le $MaxStages; $i++) {
  Remove-Item -ErrorAction SilentlyContinue ".runner/STATUS"
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $log = ".runner/log-$stamp.txt"
  Write-Host "[$stamp] $i 번째 실행 시작 (모델: $Model)"
  try { & node scripts/status.mjs runner "script run $i start (model $Model)" *> $null } catch { }

  & claude @ClaudeArgs 2>&1 | Tee-Object -FilePath $log
  $code = $LASTEXITCODE

  if ($code -ne 0) {
    Write-Host "claude 종료 코드 $code - 사용 한도 도달이나 오류일 수 있습니다. 멈춥니다. 로그: $log"
    break
  }
  if (-not (Test-Path ".runner/STATUS")) {
    Write-Host "상태 파일이 없습니다(중간에 끊긴 것 같습니다). 멈춥니다. 다음엔 Claude Code에서 /resume 을 실행하세요."
    break
  }
  $status = (Get-Content ".runner/STATUS" -Raw).Trim()
  Write-Host "상태: $status"
  if (-not $status.StartsWith("CONTINUE")) { break }
}

try { & node scripts/status.mjs runner "script stopped" *> $null } catch { }
Write-Host "끝났습니다. 진행 보드: scripts\board-web.cmd 더블클릭 · 진행 상황은 PROGRESS.md, 사람이 할 일은 HUMAN_TODO.md 를 보세요."
