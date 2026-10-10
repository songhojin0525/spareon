# S04 보고서 — 걷는 뼈대 = 0단계 장난감

- 상태: DONE_NEEDS_HUMAN
- 커밋 범위: `stage-S04-start..stage-S04-done`
- 시작 / 종료: 2026-10-10 01:37 / 2026-10-10 (완료 커밋 시각)

## 한 일 (5줄 이내, 사람이 30초 안에 읽을 수 있게)
1. 구매자 `POST /v1/chat/completions` → 서버(배정·리스·재시도) → 에이전트(PC) → 응답 → 원장(홀드 → 캡처 70/30 또는 해제, 통화별 합 0)까지 S02 프로토콜·S03 스키마 그대로 이었다.
2. Go 에이전트 `spareon-agent run`(fake·Ollama 런타임, `--always-available`만)과 같은 프로토콜의 TS `FakeAgent`를 만들었다. Ctrl+C·멈춤·킬·서버 침묵·연결 끊김 때 즉시 멈추고 GPU 메모리를 비우며, 비우는 동안은 일을 받지 않는다.
3. `pnpm demo`(임시 Postgres + 에이전트 2대 + 요청 10개 → "10/10 완료, 원장 합 0"), `pnpm dev:server`(친구 PC 데모, LAN은 `--lan`일 때만), `/dev` 대시보드(메타데이터만), `docs/DEMO_0.md`.
4. 시간 규칙(오퍼 2초·리스 15초·용량 대기 30초·마감 10분·보존 24시간·유휴 10초)과 경합(늦은 완료, 완료 2회, 완료 vs 리스 만료, 재시작, 두 번째 서버, 케이블 뽑힘, 잠금 끊김)을 통합 테스트로 고정했다. 이중 과금 0.
5. 적대적 검토 3회(1차 중간 8·낮음 9, 2차 높음 1·중간 2·낮음 10, 3차 중간 3·낮음 11)를 반영했다. 단순화 45곳은 `SKELETON(SNN)`으로 표시했다(아래 교체 목록).

## 실행하는 법 (복사해서 바로 쓰는 명령)
```
pnpm verify                      # 전체 게이트
pnpm demo                        # 자동 데모: 10/10 완료, 원장 합 0
pnpm dev:server                  # 개발 서버(127.0.0.1:8080, /dev 대시보드)
pnpm dev:server --lan            # 같은 와이파이의 친구 PC가 붙는 데모(docs/DEMO_0.md)
node scripts/check-skeleton.mjs --expect docs/stages/S04/REPORT.md
cd apps/agent && go run ./cmd/spareon-agent run --server ws://127.0.0.1:8080/agent/v1/ws --name my-pc --runtime fake --always-available
```

## 수용 기준 결과
| # | 기준 | 실행한 명령 | 결과 |
|---|---|---|---|
| 1 | `pnpm verify` 통과 | `pnpm verify` (2026-10-10, 커밋 1c45a0b, 차수 담당과 지휘자가 각각 실행) | PASS 9/9: format·docs·lint·typecheck·test(server 145, protocol 539, repo-checks 172, testkit 39, shared 17, web 2)·gofmt·vet·go test·Windows 교차 빌드 |
| 2 | `pnpm demo`가 사람 개입 없이 끝까지 돌고 "10/10 완료, 원장 합 0" | `pnpm demo` | 통과. Go 에이전트(fake 런타임) 2대가 5건씩 처리, 구매자 지갑 10 → 9.9 CR, 매장 미성숙 0.07·플랫폼 0.03 CR, 원장 합 CR 0·KRW 0, 캡처 10 = 완료 10, 남은 홀드 0, 마지막 줄 `10/10 완료, 원장 합 0` |
| 3 | E2E(끊김 포함) 통과, 이중 과금 0건 | `apps/server/test/skeleton/e2e.int.test.ts`(노드 2, 요청 20, 도중 1대 끊김), `pnpm verify`에 포함 | 통과. 모든 요청이 완료(캡처 1) 또는 명확한 실패(해제 1), 이중 과금 0, 원장 합 0, 활성 시도·홀드 0 |
| 4 | 모든 단순화가 `SKELETON(SNN)`이고 REPORT 교체 목록과 일치 | `node scripts/check-skeleton.mjs --expect docs/stages/S04/REPORT.md` | 표시 45개, 형식 오류 0, 아래 교체 목록과 (파일, 차수) 쌍이 같다 |
| 5 | `docs/DEMO_0.md` 완성, HUMAN_TODO에 친구 PC 데모 항목과 절차 링크 | 문서 확인, `node scripts/check-docs.mjs` | 완료. HUMAN_TODO "S04에서 추가" 절에 절차(DEMO_0 3~8절)와 결과 기록 위치 |

