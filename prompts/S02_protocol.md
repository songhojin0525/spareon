# S02 · 프로토콜 계약 (JSON Schema → TypeScript·Go)

| 항목 | 값 |
|---|---|
| 의존 | S01 |
| 권장 모델 | Opus 5.5 |
| 규모 | L |
| 사람 필요 | 없음 |

이 차수는 `prompts/_PROTOCOL.md`를 따른다.

## 목표
에이전트⇄서버 통신의 모든 메시지를 JSON Schema 하나로 정의하고, TypeScript와 Go가 **같은 스키마로** 검증하며, 고정된 예시(fixture)에 대해 양쪽이 같은 판정을 내리는지 계약 테스트로 보장한다. 프로토콜이 어긋나면 수천 대 PC가 한꺼번에 고장 나므로 엄격해야 한다.

## 먼저 읽을 것
- `docs/ARCHITECTURE.md`(시퀀스, 상태 기계, 시간 예산), ADR 0003·0008·0011, `docs/THREAT_MODEL.md`의 게이트웨이 관련 행

## 산출물
- `packages/protocol/schemas/` — 봉투, 메시지별 스키마, 공용 정의(`defs/`)
- `packages/protocol/src/` — 생성된 TS 타입, Ajv로 컴파일한 검증기, 메시지 생성 헬퍼, 스키마 번들 해시
- `packages/protocol/fixtures/{valid,invalid}/`
- `apps/agent/internal/protocol/` — Go 타입, `embed`로 내장한 스키마로 검증(`github.com/santhosh-tekuri/jsonschema/v6` 권장), 번들 해시
- `docs/PROTOCOL.md`
- 생성 스크립트 `pnpm --filter @binjari/protocol gen`과 "생성물이 최신인지" 검사

## 상세 요구사항

### 1. 봉투(envelope)
```json
{ "v": 1, "type": "<메시지 타입>", "id": "<UUIDv7>", "ts": "<RFC3339 밀리초 UTC>", "corr": "<응답 대상 id, 선택>", "payload": { } }
```
- 봉투는 추가 필드 금지(`additionalProperties: false`). 최대 크기 1 MiB(설정 가능).
- 작업 입력은 인라인 256 KiB 이하. 넘으면 `inputRef`(HTTPS로 조회, 단기 서명 토큰)로 보낸다.
- 알 수 없는 `type`은 거부하고 `error`로 응답한다. payload도 기본은 추가 필드 금지, 확장 지점만 명시적으로 허용한다.
- 모든 문자열·배열에 최대 길이를 둔다(무제한 금지).

### 2. 메시지 목록
PROTOCOL.md에 표로: 타입, 방향, 필수 필드, 의미, 기대 응답, 시간 제한.

- **인증**: `hello`(A→S: protocolHash, agentVersion, nodeId, capabilitiesDigest) · `auth.challenge`(S→A: nonce, serverTime) · `auth.prove`(A→S: ed25519 서명) · `auth.ok`(S→A: sessionId, resumeToken, configVersion, serverTime) · `auth.fail`(code, minAgentVersion?)
- **상태**: `capabilities`(GPU 목록[이름, UUID 해시, VRAM 총량·여유, 드라이버, 연산 능력], CPU, RAM, 캐시 디스크 여유, 런타임 버전, 캐시된 모델[id, sha256], OS 빌드) · `status`(state, presence 요약: idleForMs, customerPresent, reasonCodes[], gpu: tempC·utilPct·powerW·vramUsedMb, 실행 중 attemptIds, 측정 시각) · `heartbeat` / `heartbeat.ack`(serverTime — 시계 차이 측정)
- **작업**: `job.offer`(attemptId, jobKind, model{id, sha256}, params[허용 목록: maxTokens, temperature, topP, stop[], seed, greedy], input{messages | prompt | continuationPrefix} 또는 inputRef, stream, deadline, leaseTtlMs, verification 플래그) · `job.accept` · `job.reject`(reason: notIdle | modelMissing | insufficientVram | busy | policy | thermal | shuttingDown) · `job.chunk`(attemptId, seq, textDelta, tokensSoFar) · `job.complete`(attemptId, outputText 또는 outputRef, finishReason, reportedTokensIn/Out, timings{loadMs, promptMs, genMs}, outputSha256, runtime{name, version}) · `job.fail`(code, retryable) · `job.preempted`(attemptId, reason: customerInput | gpuBusy | thermal | schedule | kill | shutdown, lastSeq) · `job.cancel`(S→A)
- **제어**: `control.pause` / `control.resume`(scope: node | store | global, reason) · `control.kill` · `config.update`(policy, version) · `model.ensure`(서명된 매니페스트) · `model.status`(다운로드 진행) · `update.available`(서명된 릴리스 매니페스트)
- **공통**: `error`(code, message, fatal)
- **HTTPS 등록 흐름**(WS 아님): `enroll.start` 요청·응답, `enroll.complete` 요청·응답(S10에서 구현).
- **정책(policy) 스키마**: 주간 일정(7일 × 48칸 30분 단위 비트맵), minIdleMinutes, maxGpuTempC, downloadWindow, modelAllowlist, transparencyMode, maxConcurrentJobs(기본 1).

