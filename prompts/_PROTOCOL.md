# 차수 실행 규칙 (_PROTOCOL)

모든 차수(S00~S32)는 이 규칙을 따른다. 충돌하면 **CLAUDE.md 절대 규칙 > 이 문서 > 차수 문서** 순으로 따른다.

## 0. 자세
- 사람은 자리에 없다. 질문하지 않고 끝까지 간다.
- 각 차수는 한 세션에 끝낼 수 있는 큰 작업이다. 일찍 멈추지 않는다. 수용 기준을 모두 통과한 뒤 여력이 있으면 '선택 확장'까지 한다.
- 먼저 깊게 생각한다. 설계, 엣지 케이스, 실패 경로, 돈과 손님에게 미치는 영향을 정리한 뒤 구현한다. 각 설계 결정은 한 번 스스로 반박해 보고 살아남은 것만 쓴다.

## 1. 시작
1. `git status`가 깨끗한지 본다. 커밋 안 된 변경이 있으면 `prompts/RESUME.md` 절차를 먼저 따른다.
2. 읽는다: `PROGRESS.md`, `HUMAN_TODO.md`, `prompts/STAGES.md`, 이 차수 문서, 의존 차수의 `docs/stages/SNN/REPORT.md`, 관련 ADR, `docs/BUSINESS_CONTEXT.md`의 관련 절. 큰 파일은 필요한 부분만(검색, 부분 읽기).
3. 의존 차수가 `DONE` 또는 `DONE_NEEDS_HUMAN`이 아니면, 이 차수의 핵심이 그 의존 없이 불가능한지 판단한다. 불가능하면 PROGRESS에 `BLOCKED(의존: SNN)`로 적고 끝낸다.
4. PROGRESS.md에서 이 차수를 `IN_PROGRESS`로, 시작 시각과 시작 커밋 해시를 적는다. 시작 지점에 태그 `stage-SNN-start`를 단다(이미 있으면 그대로 둔다).
5. 보드에 알린다: `node scripts/status.mjs start SNN --model <opus|sonnet>` (10절)

## 2. 계획
- `docs/stages/SNN/PLAN.md`를 쓴다: 목표 요약, 핵심 설계 결정(검토한 대안과 선택 이유), 위험, 체크포인트 목록(3~10개, 각각 끝나면 커밋할 수 있는 단위), 체크포인트별 검증 방법.
- PLAN.md를 쓴 직후: `node scripts/status.mjs plan SNN <체크포인트 수>`
- 되돌리기 어려운 결정은 ADR(`docs/adr/NNNN-제목.md`: 맥락 / 결정 / 검토한 대안 / 결과와 트레이드오프 / 재검토 조건)로 남긴다. 번호는 기존 최댓값 + 1.

## 3. 구현 루프 (체크포인트마다)
1. 구현 → 테스트 작성·실행 → 관련 검증 통과.
2. 커밋: `SNN: <checkpoint summary>`(영어). 작게 자주 커밋한다. 한도에 걸려 끊겨도 잃는 것이 적도록.
3. PROGRESS.md의 `현재 체크포인트`를 갱신한다(같은 커밋에 포함해도 된다).
4. 보드에 알린다: `node scripts/status.mjs cp SNN <끝낸 번호> "<영어 한 줄>"`. 체크포인트 하나가 30분 넘게 걸리면 중간에 `note`로 지금 하는 일을 한 줄 남긴다.

테스트 원칙:
- 테스트는 실제 동작을 검증한다. 같은 값을 돌려받아 비교하는 식의 의미 없는 테스트, 검증 대상까지 모킹하는 테스트 금지.
- 버그를 고칠 때는 먼저 실패하는 테스트를 만든다.
- 시간·난수에 의존하는 로직은 가상 시계와 시드 고정 난수로 결정적으로 테스트한다.
- 외부 네트워크가 필요한데 막히면(모델·바이너리 다운로드, 외부 API) 반복 재시도하지 않는다. 가짜 구현으로 테스트하고 NEEDS-HUMAN으로 기록한다.

## 4. 막혔을 때
- 같은 문제에 서로 다른 해결을 3번 시도해도 실패하면 그 경로를 멈춘다.
- `docs/stages/SNN/REPORT.md`의 `막힌 것`에 증상, 시도한 것, 추정 원인, 사람이 확인할 것을 적는다.
- 나머지 체크포인트는 계속한다. 게이트를 통과할 수 없으면 차수 상태는 `BLOCKED`.
- 막힌 테스트를 skip하거나 지우지 않는다. 환경 문제라면 `NEEDS-HUMAN` 표시와 함께 실행 조건(예: Windows 실기, GPU 필요)을 명시하는 방식으로만 조건부 실행을 허용한다.