추가로 확인한 것:
- `go test ./internal/devagent/ -run TestCtrlCReportsPreemptedAndExits -count=500` 통과(수정 전에는 약 1/3 실패).
- `go test ./internal/devagent/ -count=15` 통과.
- 새 서버 테스트는 해당 수정을 빼면 실패한다:
  - 유휴 종료: 옛 close 동작이면 세션 제거를 기다리다 시간 초과.
  - 두 번째 서버: 잠금이 없으면 그대로 시작됨.
  - 안전 타이머 2건: 요청이 끝나지 않음.
  - 포트 사용 중: listen 실패 뒤 정리를 빼면 30초 안에 끝나지 않음.
- `TestPauseAnswersWhileTheRuntimeReleases`가 실패하던 원인은 테스트 쪽이었다. Fake의 `Releases()`는 해제를 *시작*할 때 올라가서, 테스트가 1.5초짜리 해제가 끝나기 전에 offer를 보냈고 에이전트는 이를 busy로 올바르게 거절했다. 기준은 낮추지 않았다. 해제 *완료*를 세는 `ReleasesDone`을 추가했고, 에이전트는 해제를 마치면 스스로 eligible status를 보낸다.

## 적대적 검토 결과
### 1차 (e6217ee..5bcd99e, 높음 0·중간 8·낮음 9) — 반영 커밋 37dbf71
1차 원문은 보관되지 않았다. 중간 8건과 조치는 2차 검토의 판정으로 확인했다. 낮음 9건은 원문이 남아 있지 않고, 반영 내역은 37dbf71 커밋 메시지에 있다.
| 심각도 | 지적 | 조치 |
|---|---|---|
| 중간 | 1. 재시작하면 이전 프로세스의 미완료 작업이 남는다 | 고침: `recoverAfterRestart`가 시작 때 과금 없이 취소(`server_restart`). 2·3차에서 보강 |
| 중간 | 2. 프로토콜이 실을 수 없는 구매자 텍스트(짝 없는 서로게이트, 이스케이프 뒤 크기 초과) | 고침: 400 `invalid_text`, 413 `input_too_large` |
| 중간 | 3. 서버가 끊은 유휴 세션이 close 핸드셰이크(30초) 동안 남는다 | 고침: 서버가 끊으면 세션을 즉시 정리하고 1초 뒤 TCP를 강제 종료 |
| 중간 | 4. Ctrl+C가 생성 중 작업을 바로 멈추지 않는다 | 고침. 2차에서 새 경합이 발견되어 92df1bf에서 다시 고침 |
| 중간 | 5. 멈출 때 GPU 메모리를 비우지 않는다(Ollama가 5분 보관) | 고침: `Runtime.Release`(Ollama `keep_alive:0`) — Ctrl+C·pause·kill·fail-safe·서버 침묵·연결 끊김 |
| 중간 | 6. 서버 DB 역할을 우회할 수 있다(DB_ROLE·URL options) | 고침: DB_ROLE 리터럴, URL `options` 거부, 시작 때 `current_user` 확인 |
| 중간 | 7. `HOST` 환경변수만으로 LAN에 열린다 | 고침: 개발 서버는 `--lan`일 때만 0.0.0.0 |
| 중간 | 8. 시간 규칙·경합 테스트가 부족하다 | 고침: 늦은 완료·마감·보존 삭제·완료 vs 리스 경합 테스트 |

