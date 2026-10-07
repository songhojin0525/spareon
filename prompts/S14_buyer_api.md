# S14 · 구매자 API (OpenAI 호환·스트리밍)

| 항목 | 값 |
|---|---|
| 의존 | S12 |
| 권장 모델 | Sonnet 5.5 |
| 규모 | L |
| 사람 필요 | 없음 |

이 차수는 `prompts/_PROTOCOL.md`를 따른다.

## 목표
구매자가 이미 쓰고 있는 OpenAI SDK에서 `base_url`만 바꾸면 바로 쓸 수 있는 API를 만든다. 스트리밍, 정확한 사용량, OpenAI 형식의 에러, 키별 한도, 연결 끊김 시 정확한 정산까지. 구매자 입장에서 "그냥 되는" 경험이 첫 유료 고객(로드맵 2단계)으로 가는 길이다.

## 먼저 읽을 것
- `docs/SCHEDULER.md`(취소·이어쓰기·과금 정책), `docs/PRICING.md`, `docs/PERMISSIONS.md`, ADR 0010

## 산출물
- `apps/server/src/buyerApi/` — `/v1/models`, `/v1/chat/completions`(비스트리밍·SSE 스트리밍), `/v1/credits`(확장), `/v1/usage`(확장)
- 호환성 테스트(공식 `openai` npm 클라이언트 사용)
- `docs/BUYER_API.md` — 지원 범위표(지원 / 무시 / 거부되는 파라미터), 확장 헤더, 에러 코드, 예시(curl, Python, JavaScript)

## 상세 요구사항

### 1. 요청
- 지원 파라미터: model, messages(system/user/assistant, 문자열 content — 멀티모달은 거부), max_tokens(없으면 모델별 기본 상한), temperature, top_p, stop, seed, stream, user. 그 외 알려진 파라미터는 문서에 '무시'로, 위험하거나 지원 불가한 것은 명확한 400.
- 크기 제한: 입력 바이트 상한, 모델 컨텍스트 초과 시 400(서버 토크나이저로 미리 계산).
- 인증: `Authorization: Bearer <API 키>`, 스코프 확인, 키별 분당 요청·동시 요청 한도(429 + `retry-after`).
- 멱등성: `Idempotency-Key` 지원(같은 키 재요청 시 이전 결과 또는 진행 중 상태).
- 확장(선택): `x-binjari-trusted-only: true`(신뢰 노드만 — 가격 할증 정책은 설정값), `x-binjari-retention: none`(결과 서버 보관 0 — 스트리밍·즉시 응답에서만).

### 2. 응답
- 비스트리밍: OpenAI chat.completion 형식, `usage`(prompt_tokens, completion_tokens, total_tokens — **서버 토크나이저 기준**), 확장 필드로 `x_binjari.cost_ucr`, `x_binjari.credits_remaining`.
- 스트리밍(SSE): `chat.completion.chunk` 형식, 마지막에 usage 청크(요청 옵션이 있으면), `data: [DONE]`. 이어쓰기(S12)로 노드가 바뀌어도 구매자에게는 하나의 끊기지 않은 스트림.
- 하트비트: 생성 대기 중에도 연결이 끊기지 않도록 주석 줄(`: keep-alive`) 주기 전송.

### 3. 연결 끊김과 취소
- 구매자가 연결을 끊으면 진행 중 작업을 취소하고, S12 정책대로 실제 생성된 토큰만 과금 + 나머지 홀드 해제. 테스트로 정확한 금액 확인.

### 4. 에러
- OpenAI 형식 `{ "error": { "message", "type", "param", "code" } }`. 잔액 부족(402), 한도(429), 모델 없음(404), 용량 없음(503 + `retry-after` — 지금 손님 없는 PC가 부족할 때), 내부 오류(500, 상세 숨김).
- 용량 없음은 이 사업에서 흔하다(PC방 저녁 시간). 대기열 대기 시간 상한(설정) 안에서 기다렸다 처리하거나, 즉시 503 — 요청 헤더로 선택 가능하게 하고 기본값을 문서화.

### 5. 문서
- `BUYER_API.md`: 시작하기(키 발급 → 호출), 언어별 예시(OpenAI SDK에 base_url 지정), 가격 확인 방법, 용량 부족 시 대응 권장(배치 API 사용 등).

## 하지 말 것
- 배치(S15), 외부 모델 라우팅(S16 — 여기서는 모델 카탈로그에 외부 모델이 보이지 않게)
- 구매자 프롬프트 로깅

## 수용 기준
1. `pnpm verify` 통과
2. 공식 `openai` npm 클라이언트로 비스트리밍·스트리밍 호출이 성공(가짜 에이전트 사용)하고 usage가 원장 과금과 일치
3. 스트리밍 중 선점 → 이어쓰기 → 구매자는 끊김 없는 스트림 수신(테스트)
4. 연결 끊김 테스트: 생성된 토큰만 과금, 홀드 잔액 정확히 해제
5. 에러 형식·코드 테스트(402, 404, 429, 503), 한도 테스트
6. 로그 편집 테스트(이 API의 요청·응답 본문이 로그에 0회)

## 적대적 검토 포인트
- 다른 구매자의 작업·결과 접근(멱등 키 재사용 등을 통한 IDOR)
- 거대한 입력·느린 클라이언트로 서버 자원 고갈
- usage 숫자와 실제 과금이 어긋나는 경로

## 선택 확장
- `/v1/completions`(레거시 텍스트 완성) 최소 지원
- 응답 헤더로 처리한 매장 지역·대기 시간 노출(구매자 투명성, 노드 식별 정보는 제외)
