# S02 보고서 — 프로토콜 계약 (JSON Schema → TypeScript·Go)

- 상태: DONE
- 커밋 범위: `stage-S02-start..stage-S02-done`
- 시작 / 종료: 2026-10-09 13:36 / 2026-10-09 19:20

## 한 일 (5줄 이내, 사람이 30초 안에 읽을 수 있게)
- 에이전트⇄서버 메시지 27종(WS)과 등록 HTTPS 본문 5종, 매니페스트 2종을 JSON Schema 2020-12 하나로 정의했다. 직접 만든 생성기가 TS 타입·Go 구조체·내장 번들·`protocolHash`를 만들고, 크기 제한이 빠진 스키마는 생성 단계에서 거부한다.
- TS(Ajv)와 Go(santhosh-tekuri/jsonschema)가 같은 판정 순서(7단계)와 엄격 JSON 인식기로 fixture 290개(valid 50, invalid 240)에 같은 판정 코드를 낸다.
- `auth.prove`·`enroll.complete`·매니페스트의 서명 대상 바이트를 고정했다(도메인 문자열, 형식 검사, 검증 후 파싱). 게이트 검토에서 작은 차수·비정규 공개키 거부를 추가했다.
- 게이트 검토 후 보완: 무효인 멈춤 명령이 오면 에이전트가 멈추게 했다(fail-safe `pause`). `inputRef`로 큰 입력을 보낼 수 있게 하고 `decodeJobInput`을 추가했다. Go의 nil 배열이 `null`로 나가던 문제도 고쳤다.
- 문서: `docs/PROTOCOL.md`(테스트가 표를 스키마와 대조), ADR 0017, ARCHITECTURE 12절 D24~D29.

## 실행하는 법 (복사해서 바로 쓰는 명령)
```
pnpm verify                                   # 전체 게이트
pnpm --filter @binjari/protocol gen           # 스키마 수정 후 생성물 다시 만들기(안 하면 최신성 테스트 실패)
pnpm --filter @binjari/protocol test          # TS 계약·벡터·스키마 규칙 테스트
cd apps/agent && go test ./internal/protocol/ # Go 계약·벡터 테스트(같은 fixture 폴더)
```

## 수용 기준 결과
| # | 기준 | 실행한 명령 | 결과 |
|---|---|---|---|
| 1 | `pnpm verify` 통과(Go 포함) | `pnpm verify` (go1.27.0 windows/amd64) | PASS: format·docs·lint·typecheck·test·gofmt·vet·go test·Windows 빌드 9단계 전부 통과(최종 `fe9a321`, 지휘자가 다시 실행해 확인) |
| 2 | 모든 메시지 타입이 fixture 규칙(valid ≥1, invalid ≥3: 누락·타입 오류·추가 필드 또는 크기)을 충족하고 TS·Go 판정 일치 | `pnpm --filter @binjari/protocol test`(contract.test.ts의 `fixture coverage`·`valid fixtures`·`invalid fixtures`), `go test ./internal/protocol/ -run 'TestContract\|TestEveryTypeHasFixtures'` | 통과. 32개 타입·본문 전부 규칙 충족, fixture 290개를 양쪽이 같은 폴더에서 읽어 같은 코드를 냄. 왕복(디코드→인코드→정규형 비교)도 통과. 검토자가 별도로 57개 입력을 양쪽에 넣었을 때 판정 차이 0건 |
| 3 | protocolHash 일치 | `generated.test.ts`(`protocol hash`), Go `TestProtocolHashMatchesTS`(원천 스키마에서 Go 파서·정규화로 직접 계산) | 통과. `c67e072c232742c69718f4e49fa18fdc44f2fc65f61a165e6277af3173e5c6ff`가 TS 상수·Go 상수·내장 번들에서 같음 |
| 4 | 서명 테스트 벡터를 TS·Go가 똑같이 검증 | `signatures.test.ts`, Go `TestSignatureVectors` | 통과. RFC 8032 키, auth·enroll 바이트·서명, 변조 사례, 매니페스트 사례, 작은 차수 키 위조 7건, 공개키 판정 16건이 양쪽에서 같음 |