### 2차 (37dbf71, 높음 1·중간 2·낮음 10, 원문 `docs/stages/S04/REVIEW_ROUND2.md`) — 반영 커밋 eb676e9, 92df1bf, abb777f
| 심각도 | 지적 | 조치 |
|---|---|---|
| 높음 | Ctrl+C로 취소된 생성 결과를 메인 루프가 먼저 집으면 `job.fail(runtime_crash)`로 보고한다(테스트 약 1/3 실패) | 고침(92df1bf): 루프를 `serve()`로 분리하고 매 반복 Ctrl+C를 먼저 확인하며, Ctrl+C 뒤 결과·수신은 무시한다. `job.fail`이 오면 실패하도록 테스트를 강화했고 `-count=500` 통과 |
| 중간 | 유휴 종료 테스트가 close 프레임에 응답하는 클라이언트를 써서 수정을 증명하지 못한다 | 고침(abb777f): 바이트를 버리는 TCP 중계(`test/support/cable.ts`)로 케이블 뽑힘을 만든다. 유휴 한도에 세션이 제거되고 약 1초 뒤 서버가 TCP를 끊는지 단언한다. 옛 동작으로 실패하는 것을 확인 |
| 중간 | 단일 인스턴스 장치가 없어 두 번째 서버가 첫 서버의 진행 중 작업을 취소하고, 구매자 요청이 무기한 대기한다 | 고침(abb777f): 시작 때 세션 advisory lock을 잡고 못 잡으면 시작을 거부한다. 구매자 대기마다 마감+30초 안전 타이머를 둔다(열린 작업은 만료 처리, 이미 끝났으면 DB 상태로 응답). 배정은 이 프로세스에서 기다리는 작업만 |
| 낮음 | 재시작 복구가 항목별로 격리되지 않아 한 건이 시작을 막는다 | 고침: 항목별 격리, 실패 건수를 로그에 남김. 남은 작업은 배정되지 않고 마감 청소가 끝낸다(시작은 거부하지 않음) |
| 낮음 | 재시작 테스트가 `recoverAfterRestart()`를 직접 호출한다 | 고침: 서버 A 종료 → 같은 DB로 `buildServer`→`listen` → 고아 작업 취소·해제, 새 노드에 offer 0 |
| 낮음 | offer 직전 모델이 빠지면 빈 sha로 `input_invalid` 영구 실패 | 고침: 직전에 모델 보유를 다시 확인하고, 없으면 시도를 `timed_out(model_missing)`으로 끝내 재큐. 'invalid'는 입력만 따로 검사해 `input_unsendable`(입력 탓)과 `offer_invalid`(서버 결함)로 나눈다 |
| 낮음 | `input_invalid`가 502 `node_failed`로 나간다 | 고침: 서버가 판정한 `input_unsendable`은 400, `offer_invalid`는 500. 노드가 보고한 `input_invalid`는 그 노드의 주장일 뿐이라 계속 502 |
| 낮음 | 이스케이프 크기 초과에도 "256 KiB 초과"로 안내한다 | 고침: 사유별 문구 |
| 낮음 | pause·kill·fail-safe에서 해제를 동기로 실행해 최대 5초 침묵한다 | 고침(92df1bf): 해제는 백그라운드, ack·status·heartbeat는 즉시. 해제가 끝나기 전 offer는 busy로 거절 |
| 낮음 | 연결 끊김·읽기 오류 때 GPU를 해제하지 않는다 | 고침(92df1bf): 세션이 오류로 끝나면 작업 중지 + 해제 |
| 낮음 | Ollama 언로드가 로드 안 된 모델을 로드할 수 있다(구버전) | 고침(eb676e9): `/api/ps`에 있는 모델만 언로드. 3차에서 `/api/ps`가 없는 옛 버전 안내도 추가 |
| 낮음 | DEMO_0 "다른 PC가 마저 처리" | 고침: "처음부터 다시 처리" |
| 낮음 | PLAN의 `HOST=0.0.0.0` 문구 | 아래 'PLAN과의 차이'에 기록 |