## 5. 게이트 (DONE의 조건)
0. 시작할 때 `node scripts/status.mjs phase SNN gate`, 적대적 검토를 시작할 때 `phase SNN review`.
1. `pnpm verify` 전체 통과. Go가 없는 환경이면 TS 부분 통과 + Go 관련은 NEEDS-HUMAN 기록.
2. 차수 문서의 `수용 기준` 전부 통과. 기준마다 실행한 명령과 결과를 REPORT에 기록한다.
3. **적대적 검토**: `adversarial-reviewer` 서브에이전트에게 차수 ID를 주고 검토를 맡긴다. `높음`·`중간` 지적은 고치거나, 고치지 않는 이유를 REPORT에 적는다. 서브에이전트를 쓸 수 없으면 `.claude/agents/adversarial-reviewer.md`의 체크리스트로 스스로 검토한다.
4. 문서 갱신: 바뀐 설계를 `docs/ARCHITECTURE.md`, ADR, README에 반영한다. `node scripts/check-docs.mjs`가 있으면 통과해야 한다.

## 6. 마무리
1. `node scripts/status.mjs phase SNN report` → `docs/stages/SNN/REPORT.md`를 `prompts/_REPORT_TEMPLATE.md` 형식으로 쓴다.
2. 사람이 해야 할 일은 `HUMAN_TODO.md`에 추가한다(차수 ID, 왜 필요한지, 정확한 절차, 결과를 어디에 기록하는지).
3. PROGRESS.md: 상태(`DONE` / `DONE_NEEDS_HUMAN` / `BLOCKED`), 종료 시각, 한 줄 요약, 새 가정을 기록한다.
4. 커밋 `SNN: complete stage` → DONE 계열이면 태그 `stage-SNN-done`.
5. 보드에 알린다: `node scripts/status.mjs finish SNN <DONE|DONE_NEEDS_HUMAN|BLOCKED> "<한국어 한 줄 요약>"` — PROGRESS.md의 상태와 같아야 한다.
6. 원격(origin)이 있으면 현재 브랜치를 push한다(force 금지). 실패해도 차수 실패로 치지 않고 REPORT에 적는다.

## 7. 선택 확장
- 게이트를 통과한 뒤에만 한다. 항목마다 별도 커밋, 테스트 포함.
- 확장 중에는 `node scripts/status.mjs note SNN "확장: <항목>"`만 쓴다(상태는 이미 끝남).
- 확장이 게이트를 깨뜨리면 그 커밋을 `git revert`한다.
- 확장 결과도 REPORT에 적는다.

## 8. 맥락 관리
- 긴 출력(전체 테스트 로그, 거대한 파일)을 통째로 읽지 않는다. 실패한 부분만 본다.
- 세션이 길어지면 지금까지의 결정과 다음 할 일을 PLAN.md와 PROGRESS.md에 먼저 적는다. 맥락이 요약되어 잊혀도 이어갈 수 있게.

## 9. 안전 규칙 요약
- 금지: force push, 히스토리 재작성, `git reset --hard`, 저장소 밖 파일 삭제, 비밀값 커밋, 실결제, 출금 기능, 기본값으로 외부 유료 API 호출, 테스트 삭제·skip으로 통과.
- 비밀값은 `.env`(gitignore)로만. `.env.example`에는 키 이름과 설명만.
- 새 의존성은 이유를 PLAN에 적는다. 유지보수가 활발하고 라이선스가 허용적인(MIT, Apache-2.0, BSD 등) 것만.
- 외부 서비스 가격·API 사양처럼 시간이 지나면 바뀌는 정보는 웹 검색이 가능하면 확인하고 날짜와 함께 기록한다. 불가능하면 '확인 필요'로 표시한다.

## 10. 상태 보고 (진행 보드)
사람은 `scripts/board.mjs`(터미널·웹 보드)로 진행 상황을 본다. 보드는 `PROGRESS.md`와 `node scripts/status.mjs`가 남기는 기록(`.runner/board/`, `.runner/events.jsonl`, gitignore 대상)을 읽는다.
- 위 1~7절에 적힌 시점마다 `status.mjs`를 호출한다: `start` → `plan` → `cp`(체크포인트마다) → `phase gate` → `phase review` → `phase report` → `finish`. 도움말: `node scripts/status.mjs help`.
- 이 기록은 보조 수단이다. 진짜 기록은 PROGRESS.md와 커밋이다. 호출이 실패하면 한 번 다시 시도하고, 그래도 실패하면 REPORT에 적고 작업은 계속한다. 상태 보고 때문에 차수를 멈추거나 BLOCKED로 만들지 않는다.
- 메시지는 한 줄로 짧게. 체크포인트 설명은 영어, `finish` 요약과 사람에게 알려야 할 내용은 한국어. 비밀값·프롬프트 내용·개인정보는 적지 않는다(화면에 그대로 보인다).
- `scripts/board.mjs`와 `scripts/status.mjs`는 키트 도구다. 지우거나 의존성을 추가하지 않는다(Node 기본 모듈만 사용). 고쳐야 하면 동작을 유지하는 최소 수정만 한다.

