# S04 계획 — 걷는 뼈대 = 0단계 장난감

## 목표 요약
구매자 요청 → 서버 → 에이전트(PC) → 응답 → 크레딧 이동을 처음부터 끝까지 가늘게 잇는다. S02 프로토콜(코덱·서명)과 S03 스키마(원장 트리거·`binjari_app` 역할)를 그대로 쓰고, 단순화한 곳은 모두 `SKELETON(SNN)`으로 표시한다. 원장 불변식(통화별 합 0)과 손님 우선(불확실하면 멈춤)은 뼈대에서도 지킨다.

## 핵심 설계 결정 (대안 → 선택 → 스스로 반박)

### D-a. 과금은 홀드 → 캡처/해제 (거래 1건짜리 '구매자 −' 대신)
- 요청 때 `JOB_HOLD`(구매자 지갑 → 구매자 홀드, `job:<id>:hold`)와 `holds` 행을 작업 생성과 같은 트랜잭션에서 만든다. 잔액이 모자라면 DB의 음수 금지 CHECK가 거부하고 402를 돌려준다(동시 요청도 DB가 직렬화).
- 완료: 시도 `running → completed`, 작업 `running → completed`, `JOB_CAPTURE`(홀드 → 매장 미성숙 70% + 플랫폼 매출 30%, `job:<id>:capture`), 홀드 `active → captured`, 수익(`earnings`) 1건을 **한 트랜잭션**에서. 어느 조건부 갱신이 0행이면 전체를 되돌린다.
- 실패·만료·취소: 작업 → 최종 상태 + `JOB_RELEASE`(홀드 → 지갑, `job:<id>:release`) + 홀드 `released`를 한 트랜잭션에서.
- 대안: 완료 때 '지갑 −, 매장 +, 플랫폼 +' 거래 1건(차수 문서 문구 그대로). 버림: 동시 요청에서 완료 시점 잔액 부족이면 일은 했는데 과금이 실패한다(무료 제공 = 돈 구멍). 홀드는 ARCHITECTURE 9장 설계이기도 해서 S06이 그대로 이어받는다. 반박: "뼈대가 너무 무겁다" → 거래 종류 3개, 함수 3개다. 구매자 관점의 총 이동(지갑+홀드 −, 매장 +, 플랫폼 +, 합 0)은 같다.
- 금액: 고정 단가 `0.01 CR`(10,000 µCR)/요청, 노드 몫 = `floor(가격 × 7000 / 10000)`, 플랫폼 = 나머지 — `SKELETON(S08)`. 거래 종류·계정 선택은 `SKELETON(S06)`.
- `holds.buyer_account_id`는 구매자 **홀드 계정**을 가리킨다(M4 대사 = 홀드 계정 잔액 = 그 계정의 활성 홀드 합). 가정으로 기록.

### D-b. 개발용 노드 인증: 공유 비밀에서 ed25519 키를 유도한다 (프로토콜 그대로)
- `hello → auth.challenge → auth.prove → auth.ok`를 S02 그대로 쓴다. 에이전트와 서버가 `DEV_AGENT_SECRET`과 `nodeId`에서 같은 ed25519 시드 `HMAC-SHA256(secret, "binjari-dev-node-key-v1\n" + nodeId)`를 유도한다. 서버는 그 공개키로 서명을 검증한다(`verifyEd25519`, nonce 5초 일회용).
- `nodeId`·`fpStore`·`fpGlobal`도 에이전트 이름에서 결정적으로 유도한다(재시작해도 같은 노드 행). 처음 보는 nodeId는 개발용 매장에 자동 등록한다 — `SKELETON(S10, S11)`.
- 대안: 비밀을 메시지에 그대로 실어 보내기(임시 형식). 버림: 차수 원칙 "버릴 임시 형식을 만들지 않는다"와 어긋나고, 비밀이 평문으로 매번 오간다. TS·Go 유도 결과는 공유 벡터 파일로 고정한다.
- 반박: "비밀을 아는 사람은 누구든 노드가 된다" → 개발용이 맞다. 운영(`NODE_ENV=production`)에서는 개발용 비밀·키가 설정돼 있으면 서버가 시작을 거부한다(D-f).