## 적대적 검토 결과
| 심각도 | 지적 | 조치(고침 / 안 고친 이유) |
|---|---|---|
| 중간 | 작은 차수·비정규 ed25519 공개키를 받아들인다. 그런 키를 등록하면 개인키 없이 `auth.prove`를 위조할 수 있고, 같은 키를 여러 표기로 써서 복제 탐지를 피할 수 있다 | 고침(`2b4ad74`). `isAcceptablePublicKey`/`IsAcceptablePublicKey`(y < p, 작은 차수 8점 거부)를 검증 함수에 넣었다. 지금 OpenSSL로 실제 통과하는 위조 7건과 공개키 판정 16건을 벡터로 고정했고, 검사를 빼면 양쪽 테스트가 실패하는 것을 확인했다. 섞인 차수 키의 부분군 검사는 하지 않는다(가정 참조) |
| 중간 | Go 필수 배열이 nil이면 `null`로 직렬화된다. 흔한 `status`를 못 보내고, `CapabilitiesDigest`가 nil/빈 배열에 따라 달라진다 | 고침(`5b1be46`). 생성기가 필수 배열이 있는 구조체에 `MarshalJSON`(nil → `[]`)을 만든다. nil 슬라이스 status 인코딩 테스트와 digest 동일성 테스트를 추가했다(옛 생성물에서는 실패) |
| 중간 | payload가 무효인 `control.kill`·`control.pause`를 에이전트가 버리기만 해서, 그동안(최대 3~13초) 킬스위치가 듣지 않는다. 판정 결과에 `type`도 없다 | 고침(`466e334`). 거부 결과에 `type`과 `pause`를 넣었다. registry `onInvalid: "pause"`(control.pause·control.kill·job.cancel)가 무효이거나, 받는 쪽이 에이전트이고 타입을 알 수 없는 거부(크기·JSON·봉투)이면 `pause = true`. 양쪽 계약 테스트가 모든 invalid fixture에서 이 규칙을 확인한다. PROTOCOL 4절에 에이전트 동작과 서버 재전송 규칙을 적었다 |
| 중간 | 인라인 한도를 넘는 입력을 `inputRef`로도 보낼 수 없다(job-input 문자열 상한이 262144). inputRef 본문을 검증하는 API도 없다 | 고침(`4a1687f`, `bd8433e`). job-input 문자열 상한을 16 MiB(`maxInputRefBytes` = `inputRef.bytes` 최대값)로 올렸다. 인라인 256 KiB는 판정 7단계(바이트)가 그대로 막는다. `decodeJobInput`/`DecodeJobInput`(바이트 한도, 엄격 JSON, 스키마, jobKind별 모양)과 공유 벡터 12건을 추가했다 |
| 낮음 | 시각을 정규식으로만 검사해 `2026-02-30` 같은 값이 코덱을 통과한다. fixture 이름도 내용과 다르다 | 고침(`10447c2`). 달력 검사는 `parseTimestamp`/`ParseTimestamp`가 하고, 양쪽 테스트에 이미 들어 있다. 이 사실을 PROTOCOL 2절에 적고 fixture 이름을 `measured-at-without-millis`로 바꿨다 |
| 낮음 | `auth.prove` 서명 대상에 서버 audience가 없어 중계 가장 여지가 있다 | 안 고침. 영향이 작다(노드는 TLS로 운영 서버를 확인하고, 접속 주소는 설치 때 고정). PROTOCOL 12절과 가정에 적었다. 필요하면 `binjari-auth-v2`로 추가한다 |
| 낮음 | TS 왕복 테스트가 사실상 동어반복이다 | 안 고침. TS 디코드는 파싱한 객체를 그대로 돌려주는 설계라 변환 계층이 없다. TS 쪽은 encode가 다시 검증하는지를 확인하고, 형식이 있는 왕복은 Go(구조체 디코드 → 인코드)가 같은 fixture로 검증한다. 생성 경로는 새 nil 배열 테스트가 덮는다 |
| 낮음 | fixture가 의도와 다른 위치에서 거부돼도 통과로 센다. Go valid 테스트는 폴더 이름 오타를 조용히 넘긴다 | 일부 고침. Go valid 테스트는 receivers가 비면 실패한다(`466e334`). instancePath 비교는 하지 않는다. `detail`은 언어 간 계약이 아니고, Ajv와 santhosh가 `oneOf` 실패 위치를 다르게 보고하기 때문이다 |
| 낮음 | API 의미 차이(TS `maxBytes: 0` = 전부 거부, Go = 기본값). Go에는 1 MiB 경계 테스트가 없다 | 고침(`466e334`). 양쪽 모두 0 이하는 기본값이고, 양쪽에 경계 테스트를 추가했다. 모르는 HTTP 본문 이름(TS 예외, Go `unknown_type`)은 그대로 둔다. TS는 이름이 컴파일 시점 타입이라 프로그래밍 오류로만 생긴다 |
| 낮음 | 스키마 린트 구멍: 최상위 `^a\|b$`, `maxLength`·`maxItems` 상한 없음, 제약 안의 `properties` 이름 미검사 | 앞의 둘은 고침(`e2de223`, 최대 16 MiB). 제약 안 `properties`는 안 고침: 현재 스키마에 없고, 허용된 제약 키워드는 `required`·`const`·`enum`뿐이며 그 이름은 이미 검사한다 |
| 낮음 | `httpsUrl`이 IP 리터럴·localhost·링크 로컬·잘못된 포트를 허용한다(SSRF 표면) | 안 고침. 진짜 통제는 에이전트의 허용 호스트 목록이고, 정규식으로는 "서버 호스트"를 표현할 수 없다. S20 LAN 캐시가 사설 주소를 쓸 수 있어 스키마에서 일괄 차단하지 않는다 → S17·S22에서 코드로(다음 차수 영향) |
| 낮음 | 릴리스 매니페스트 `files[].path`에 중복·대소문자 중복·Windows 예약 이름 금지가 없다 | 안 고침. 운영자 키로 서명된 값이라 위험이 낮다. S21 적용 단계에서 소문자 기준 중복과 예약 이름을 거부한다(다음 차수 영향) |
| 낮음 | `downloadWindow`의 start = end 의미가 정해져 있지 않다 | 고침(`10447c2`). start = end는 하루 전체, `endMinute` 1440은 자정이다. PROTOCOL 5.3절 |

