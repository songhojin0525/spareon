# S02 계획 — 프로토콜 계약 (JSON Schema → TypeScript·Go)

## 목표 요약
에이전트⇄서버의 모든 메시지(WS 27종 + 등록 HTTPS 본문 5종)를 `packages/protocol/schemas/`의 JSON Schema 2020-12 하나로 정의한다. TS(Ajv)와 Go(`santhosh-tekuri/jsonschema/v6`)가 **같은 스키마 번들**로 검증하고, 같은 fixture 폴더에 대해 **같은 판정 코드**를 내는지 계약 테스트로 강제한다. `protocolHash`, 서명 대상 바이트, 정규화 JSON은 고정 테스트 벡터로 양쪽이 같은 값을 내는지 확인한다.

## 핵심 설계 결정 (대안 → 선택 → 스스로 반박)

### D-a. 판정 파이프라인을 양쪽에 똑같이 둔다
순서: ① 바이트 크기 → `message_too_large` ② 엄격 JSON 검사·파싱 → `malformed_json` ③ 봉투 스키마 → `invalid_envelope` ④ 등록되지 않은 type → `unknown_type` ⑤ 받는 쪽 방향 → `wrong_direction` ⑥ 타입별 메시지 스키마 → `invalid_payload` ⑦ 의미 검사(인라인 텍스트 UTF-8 바이트 상한) → `invalid_payload`.
- 대안: 하나의 거대한 `oneOf` 스키마로 판정. 버림: 오류 원인 구분이 안 되고(알 수 없는 type에 `error`로 답해야 함) `oneOf` 40갈래는 느리다.
- 반박: "판정 코드까지 같게 하면 순서 차이로 어긋날 수 있다" → 순서를 문서·코드 양쪽에 고정하고, fixture 파일 이름에 기대 코드를 넣어 양쪽이 같은 코드를 내는지 테스트한다.

### D-b. 엄격 JSON 사전 검사 (TS·Go 같은 알고리즘)
JSON 파서 차이(TS `JSON.parse`와 Go `encoding/json`)를 없애기 위해 파싱 전에 직접 짠 인식기로 거부한다: 올바르지 않은 UTF-8, BOM, 깊이 > 32, 같은 객체 안 중복 키, 짝 없는 서로게이트 이스케이프, **정수가 아닌 숫자(소수점·지수)**, 16자리 넘는 정수.
- 이유: JS는 `5.0000000000000001`을 5(정수)로, Go는 정수 아님으로 본다. 2^53 넘는 정수는 JS에서 반올림된다. 중복 키·서로게이트 처리도 언어마다 다르다.
- 대안: 양쪽 기본 파서만 믿고 fixture로 확인. 버림: fixture가 모든 경우를 덮지 못한다.

### D-c. 프로토콜 숫자는 정수만 (명세 보완 → ADR 0017, ARCHITECTURE D24)
`temperature`·`topP`는 1/1000 단위 정수(`temperatureMilli` 0~2000, `topPMilli` 1~1000)로 보낸다. 모든 정수는 스키마에 `minimum`·`maximum`이 있고 |값| ≤ 2^53−1. 64비트가 필요한 값(해시·nonce·키)은 문자열(소문자 hex)이다. 돈은 프로토콜에 없다.
- 반박: "구매자 API는 실수 temperature를 받는다" → 서버 경계(S14)에서 한 번 정수로 바꾸면 된다. 0.001 단위면 llama.cpp 샘플링에 충분하다.

