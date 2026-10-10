# S04 2차 적대적 검토 결과 (원문 보관)

> 2026-10-10 지휘자가 보관. 검토 대상 커밋 37dbf71. 이름 변경(binjari → spareon) 때문에 S04 서브에이전트를 멈추면서, 이 결과를 받기 전에 끊겼다. S04를 이어서 하는 서브에이전트는 이 지적부터 처리한다.

S04 2차 적대적 검토 (커밋 37dbf71). 파일은 수정하지 않았습니다.

1차 지적 8건 가운데 다섯 건(1·2·6·7·8)은 의도대로 고쳐졌습니다. 그러나 4번 수정(Ctrl+C 시 AfterFunc로 작업 ctx를 바로 취소)이 새 경합을 만들었습니다. 이 때문에 `TestCtrlCReportsPreemptedAndExits`가 약 35% 확률로 실패하고, 실제 동작도 문서와 어긋납니다.

직접 돌린 명령과 결과:
- `go test ./internal/devagent/ -run TestCtrlCReportsPreemptedAndExits -count=300`: 100/300 실패 ("connection closed while waiting for job.preempted")
- `go test ./internal/... -count=20`: devagent 7/20 실패, runtime·protocol·devauth·version 통과
- `vitest run test/skeleton/time-limits.int.test.ts` 3회: 3회 모두 7/7 통과
- `node scripts/check-skeleton.mjs`: 표시 45개, 형식 오류 없음. `docs/stages/S04/REPORT.md`가 아직 없어서 `--expect` 대조는 못 했습니다.