### 3차 (92df1bf, abb777f, 높음 0·중간 3·낮음 11) — 반영 커밋 1c45a0b
| 심각도 | 지적 | 조치 |
|---|---|---|
| 중간 | `listen()`은 onReady(잠금·복구·청소)를 먼저 실행한다. 그래서 포트가 사용 중이면 잠금 연결을 쥔 채 실패하고, `pool.end()`가 영원히 기다려 `pnpm dev:server`가 멈춘다(abb777f가 만든 회귀) | 고침: dev-stack이 listen 실패 때 `server.app.close()`를 먼저 부른다. onReady에서 복구·시작이 실패하면 잠금을 푼다. 포트를 점유한 채 시작하면 20초 안에 EADDRINUSE로 끝나고, 같은 DB로 다시 시작되는지 확인하는 테스트 추가 |
| 중간 | 잠금 연결이 끊겨도 로그만 남기고 잠금 없이 계속 배정한다 | 고침: 끊기면(`error`·`end`) 스케줄러 `halt()`(배정·청소 중지, 안전 타이머는 유지) + 치명 로그. 풀 연결에 TCP keepalive. 세션 모드 연결이 필요하다는 점을 ARCHITECTURE 8절에 기록. `pg_terminate_backend`로 잠금 세션을 죽이는 테스트 추가 |
| 중간 | 안전 타이머의 `outcome_lost`(사실상 완료·과금된 작업)를 500 "Nothing was charged"로 안내한다 | 고침: DB 상태가 completed면 `result_undelivered`("완료·과금됐으나 결과를 잃음, 운영자에게 문의"), 알 수 없으면 `outcome_unknown`으로 나누고, 과금 안 됨이라고 말하지 않는다. 이 경로를 재현하는 테스트는 없다(완료가 대기자에게 전달되지 않는 상황을 만들기 어려움) |
| 낮음 | 해제 중 resume을 받으면 eligible:true를 보내고, 해제가 끝나도 status를 다시 보내지 않는다 | 고침: 해제 중에는 eligible:false. 해제가 끝나면 메인 루프가 status를 보낸다(테스트 반영) |
| 낮음 | `releasing`이 세션별이라 재연결 직후 해제 중에도 새 작업을 받을 수 있다 | 고침: 해제 개수를 Agent 수준에서 센다(동기·백그라운드 모두). 새 세션도 해제가 끝날 때까지 busy |
| 낮음 | `stop()`이 안전 타이머를 정리하지 않는다 | 고침: `stop()` = `halt()` + 타이머 정리 |
| 낮음 | 연결 끊김 테스트가 생성 취소를 확인하지 않는다 | 고침: Fake에 취소 카운터를 두고 1회를 단언 |
| 낮음 | 재시작으로 취소된 작업이 502 `node_failed`로 나간다 | 고침: 503 `server_restarted`(테스트 반영) |
| 낮음 | `/api/ps`가 없는 옛 Ollama에서 언로드를 전혀 못 하는데 DEMO_0에 안내가 없다 | 고침: 404면 "Ollama를 업데이트하라"는 오류, DEMO_0 준비물에 "`ollama ps`가 되는 버전" |
| 낮음 | Ctrl+C 때 막힌 쓰기가 있으면 해제가 최대 약 5초 늦다(이전부터 있던 문제) | 고침: `context.AfterFunc(ctx, releaseAsync)`로 Ctrl+C 즉시 해제를 시작하고, shutdown은 기존대로 자기 해제를 기다림 |
| 낮음 | `inArray(waiters)`가 waiter마다 바인드 파라미터를 만든다(65,535개 초과 시 실패) | 안 고침: 단계 A 규모(대기 구매자 수천 이하)에서 현실적이지 않다. 배정 큐 전체가 S12(SKIP LOCKED·지속 결과)에서 바뀐다 |
| 낮음 | 새 경로 4개(model_missing 재큐, input_unsendable 400, offer_invalid 500, result_undelivered)를 실행하는 테스트가 없다 | 안 고침: 정상 입력으로는 도달할 수 없는 방어 경로라, 재현하려면 스케줄러 내부에 주입 지점을 만들어야 한다. S12에서 배정을 바꿀 때 테스트할 수 있게 다시 본다 |
| 낮음 | 복구에 실패해 열린 채 남은 작업을 마감 청소가 250ms마다 다시 시도해 오류 로그가 계속 쌓인다 | 안 고침: 같은 장부 이상이 반복될 때만 생기고, 돈 불변식은 지켜진다. 실패 상한·운영 경보는 S06(원장 대사)·S29(운영 경보)로 넘김 |
| 낮음 | PLAN:38 `HOST` 문구 | 아래 'PLAN과의 차이'에 기록 |