### D-c. 시간 판단은 DB 조건부 갱신 + 주기 청소(sweep)
- 오퍼 2초(T8), 리스 15초(T11, `job.accept`·`job.progress`·`job.chunk`로 갱신), 용량 대기 30초(T19), 작업 마감 10분(T21)은 모두 DB 값(`offered_at`, `lease_expires_at`, `status_changed_at`, `deadline_at`)과 주입된 `Clock`으로 판단하고, 청소 함수가 조건부 UPDATE로 처리한다. 타이머 상태를 메모리에 두지 않으므로 FakeClock으로 결정적 테스트가 된다.
- 경합(완료 vs 리스 만료, 완료 두 번, 늦은 수락)은 모두 `WHERE status = '<기대 상태>'` 조건부 갱신으로 하나만 이긴다. 진 쪽은 아무것도 바꾸지 않는다(늦은 완료는 `superseded`, 보상 없음).
- 재시도: 수락된 시도가 실패(리스 만료·끊김·`job.fail` 재시도 가능·선점)하면 작업을 다시 `queued`로 — 수락된 시도는 최대 3번(처음 + 재시도 2회). 오퍼 무응답·거절은 다음 노드로 넘기되 그 작업에서 이미 시도한 노드는 다시 고르지 않는다.
- 대안: 메모리 타이머(setTimeout). 버림: 테스트가 실제 시간에 묶이고 서버 재시작 때 상태를 잃는다. 반박: "청소 주기(기본 250ms)만큼 늦다" → 2초·15초 판단에 250ms 오차는 무해하다. 다중 인스턴스 큐(SKIP LOCKED, LISTEN/NOTIFY)는 `SKELETON(S12)`.

### D-d. 연결 끊김 = 즉시 손실 (재개 창 없음)
- 소켓이 닫히면 그 노드의 진행 중 시도를 즉시 `lost`로 만들고 재시도한다. 재개(T10)는 `SKELETON(S11)`. 끊긴 노드가 다시 붙어 옛 시도의 완료를 보내면 `superseded`로 버린다(이중 과금 없음).
- 서버는 10초 동안 아무 메시지도 없는 연결을 닫는다(T10). 에이전트는 서버 메시지가 10초 없으면 실행 중 작업을 멈추고 재연결한다(T13).

### D-e. 구매자 콘텐츠
- 입력(messages)은 AES-256-GCM으로 `job_payloads`(kind `input`, 보존 24시간 T27)에 저장하고, 오퍼를 보낼 때 복호화한다. 출력은 DB에 저장하지 않고 메모리에서 바로 응답한다. 만료된 payload 행은 청소 함수가 지운다.
- 로그·대시보드·오류 메시지에는 메타데이터(길이·토큰 수·상태)만. 서버 로거는 요청 본문을 찍지 않는다.
- 키: `DATA_ENCRYPTION_KEY`(64 hex) + `DATA_ENCRYPTION_KEY_ID`. 개발 서버는 없으면 프로세스마다 임시 키를 만든다(재시작하면 옛 입력을 못 읽음 — 뼈대에선 무해). 키 회전·관리는 `SKELETON(S12)`.

### D-f. 데모 설정이 운영 기본값이 되지 않게
- 바인딩 기본 `127.0.0.1`. LAN은 `HOST=0.0.0.0`(개발 서버 `--lan` 플래그)로만.
- `DEV_API_KEY`·`DEV_AGENT_SECRET`에는 기본값이 없다(24자 이상 필수). `NODE_ENV=production`에서 둘 중 하나라도 설정되면 설정 오류로 시작 거부. 개발용 인증이 꺼져 있으면 해당 엔드포인트는 401/`auth.fail`.
- `/dev` 대시보드는 `NODE_ENV=development` 또는 `DEV_DASHBOARD=1`일 때만 라우트가 등록된다(아니면 404). 운영에서 `DEV_DASHBOARD=1`이면 시작 거부.
- 서버 DB 연결은 언제나 `role=binjari_app`으로 시작한다(`-c role=binjari_app`). 연결 URL이 소유자 계정이어도 트리거를 끌 수 없는 권한으로 돈다(S03 영향). 관리형 풀러가 시작 옵션을 지원하는지는 S30.

### D-g. 에이전트(Go) `binjari-agent run`
- `--server`, `--secret`(또는 `BINJARI_DEV_AGENT_SECRET`), `--name`, `--runtime fake|ollama`, `--ollama-url`, `--model <id>=<ollama 이름>`(반복), `--always-available`.
- `--always-available`이 없으면 `eligible=false`(사유 `helper_missing`)로 보고하고 작업을 받지 않는다 — 손님 감지가 없으면 '불확실 = 멈춤'(절대 규칙 1). 손님 감지는 `SKELETON(S18)`.
- 런타임 인터페이스 + `fake`(결정적 출력) + `ollama`(`POST /api/chat`, `stream:false`). Ollama 모델 이름(`qwen2.5:0.5b`)은 프로토콜 모델 ID 규칙(`:` 금지)에 맞지 않아 `--model`로 대응시킨다.
- Ctrl+C: 진행 중 작업 취소 → `job.preempted(reason=shutdown)` 전송(최대 1초) → 연결 종료. 서버 지시(`job.cancel`·`control.pause`·`control.kill`)와 잘못된 멈춤 명령(`DecodeError.Pause`)에도 즉시 멈춘다.
- WebSocket: `github.com/coder/websocket` v1.8.15(ISC, 스택 결정).