### 3. 서명 대상 바이트 (위조 방지)
- `auth.prove` 서명 대상은 정확히 다음 UTF-8 바이트로 고정한다: `"binjari-auth-v1\n" + nonce + "\n" + nodeId + "\n" + protocolHash`(nonce는 `auth.challenge`로 받은 값, 일회용·짧은 만료. 필드 이름은 ADR 0008과 맞춘다). 앞의 도메인 구분 문자열은 다른 용도의 서명(매니페스트 등)과 혼동되지 않게 하기 위한 것이다.
- 매니페스트 서명도 정규화 규칙(JSON 키 정렬, 공백 없음, UTF-8)을 문서와 테스트 벡터로 고정한다.
- 고정 키·고정 nonce로 만든 테스트 벡터를 TS와 Go가 똑같이 검증해야 한다.

### 4. 버전·호환
- `protocolHash` = 정규화한 스키마 번들의 SHA-256. TS와 Go가 같은 값을 계산하는 테스트 필수.
- 서버는 지원하는 해시 집합을 갖고, 모르는 해시면 `auth.fail(code=protocol_unsupported)`.
- 하위 호환 규칙(필드 추가는 선택 필드로만 등)과 깨지는 변경의 절차를 문서화한다.

### 5. 오류 코드 레지스트리
- `packages/protocol/schemas/defs/error-codes.json`: 코드마다 의미, 재시도 가능 여부, 에이전트가 해야 할 동작.

### 6. 계약 테스트
- 메시지 타입마다 valid fixture ≥ 1, invalid fixture ≥ 3(필수 필드 누락, 타입 오류, 금지된 추가 필드 또는 크기 초과).
- TS와 Go가 모든 fixture에 대해 같은 판정을 내린다(양쪽 테스트가 같은 fixture 폴더를 읽는다).
- 왕복 테스트: 디코드 → 인코드 → 의미가 같다.
- 생성물 최신성: 스키마만 바꾸고 gen을 안 돌리면 테스트가 실패한다.

### 7. PROTOCOL.md
- 봉투, 메시지 표, 시퀀스(정상 · 재연결 · 선점 · 킬), 시간 제한, 오류 코드, 버전 정책, 보안 고려(재전송, 크기 제한, 서명 대상 바이트 정의).

## 하지 말 것
- 서버·에이전트의 실제 연결 구현(S11, S17)
- 스키마에 사람이 읽는 문구 넣기

## 수용 기준
1. `pnpm verify` 통과(Go가 있으면 Go 테스트 포함)
2. 모든 메시지 타입이 fixture 규칙을 충족하고, TS·Go 판정이 일치
3. protocolHash 일치 테스트 통과
4. 서명 테스트 벡터를 TS·Go가 똑같이 검증

## 적대적 검토 포인트
- 서명 대상의 모호성(필드 순서, 인코딩)으로 인한 위조 가능성
- 크기 제한 누락(무제한 배열·문자열)
- 시간 문자열·정수 범위 파싱의 TS/Go 차이(특히 64비트 정수는 JSON에서 문자열로 다룰지 결정)

## 선택 확장
- 스키마 변경 시 호환성 깨짐을 잡는 diff 검사기
- PROTOCOL.md의 메시지 표 자동 생성