3차 반영분(1c45a0b)은 4차 검토를 받지 않았다. 고친 곳마다 테스트를 붙이거나 기존 테스트를 바꿔 확인했다.

## PLAN과의 차이
- D-f: PLAN은 "LAN은 `HOST=0.0.0.0`(개발 서버 `--lan` 플래그)로만"이라고 했다. 1차 검토 뒤 개발 서버는 `HOST`를 무시하고 `--lan`일 때만 0.0.0.0에 바인딩한다(환경변수 하나로 실수로 열리지 않게). 현재 동작은 ARCHITECTURE 10절에 있다.
- D-c/D-d에 추가: 단일 스케줄링 프로세스(advisory lock, 잃으면 스케줄링 중지), 구매자 대기 안전 타이머(마감+30초), '기다리는 작업만 배정', 재시작 때 미완료 작업 취소. PLAN에 없던 것으로 검토에서 생겼다(ARCHITECTURE 8절 끝 문단).
- D-g에 추가: Ctrl+C·pause·kill·fail-safe·서버 침묵·연결 끊김 때 `Runtime.Release`로 GPU 메모리를 해제한다(Ollama `keep_alive:0`, `/api/ps`에 있는 모델만). 해제 중에는 eligible=false이고 offer를 busy로 거절한다.
- 서버 조립(`ServerDeps`)에 DB 풀(`pool`)이 추가됐다(잠금 연결용).
- 진행 중 끼어든 일: 프로젝트 이름 변경(binjari → spareon, ADR 0020)과 브랜드 자산(`docs/brand/`)이 이 차수 도중 사람의 결정으로 들어왔다. 차수 범위 밖이라 별도 커밋으로 남겼다.