### D-d. 정규화 JSON(RFC 8785 부분집합)과 서명 대상
- 정규화: 키는 UTF-16 코드 단위 순, 공백 없음, 문자열은 `"`·`\`·제어문자만 이스케이프(소문자 `\u00xx`), 정수만. 스키마 번들 해시와 매니페스트 서명에 쓴다.
- `auth.prove`: `"spareon-auth-v1\n" + nonce + "\n" + nodeId + "\n" + protocolHash`(UTF-8). 각 구성요소는 줄바꿈이 들어갈 수 없는 형식(소문자 hex·UUIDv7)이고, 형식이 다르면 바이트를 만들기 전에 거부한다 → 경계 모호성 없음.
- `enroll.complete`: `"spareon-enroll-v1\n" + nonce + "\n" + enrollId + "\n" + publicKey + "\n" + fpStore + "\n" + fpGlobal`.
- 매니페스트: 메시지에는 매니페스트를 **정규화 JSON 문자열 그대로** 싣고(`manifest`), 서명은 `"spareon-<kind>-manifest-v1\n" + manifest` 바이트에 대해 한다. 검증 순서: 서명 확인(받은 바이트 그대로) → 엄격 파싱 → 다시 정규화한 결과가 받은 문자열과 같은지 → 매니페스트 스키마. 객체로 싣고 양쪽이 각자 정규화하는 대안은 파서 차이가 서명 우회가 될 수 있어 버림.
- 이진값은 모두 소문자 hex(공개키 64자, 서명 128자, nonce 64자). base64는 비정규 인코딩(같은 바이트, 다른 문자열) 문제가 있어 버림.

### D-e. 코드 생성기를 직접 만든다
`packages/protocol/scripts/gen.ts`가 스키마에서 TS 타입·Go 구조체·번들·해시·상수를 만든다. 생성기는 우리가 쓰는 스키마 부분집합만 지원하고, **규칙 위반(최대 길이 없는 문자열, maxItems 없는 배열, 범위 없는 정수, `format`, 비ASCII·앵커 없는 pattern, 추가 필드 허용 객체)을 만나면 실패**한다 → 크기 제한 누락이 구조적으로 불가능.
- 대안: `json-schema-to-typescript` + Go용 생성기 따로. 버림: 두 도구의 해석 차이, Go 쪽 도구는 유지보수가 약하고 선택 필드·합집합 처리 규칙을 통제할 수 없다.
- 생성물 최신성: 테스트가 생성기를 메모리에서 다시 돌려 디스크 파일과 바이트 비교. 스키마만 고치고 gen을 안 돌리면 실패.
- Go는 `embed`가 모듈 밖을 못 읽으므로 정규화 번들을 `apps/agent/internal/protocol/bundle.json`으로 복사해 내장한다(같은 최신성 검사).

### D-f. 선택 필드·배열 규칙 (왕복 테스트를 위해)
- 배열은 필수 필드이거나, 선택이면 `minItems ≥ 1`(Go `omitempty`가 값을 잃지 않게).
- Go: 선택 스칼라·객체는 포인터 + `omitempty`, 필수는 값. 디코드 → 인코드 → 의미 비교가 양쪽에서 같아야 한다.

### D-g. 명세에서 바꾸거나 더한 것 (ARCHITECTURE 12절에 D24~D29로 기록)
- `job.offer`: `verification` 플래그 없음(D4, 금지 fixture로 증명), `seed` 필수, 마감은 절대 시각이 아닌 `timeLimitMs`(7절: 에이전트는 서버 시계와 비교하지 않는다), `temperatureMilli`·`topPMilli`.
- `job.progress` 추가(T35: 비스트리밍 작업의 진행 보고).
- `ack` 추가(명령 확인 T15: control.*, config.update, job.cancel, model.ensure, update.available).
- 지문 두 개(D3): `hello`와 `enroll.complete.request`에 `fpStore`·`fpGlobal`.
- `job.complete`의 `outputRef`는 "출력은 job.chunk 0..N−1의 이어붙임"(`{kind:"chunks", chunkCount}`) — 별도 업로드 경로 없이 큰 출력 처리.
- `auth.ok`에 `serverTime`, `control`(재연결 시 바로 Paused, 4.9), `needCapabilities`. `heartbeat.ack`에 `serverTime`(7절).
- 노드가 보내는 표시용 문자열(GPU·CPU 이름, 드라이버, 버전)은 ASCII 일부 문자 집합 + 길이 상한(WEB-03). 에러 `message`도 같은 규칙.

### D-h. 버전·호환
`protocolHash` = 정규화 번들의 SHA-256. 서버는 `supported-hashes.json`(현재 + 보관한 이전 번들)을 갖고, 모르는 해시는 `auth.fail(protocol_unsupported)`. 이전 번들은 `packages/protocol/history/<hash>.json`에 보관하고 서버는 세션의 해시에 맞는 코덱으로 보낸다(`createCodec(bundle)`). 추가는 선택 필드로만, 깨지는 변경은 새 해시 + 단계적 배포(ADR 0015).

## 새 의존성
- `ajv` 8.20.0 (MIT) — TS 검증기. 2020-12 지원, 활발히 유지.
- `github.com/santhosh-tekuri/jsonschema/v6` v6.0.3 (Apache-2.0) — Go 검증기(명세 권장).
- `tsx`(이미 catalog) — gen 스크립트 실행.
- 형식 검사(`format`)는 쓰지 않으므로 `ajv-formats` 없음.

## 위험
- Ajv와 santhosh의 정규식 엔진 차이 → pattern은 ASCII·앵커·단순 문법만 허용(생성기 규칙) + fixture.
- maxLength는 코드 포인트 수(양쪽 같음, 서로게이트는 사전 검사로 정상만 통과).
- gofmt 정렬 규칙을 생성기가 맞추지 못하면 verify 실패 → 체크포인트 3에서 바로 `gofmt -l` 확인.
- Windows 줄바꿈: 해시는 파싱 후 정규화 값이라 CRLF와 무관.

## 체크포인트
1. **기반 유틸(TS)**: 엄격 JSON 인식기, 정규화 JSON, UUIDv7·시각 형식(`@spareon/shared`), 벡터 파일(정규화 JSON). 검증: 단위 테스트 + 속성 테스트(fast-check).
2. **스키마 전체**: 봉투·defs(common, policy, job-input, limits, error-codes, registry)·메시지 27종·HTTPS 본문 5종·매니페스트 2종. 검증: 스키마 규칙 검사(lint) 테스트, Ajv 컴파일.
3. **생성기**: TS 타입·메타·번들, Go 타입·메타·내장 번들, `pnpm --filter @spareon/protocol gen`, 최신성 테스트. 검증: 최신성 테스트, `tsc`, `gofmt -l`, `go vet`.
4. **TS 코덱·서명·fixture**: decode/encode 파이프라인, 서명 바이트·검증, 매니페스트 검증, 해시, valid/invalid fixture 전부, 서명 벡터. 검증: 계약 테스트(TS), 왕복, 벡터.
5. **Go 코덱·계약 테스트**: 같은 파이프라인, 같은 fixture·벡터, 소스 스키마에서 해시 직접 계산. 검증: `go test ./...`, Windows 교차 빌드.
6. **문서**: `docs/PROTOCOL.md`, ADR 0017, ARCHITECTURE 12절 D24~, check-docs 필수 파일, CI 캐시 경로. 검증: `node scripts/check-docs.mjs`.
7. **게이트**: `pnpm verify`, 적대적 검토 반영, 보고 내용.

## 체크포인트별 검증 방법
- 1~4: `pnpm --filter @spareon/protocol test`, `pnpm --filter @spareon/shared test`, `pnpm lint`, `pnpm typecheck`
- 3·5: `cd apps/agent && gofmt -l . && go vet ./... && go test ./...`, `GOOS=windows go build ./...`
- 6~7: `pnpm verify`