| 심각도 | 위치(파일:줄) | 문제 | 왜 문제인가 | 제안 |
|---|---|---|---|---|
| 높음 | apps/agent/internal/devagent/agent.go:564-570, 394-401, 584-598 (재현 테스트: agent_test.go:276-298) | AfterFunc가 Ctrl+C 순간 jobCtx를 취소합니다. 그러면 Generate가 곧바로 `context.Canceled`로 끝나 `s.results`에 들어갑니다. 메인 루프의 select가 `ctx.Done()`보다 `s.results`를 먼저 고르면 `finish()`가 `job.fail{runtime_crash, retryable:true}`를 보내고 `s.job=nil`이 됩니다. 이어지는 `shutdown()`은 `job.preempted(shutdown)`을 보내지 않습니다. | (1) 위 재현 결과처럼 테스트가 약 1/3 확률로 실패합니다. `pnpm verify`가 통과한 것은 운이거나 go 테스트 캐시 덕입니다(`go test ./...`, `-count=1` 없음). 비결정적 테스트입니다. (2) 실제로도 손님 선점이 노드 `runtime_crash`로 기록되고, 에이전트 화면에 "작업 실패"가 뜹니다. DEMO_0.md:100의 "서버에 '중단'으로 알린다"와 다릅니다. 이후 신뢰도 집계에서 노드 탓으로 잡힐 수 있습니다. 같은 경합이 offer 처리 중 Ctrl+C가 오는 경우에도 있습니다. | `case r := <-s.results`에서 `ctx.Err() != nil`이면 결과를 버리고 `shutdown()`으로 가게 합니다. 또는 `finish()`에서 `errors.Is(r.err, context.Canceled)`이고 `s.outer.Err() != nil`이면 preempted(shutdown)으로 보고합니다. 고친 뒤 `-count=500`으로 다시 확인합니다. |
| 중간 | apps/server/test/skeleton/time-limits.int.test.ts:100-130, packages/testkit/src/fake-agent.ts:396 | 유휴 종료 테스트는 `goQuiet()`를 씁니다. 그런데 주석에도 적혀 있듯 이 가짜 에이전트의 WebSocket 스택은 close 프레임에 여전히 응답합니다. 그래서 수정 전 코드(`socket.close`만 하고 `'close'` 이벤트에서 정리)로도 2.5초 안에 세션이 지워져 통과합니다. | 3번 수정(서버측 종료 즉시 `endSession`, 1초 뒤 `terminate`)을 실제로 검증하지 못합니다. 무응답 상대(케이블 뽑힘) 경로는 테스트가 없습니다. | close 프레임에 응답하지 않는 클라이언트로 검증합니다. 예: raw `net` 소켓으로 업그레이드 뒤 읽기만 하는 클라이언트, 또는 `ws`의 `_socket.pause()`. 그 상태에서 세션이 즉시 제거되고 약 1초 뒤 TCP가 끊기는지 단언합니다. |
| 중간 | apps/server/src/scheduler/scheduler.ts:182-192, apps/server/src/app.ts:104-107 | `recoverAfterRestart`는 DB의 queued·offered·running 작업을 모두 취소합니다. 단일 인스턴스를 확인하는 장치(예: `pg_try_advisory_lock`)가 없습니다. 같은 `DATABASE_URL`로 두 번째 서버(실수로 띄운 dev:server, 롤링 배포)가 뜨면 첫 서버의 진행 중 작업이 취소됩니다. | 첫 서버의 `#waiters`는 resolve되지 않습니다. 작업이 이미 canceled라 sweep의 deadline 조회에도 안 잡히고, 늦은 완료도 'late'로 처리됩니다. 그래서 구매자 HTTP 요청이 무기한 걸립니다(Fastify 기본 `requestTimeout` 0). `#waiters`에도 메모리가 계속 쌓입니다. 노드는 계산을 끝까지 하지만 보상을 받지 못합니다. 돈의 불변식은 지켜지지만 장애 경로입니다. | 시작 시 advisory lock으로 단일 인스턴스를 강제하고, 잡지 못하면 시작을 거부합니다. 아울러 waiter에 deadline 기반 안전 타이머를 둡니다(작업 상태가 최종이면 DB에서 다시 읽어 resolve). |
| 낮음 | apps/server/src/scheduler/scheduler.ts:187 | `recoverAfterRestart`의 각 `#finalize`가 `#isolated`로 감싸여 있지 않습니다. `onReady`에서 예외가 나면 `listen`이 실패합니다. | 작업 한 건의 장부 이상(예: 홀드 상태 불일치)만으로 서버가 시작되지 못하고 재시작 루프에 빠집니다. 그 사이 다른 모든 홀드도 묶입니다. sweep은 같은 경우를 격리하는데 여기만 다릅니다. | 항목별로 `#isolated`를 적용하고 실패 건수를 로그로 남깁니다. 시작을 거부할지는 명시적으로 정합니다. |
| 낮음 | apps/server/test/skeleton/time-limits.int.test.ts:131-149 | 재시작 테스트가 같은 프로세스에서 `recoverAfterRestart()`를 직접 호출합니다. | 1번 수정의 핵심인 "`onReady`에서 dispatch 시작 전에 실행"은 검증되지 않습니다. 훅을 빼도 테스트가 통과합니다. | 서버 A를 닫고 같은 DB로 서버 B를 `buildServer`→`listen`한 뒤, 고아 작업이 canceled·release되고 B가 그 작업을 offer하지 않는지 확인합니다. |
| 낮음 | apps/server/src/scheduler/scheduler.ts:414-428 | `session.models.get(modelSlug) ?? ''`가 빈 sha를 만들면 스키마(`^[0-9a-f]{64}$`) 위반으로 `'invalid'`가 되고, 작업이 `failed(input_invalid)`로 영구 종료됩니다. dispatch와 offer 사이의 await 동안 capabilities가 갱신되어 모델이 빠진 경우입니다. 그 밖의 서버측 인코딩 결함도 모두 같은 분류로 들어갑니다. | 수정 전에는 2초 뒤 재큐되던 노드·서버측 상황이 구매자 입력 오류로 오분류되어 재시도 없이 실패합니다. | offer 직전에 모델 보유를 다시 확인하고, 없으면 시도를 `timed_out`으로 끝내 재큐합니다. `'invalid'`일 때 작업 실패로 처리하는 것은 입력 관련 인코딩 오류일 때로 좁힙니다. |
| 낮음 | apps/server/src/buyer-api/chat-completions.ts:106-112 | `input_invalid` 결과가 `502 node_failed "The request failed on the nodes (input_invalid)"`로 나갑니다. | 노드는 오퍼를 받은 적도 없는데 노드 실패로 안내합니다. 5xx라서 클라이언트가 자동 재시도하면 매번 결정적으로 실패하면서 작업과 홀드가 반복 생성됩니다. | `input_invalid`는 4xx(400 `invalid_request`)로 따로 매핑하거나, 최소한 `node_failed`가 아닌 코드로 보냅니다. |
| 낮음 | apps/server/src/buyer-api/chat-completions.ts:159-170 | 이스케이프 크기 초과일 때도 메시지가 "Messages exceed 262144 bytes."입니다. | 테스트처럼 원문 173 KB 입력도 413을 받는데, 안내는 256 KiB 한도를 말합니다. 구매자가 원인을 알 수 없습니다. | 사유별로 문구를 나눕니다(예: "after JSON escaping, the request exceeds ..."). |
| 낮음 | apps/agent/internal/devagent/agent.go:486-503, 446-456 | pause·kill·fail-safe pause에서 `s.release()`(최대 `ReleaseTimeout` 5초)를 메인 루프에서 동기 실행하고, 그 뒤에 ack·status를 보냅니다. | 그 사이 heartbeat·수신 처리·ack가 최대 5초 멈춥니다. 서버 idle 10초, heartbeat 5초 기준으로 마지막 송신 뒤 최대 약 10초까지 침묵할 수 있어, 서버가 idle로 끊을 경계에 걸립니다. S10 이후 서버가 pause ack에 시한을 두면 실패로 판정할 수 있습니다. | ack·status를 먼저 보내고 release는 고루틴으로 돌립니다(중복 호출 가드 포함). shutdown처럼 하면 됩니다. |
| 낮음 | apps/agent/internal/devagent/agent.go:422-429 | 연결 끊김·읽기 오류(`!ok`, `m.err`)에서는 `stopJob("")`만 하고 `release()`는 하지 않습니다. 서버 침묵에서는 release합니다. | 근거(T13: 서버 없이는 킬스위치를 못 받음)는 연결 끊김에도 똑같이 적용되는데 처리가 다릅니다. 서버 재시작 때 VRAM이 5분 동안 남습니다. | 같은 경로에서도 release하거나, 차이를 runtime.go 주석과 ADR에 근거와 함께 기록합니다. |
| 낮음 | apps/agent/internal/runtime/ollama.go:72-106 | `keep_alive:0` 언로드를 구성된 모든 모델에 보냅니다. 최근 Ollama는 로드되지 않은 모델이면 아무것도 하지 않지만, 구버전은 빈 prompt 요청에 모델을 먼저 로드한다고 알고 있습니다(이번에 버전별로 확인하지는 않았습니다). DEMO_0에는 Ollama 최소 버전이 없습니다. | 구버전에서는 손님이 온 순간(Ctrl+C) 오히려 VRAM을 잡을 수 있어 절대 규칙 1에 어긋납니다. | 먼저 `/api/ps`로 로드된 모델만 골라 언로드합니다. DEMO_0에 최소 Ollama 버전을 적습니다. |
| 낮음 | docs/DEMO_0.md:118 | "그 질문은 다른 PC가 마저 처리하고" | 실제로는 이어서 처리하지 않고 처음부터 다시 실행합니다(`SKELETON(S12)`, scheduler.ts:568). 절대 규칙 8의 문서·코드 일치에 어긋납니다. | "다른 PC가 처음부터 다시 처리하고"로 고칩니다. |
| 낮음 | docs/stages/S04/PLAN.md:38 | "LAN은 `HOST=0.0.0.0`(개발 서버 `--lan` 플래그)로만" | 이제 개발 서버는 `HOST`를 무시합니다. ARCHITECTURE 10절과 표현이 어긋납니다. | REPORT 작성 시 PLAN과의 차이로 기록합니다. |