참고: 게이트 중 문서 수정 스크립트의 문자열 치환 버그(`$` 치환 패턴)로 `docs/PROTOCOL.md`가 세 배로 불어난 커밋(`e2de223`)이 있었다. 직전 커밋에서 복원하고 다시 적용했다(`c453f2b`, 최종 341줄). check-docs는 내용 중복을 잡지 못한다.

## 가정 (사람이 나중에 확인할 것)
| 가정 | 근거 | 틀리면 바꿀 곳 |
|---|---|---|
| 프로토콜 숫자는 정수만. temperature·topP는 1/1000 정수, 64비트 값은 소문자 hex 문자열 | JS·Go 숫자 파싱 차이 제거(ADR 0017) | `schemas/messages/job.offer.json`, S14 변환 |
| 공개키는 정규 인코딩 + 작은 차수 8점 아님만 검사, 섞인 차수 부분군 검사는 안 함 | 정직한 에이전트는 만들지 않고, 양쪽 검증기가 같은 cofactorless 식이라 판정 차이 없음 | `src/sign.ts`·`sign.go`의 `isAcceptablePublicKey` |
| 무효인 멈춤 명령이나 타입을 알 수 없는 서버 메시지를 받으면 에이전트는 Paused | 절대 규칙 1 | `schemas/registry.json`의 `onInvalid`, `codec.ts`·`codec.go` |
| `auth.prove`에 서버 audience 없음. TLS로 중계를 막는다고 가정 | 노드는 설치 때 고정된 서버 하나에만 접속 | 도메인 `binjari-auth-v2` + origin 구성요소 |
| `inputRef` 본문 상한 16 MiB | 128k 토큰 입력과 긴 이어쓰기 접두사를 충분히 담는다 | `limits.json`의 `maxInputRefBytes`, `job.offer` `inputRef.bytes` (S12에서 컨텍스트 길이와 재확인) |
| `downloadWindow`의 start = end는 하루 전체 | 빈 창은 모델을 영영 못 받는다 | PROTOCOL 5.3절, S10·S17 정책 해석 |