## 교체 목록 (SKELETON)
| 파일 | 대체 차수 | 단순화한 것 |
|---|---|---|
| `apps/server/src/app.ts` | S05 | 라우트 권한이 있는 조립 루트 |
| `apps/server/src/buyer-api/chat-completions.ts` | S05 | 개발용 API 키 하나가 개발용 구매자 한 명을 인증 |
| `apps/server/src/config.ts` | S05 | 개발용 API 키가 구매자 계정·API 키를 대신함 |
| `apps/server/src/skeleton/bootstrap.ts` | S05 | 개발용 구매자 한 명(실제 계정·키로 교체) |
| `apps/server/src/ledger/skeleton.ts` | S06 | 원장 서비스(거래 종류별 허용 계정, 잠금 순서 등) |
| `apps/server/src/scheduler/scheduler.ts` | S06 | 홀드 만료는 기록만, 강제하지 않음(작업 종료·마감 청소가 해제) |
| `packages/shared/src/index.ts` | S06 | bigint 돈 유틸(최소 단위 파싱·형식) |
| `apps/server/src/ledger/skeleton.ts` | S08 | 요청당 고정 단가 0.01 CR, 매장 몫 70%, 비용 = 홀드한 고정 단가 |
| `apps/agent/internal/devauth/devauth.go` | S09 | 모델 sha256 자리표시(모델 레지스트리 매니페스트로 교체) |
| `apps/server/src/skeleton/bootstrap.ts` | S09 | 에이전트가 알린 모델이 처음 보일 때 바로 구매자용 모델이 됨 |
| `packages/protocol/src/dev-identity.ts` | S09 | 서명된 모델 매니페스트 전까지 쓰는 모델 다이제스트 자리표시 |
| `apps/agent/internal/devauth/devauth.go` | S10 | 등록(enroll, 저장된 기기 키, 하드웨어 지문) 대신 유도 신원 |
| `apps/server/src/fleet/nodes.ts` | S10 | 첫 인증 연결 때 개발용 매장에 노드 자동 등록 |
| `apps/server/src/skeleton/bootstrap.ts` | S10 | 개발용 매장 하나(매장 등록·노드 등록으로 교체) |
| `packages/protocol/src/dev-identity.ts` | S10 | 등록 대신 공유 비밀에서 유도한 개발용 신원 |
| `apps/server/src/config.ts` | S11 | 에이전트 인증이 공유 비밀 유도 키 |
| `apps/server/src/gateway/gateway.ts` | S11 | 기기 키를 DEV_AGENT_SECRET에서 유도(등록 조회 없음), 연결당 개수 제한(분당 제한 아님), 제어 상태(pause·킬) 미저장 |
| `apps/server/src/gateway/session.ts` | S11 | 서버 인스턴스 하나, 인스턴스 간 전달·재개 없음 |
| `apps/server/src/scheduler/scheduler.ts` | S11 | 재개 창 없음(연결이 닫히면 시도를 즉시 잃음) |
| `apps/server/src/buyer-api/chat-completions.ts` | S12 | 큰 입력의 inputRef 미지원 |
| `apps/server/src/gateway/gateway.ts` | S12 | 스트리밍 출력 중계 없음(chunk는 리스만 갱신) |
| `apps/server/src/lib/payload-cipher.ts` | S12 | 환경변수 키 하나(키 회전·보존 모듈 없음) |
| `apps/server/src/scheduler/scheduler.ts` | S12 | 프로세스 내 배정, 대기 구매자는 프로세스 메모리, '모델을 가진 첫 대기 노드', 선점 뒤 이어서 처리 없음, outputRef 조립 없음 |
| `apps/server/src/buyer-api/chat-completions.ts` | S14 | 스트리밍(SSE)·멱등 키·키별 한도 없음, 사용량은 노드 보고값 |
| `apps/agent/cmd/spareon-agent/main.go` | S17 | `run`은 S04 콘솔 모드(에이전트 코어로 교체) |
| `apps/agent/internal/devagent/agent.go` | S17 | 에이전트 코어(상태 기계·정책·자격 리스·데드맨·재개), RAM·캐시 디스크 미측정, 매장 정책 미적용, inputRef·completion 미지원 |
| `apps/agent/internal/devagent/agent.go` | S18 | 손님 감지 없음(`--always-available`만) |
| `apps/agent/internal/devagent/agent.go` | S19 | GPU 목록 미수집(ADR 0019), 생성 중 토큰 수 미보고 |
| `apps/agent/internal/runtime/ollama.go` | S19 | Ollama 버전 미조회·미고정 |
| `apps/agent/internal/runtime/runtime.go` | S19 | 서명·버전 고정 llama.cpp llama-server 런타임(ADR 0004, AMD는 Vulkan) |
| `apps/agent/internal/devagent/agent.go` | S20 | 모델 다운로드 없음 |
| `apps/agent/internal/devagent/agent.go` | S21 | 자체 업데이트 없음 |
| `apps/web/src/index.ts` | S23 | Next.js App Router 앱(/owner, /app, /ops)으로 교체 |