### D-h. TS 가짜 에이전트 `FakeAgent`(testkit)
- 같은 프로토콜(코덱·서명·개발용 신원)을 쓰는 TS 구현. Node 22 내장 `WebSocket`을 써서 의존성을 늘리지 않는다. 테스트용 행동 옵션: 수락 안 함, 수락 뒤 침묵, 완료 두 번 보내기, 재시도 가능 실패, 지연.
- testkit이 `@binjari/protocol`에 의존하게 된다(protocol은 testkit을 devDependency로 vitest 설정에만 씀 → 개발 의존성 순환). pnpm이 허용하는지 확인하고, 문제가 되면 FakeAgent를 별도 하위 경로로 분리한다.

### D-i. 서버 모듈 배치 (ARCHITECTURE 2.1 이름)
`lib`(config·ids·crypto), `ledger/skeleton.ts`(돈 — 린트의 money 규칙 적용), `gateway/`(WS 세션·개발용 인증), `scheduler/`(배정·수명·청소), `buyerApi/`(chat completions), `fleet/`(노드 상태), `skeleton/bootstrap.ts`(개발용 매장·구매자·충전), `dev/dashboard.ts`. 각 단순화 지점에 `SKELETON(SNN)`.

### D-j. 데모·검사 도구
- `pnpm demo`(`apps/server/src/bin/demo.ts`): 임시 Postgres → 마이그레이션 → 개발용 준비 → 서버(127.0.0.1:임의 포트) → 에이전트 2개(Go가 있으면 `go build`한 Go 에이전트 fake 런타임, 없으면 TS FakeAgent) → 요청 10개 → 잔액·원장 합 표 → "10/10 완료, 원장 합 0". 실패하면 종료 코드 1.
- `pnpm dev:server`(친구 PC 데모용): 같은 준비 + 서버 상주. `--lan`일 때만 0.0.0.0.
- `scripts/check-skeleton.mjs`: 저장소의 `SKELETON(SNN)` 표시를 차수별로 출력, 형식이 틀린 표시나 STAGES에 없는 차수면 실패. `--expect <REPORT.md>`로 교체 목록 표와 대조.

## 위험
| 위험 | 대응 |
|---|---|
| 완료·만료·재시도 경합에서 이중 과금·과금 누락 | 모든 상태 전이를 조건부 갱신 + 같은 트랜잭션의 원장 거래로. E2E(끊김 포함)·완료 2회·늦은 완료 테스트로 확인 |
| 작업이 영원히 running/offered로 남음 | 리스·오퍼·마감 청소. E2E 끝에 활성 시도 0, 비최종 작업 0, 활성 홀드 0을 단언 |
| Windows에서 embedded-postgres·WS 테스트가 느리거나 불안정 | 시간 값을 설정으로 줄여 테스트(오퍼 300ms, 리스 1.5초), 대기는 조건 폴링 |
| 개발 의존성 순환(testkit ↔ protocol) | 설치·타입체크 확인, 안 되면 패키지 분리 |
| Ollama가 AMD GPU를 못 쓰면 CPU로 느림(K17) | 진행 보고(5초)로 리스 유지, 마감 10분. DEMO_0에 `ollama ps` 확인법 |

## 새 의존성
- `@fastify/websocket` 11.3.1(MIT, 2026-09-18, 스택 결정) — 서버 WS. 내부적으로 `ws`.
- `github.com/coder/websocket` v1.8.15(ISC, 2026-06-15, 스택 결정) — 에이전트 WS 클라이언트.
- testkit → `@binjari/protocol`(워크스페이스).

## 체크포인트
| # | 내용 | 검증 |
|---|---|---|
| 1 | 설정(개발용 키·운영 거부·LAN), DB `binjari_app` 연결 옵션, 개발용 신원 유도(TS·Go 공유 벡터), 의존성 추가 | config 테스트, devauth 벡터 테스트(TS·Go) |
| 2 | 원장 뼈대(홀드·캡처·해제), payload 암호화, 개발용 준비(bootstrap) | 통합 테스트: 합 0, 멱등, 잔액 부족 402, binjari_app 권한으로 동작 |
| 3 | 게이트웨이·스케줄러·구매자 API·FakeAgent | 통합 테스트: 정상 완료, 오퍼 무응답 → 다음 노드, 리스 만료 → 재시도, 재시도 상한 → 해제, 완료 2회 → 캡처 1회 |
| 4 | E2E(노드 2, 요청 20, 도중 끊김) | 이중 과금 0, 원장 합 0, 실패 요청 과금 0, 남은 활성 상태 0 |
| 5 | `/dev` 대시보드 + `dev:server` | 라우트 테스트(꺼짐 404, 이스케이프, 콘텐츠 없음) |
| 6 | Go 에이전트 `run`(fake·ollama·Ctrl+C·멈춤 명령) | Go 테스트(가짜 Ollama HTTP, 가짜 WS 서버), 교차 빌드 |
| 7 | `pnpm demo`, `check-skeleton.mjs`, `DEMO_0.md`, 문서·HUMAN_TODO | `pnpm demo` 출력, 검사 스크립트 테스트 |
| 8 | 게이트(verify·적대적 검토·반영) | `pnpm verify` |