## 사람이 확인할 것 (HUMAN_TODO에도 추가함)
없음. 이 차수는 사람 작업이 필요 없다(원격 push 뒤 CI의 Windows 잡 결과만 평소처럼 확인).

## 막힌 것
| 증상 | 시도한 것 | 추정 원인 | 사람이 확인할 것 |
|---|---|---|---|
| 없음 | | | |

## 다음 차수에 미치는 영향
- **S04(걷는 뼈대)**: 서버는 `@binjari/protocol`의 `createCodec`·`makeMessage`·`encodeMessage`를, 에이전트·nodesim은 `binjari/agent/internal/protocol`의 `NewCodec`·`EncodeMessage`·`DecodeMessage`를 쓴다. 메시지를 손으로 만들지 않는다.
- **S10(등록)**: `enroll.complete` 서명을 `verifyEd25519`로 확인한다(작은 차수·비정규 키는 여기서 거부된다. 필요하면 `isAcceptablePublicKey`로 먼저 거부). 공개키는 받은 정규 문자열 그대로 저장하고 문자열 비교로 같은 키를 찾는다. 정책은 `defs/policy.json`(start = end는 하루 전체)을 따른다.
- **S11(게이트웨이)**: 세션마다 해시에 맞는 코덱(`SUPPORTED_PROTOCOL_HASHES`, `createCodec(bundle)`)으로 받고 보낸다. 거부 결과의 `id`로 `error` 응답의 `corr`를 채운다. 에이전트가 자기가 보낸 적 없는 `Paused`를 보고하면 현재 제어 상태를 다시 보낸다(PROTOCOL 4절). nonce는 5초, 일회용.
- **S12(스케줄러)**: 256 KiB를 넘는 입력과 선점 뒤 긴 `continuationPrefix`는 `inputRef`(본문 ≤ 16 MiB, `bytes`·`sha256` 포함)로 보낸다. 출력은 `job.chunk` + `outputRef{kind:"chunks"}`. 샘플링 값은 milli 정수다.
- **S14(구매자 API)**: 실수 temperature·top_p를 경계에서 한 번 milli 정수로 바꾼다.
- **S17(에이전트 코어)**: `DecodeError.Pause`가 참이면 control.pause와 같은 경로로 멈춘다. `inputRef` 본문은 `DecodeJobInput(data, jobKind, {MaxBytes: inputRef.bytes})` + sha256 확인을 거치고, 실패하면 `job.fail(input_invalid)`. URL은 서버·아티팩트 허용 호스트만 따른다(SSRF, S22와 함께). nil 슬라이스는 그대로 보내도 된다.
- **S21(업데이트)**: 매니페스트는 `verifySignedManifest`(검증 후 파싱)로 처리한다. 적용 전에 `files[].path`의 소문자 기준 중복과 Windows 예약 이름(`CON`, `nul.*` 등)을 거부한다. 다운그레이드 규칙(`manifest_downgrade`)을 구현한다.
- **스키마 변경 절차**: 스키마를 고치면 `pnpm --filter @binjari/protocol gen`을 실행한다. 배포가 시작된 뒤에는 옛 번들을 `packages/protocol/history/<해시>.json`으로 보관한다(PROTOCOL 11절). 지금은 배포 전이라 보관할 옛 해시가 없다.

## 수치
- TS 테스트 736개 통과: protocol 526, repo-checks 165, testkit 18, shared 17, server 8, web 2
- Go 테스트: `go test -v ./...`의 PASS 447개(하위 테스트 포함). `internal/protocol` 최상위 테스트 19개
- fixture 290개(valid 50 / invalid 240), 벡터 파일 4개(json, signatures, digests, job-input)
- 메시지 27종(WS) + HTTPS 본문 5종 + 매니페스트 2종, protocolHash `c67e072c…c6ff`
- `pnpm verify` 약 2분 50초(이 PC, test 단계 약 90초)
- 커밋 17개(`stage-S02-start` 이후), 그중 게이트 단계 10개(`2b4ad74..fe9a321`)

## 선택 확장 결과
하지 않음(스키마 호환성 diff 검사기, PROTOCOL.md 표 자동 생성). 표는 대신 `protocol-doc.test.ts`가 스키마와 대조한다.