## 가정 (사람이 나중에 확인할 것)
| 가정 | 근거 | 틀리면 바꿀 곳 |
|---|---|---|
| 과금은 홀드 → 캡처/해제(지갑 → 홀드 → 매장 70%·플랫폼 30%), `holds.buyer_account_id`는 구매자 홀드 계정 | 완료 시점 잔액 부족으로 '일은 했는데 과금 실패'가 생기는 것을 막고, ARCHITECTURE 9장 설계와 같다 | S06 원장 서비스 |
| 개발용 노드 키 = HMAC-SHA256(DEV_AGENT_SECRET, nodeId)에서 유도한 ed25519 | 프로토콜 인증 흐름을 그대로 쓰면서 등록(S10) 없이 데모 | S10·S11 |
| 재시작 때 이전 프로세스의 미완료 작업은 재배정하지 않고 과금 없이 취소 | 기다리는 구매자가 프로세스 메모리에만 있어 답을 받을 사람이 없다 | S12(지속 결과) |
| DB 하나에 스케줄링 서버 하나(advisory lock, 세션 모드 연결 필요). 잠금을 잃으면 배정·청소를 멈추고 운영자가 재시작 | 단계 A는 단일 프로세스(ADR 0002). 두 번째 프로세스가 첫 프로세스의 작업을 취소하는 사고를 막고, 불확실하면 멈춘다 | S11·S12(다중 인스턴스·리더 선출), S30(풀러 선택) |
| 구매자 요청은 작업 마감 + 30초 안에 반드시 답을 받는다 | 마감 청소가 정상 경로이고, 안전 타이머는 보이지 않는 곳에서 끝난 작업의 백업 | S12·S14 |
| 에이전트는 멈출 때마다 Ollama 모델을 `keep_alive:0`으로 언로드하고, 언로드가 끝날 때까지 일을 받지 않는다 | Ollama 기본 5분 보관은 손님 VRAM을 잡는다(절대 규칙 1) | S19(llama-server 런타임) |

## 사람이 확인할 것 (HUMAN_TODO에도 추가함)
- (선택) 친구 PC 2~3대 또는 내 PC(AMD RX 5700 XT) 한 대로 0단계 데모를 해 본다 — `docs/DEMO_0.md`, HUMAN_TODO "S04에서 추가". 실제 Ollama·실제 네트워크·AMD GPU에서의 동작(`ollama ps`의 GPU/CPU)은 아직 사람이 확인하지 않았다. 그래서 상태가 DONE_NEEDS_HUMAN이다.

## 막힌 것
| 증상 | 시도한 것 | 추정 원인 | 사람이 확인할 것 |
|---|---|---|---|
| 없음 | | | |

참고: `go test -race`는 이 PC에 gcc가 없어(CGO 0) 돌리지 못했다. 동시성은 코드 검토와 반복 실행(-count=500)으로 확인했다.

## 다음 차수에 미치는 영향
- S05: 개발용 API 키·구매자 한 명(`SKELETON(S05)`)을 실제 계정·키·권한으로 바꾼다. 조립 루트는 `buildServer`다(`ServerDeps`에 `pool` 있음).
- S06·S08: `ledger/skeleton.ts`(고정 단가 0.01 CR, 70/30)를 원장 서비스·가격표로 교체한다. 홀드 만료는 지금 기록만 한다. 복구 실패 작업의 반복 재시도에 상한·경보가 필요하다.
- S11·S12: 단일 프로세스 가정(advisory lock 키 `0x62696e6a, 2`, 프로세스 메모리의 대기 구매자, 재시작 때 취소, '기다리는 작업만 배정', 재개 창 없음)을 다중 인스턴스·지속 결과로 바꿀 때, 이 잠금을 리더 선출로 바꾸고 배정 질의를 배열 파라미터나 큐로 바꾼다.
- S17~S19: Go `devagent`는 콘솔 모드 뼈대다. llama-server 런타임도 `Runtime.Release` 계약(언제든·여러 번·동시에 호출 가능)과 '해제 중 eligible=false'를 지켜야 한다.

## 수치
- TS 테스트: server 145(통합 포함), protocol 539, repo-checks 172, testkit 39, shared 17, web 2. Go: 6개 패키지 통과.
- Ctrl+C 테스트 500회 연속 통과(수정 전 300회 중 100회 실패). devagent 전체 -count=15 통과.
- `pnpm demo`: 요청 10개 전부 완료(PC별 5건), 원장 합 CR 0·KRW 0.
- SKELETON 표시 45개(S05 4·S06 3·S08 3·S09 3·S10 4·S11 6·S12 8·S14 1·S17 5·S18 1·S19 4·S20 1·S21 1·S23 1).

## 선택 확장 결과
하지 않았다(`/dev` 질문 폼, 에이전트 콘솔 상태 줄). 게이트 통과까지의 여력은 검토 세 차례 반영에 썼다.