1차 지적별 판정:
- 해결: 2번(API 400/413), 6번(DB_ROLE literal, URL `options` 거부, dev 시작 시 `current_user` 확인), 7번(`--lan`만 연다).
- 해결, 단 위 결함 있음: 1번 재시작 복구(다중 인스턴스, 격리 누락, 테스트 우회), 3번 유휴 종료(코드는 맞지만 테스트가 증명하지 못함), 4번 Ctrl+C(새 경합), 5번 Release(메인 루프 블록, 연결 끊김 누락, Ollama 버전).
- 해결: 8번(늦은 완료·마감·보존 삭제·경합 테스트).
- 지시하신 다른 점검 항목:
  - `endSession` 이중 호출: `ended` 플래그로 막혀 있습니다. 인증 도중 close는 `onProve`의 readyState 확인으로 막힙니다. 세션 교체 시 `remove`는 identity를 비교하므로 안전합니다.
  - AfterFunc 누수: 모든 종료 경로가 `stopJob`이나 `finish`를 거치므로 없습니다.
  - hangup 리스너: submit 전에 등록하는 순서는 올바릅니다.
  - ARCHITECTURE 10절 HOST·DB_ROLE 행: 코드와 일치합니다.

높음 1·중간 2·낮음 10

판정: 수정 필요
