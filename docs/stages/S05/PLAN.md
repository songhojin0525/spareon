# S05 계획 — 서버 기반: 설정·인증·권한·API 키·감사

## 목표 요약
S04 뼈대 서버를 운영 가능한 기반으로 바꾼다. 검증된 설정(안전 스위치 포함), 프롬프트·비밀이 남지 않는 로깅, 한 가지 에러 형식, 사람 로그인(세션 쿠키 + CSRF), 구매자 API 키(HMAC 저장, 스코프, 키별 분당·동시 한도), 역할 × 동작 권한 표(문서에서 테스트 생성), 감사 기록, 멱등성, 속도 제한, OpenAPI, 운영자 CLI를 만든다. S04의 `SKELETON(S05)` 4곳(개발용 API 키 하나 = 구매자 한 명)을 실제 계정·키로 바꾸고, `pnpm demo`(10/10, 원장 합 0)와 S04 통합 테스트는 그대로 통과해야 한다.

## 핵심 설계 결정 (대안 → 선택 → 스스로 반박)

### D-a. 설정: zod 스키마 하나 + 안전 스위치 + 설명에서 `.env.example` 생성
- 필수: `DATABASE_URL`, `SESSION_SECRET`(32자 이상), `API_KEY_PEPPER`(32자 이상, `API_KEY_PEPPER_ID` 기본 `p1`), `DATA_ENCRYPTION_KEY`(64 hex) + `DATA_ENCRYPTION_KEY_ID`, `PUBLIC_BASE_URL`, `WEB_ORIGIN`(오리진만, 경로 없음). 운영에서는 두 URL이 https여야 한다.
- 안전 스위치: `PAYMENTS_MODE=live` 거부, `CASHOUT_ENABLED`가 참이면 "법률 검토 전 출금 기능 없음"으로 거부, `EXTERNAL_PROVIDERS`는 `mock`만(실제 제공사는 S16의 세 겹 스위치와 함께). 운영에서 `DEV_AGENT_SECRET`·`DEV_DASHBOARD`가 있으면 거부. 없어진 `DEV_API_KEY`가 설정돼 있으면 "CLI로 키를 만들라"는 안내와 함께 거부(옛 .env가 조용히 무시되지 않게).
- 오류 메시지에는 변수 이름과 규칙만 쓰고 값은 쓰지 않는다(비밀 노출 방지, 테스트로 확인). `main.ts`는 `ConfigError`면 항목을 stderr에 찍고 즉시 종료(1).
- 변수마다 `.meta({ description })`을 달고, `pnpm --filter @spareon/server env:example`이 `apps/server/.env.example`을 만든다. 커밋된 파일이 최신인지 테스트한다.
- 대안: 차수 문서대로 모든 차수 변수를 지금 정의. 버림: 쓰지 않는 변수는 문서와 코드 불일치(절대 규칙 8). 반박: "개발자가 매번 비밀 6개를 만들어야 한다" → 개발 서버(`pnpm dev:server`·`pnpm demo`)와 테스트 하네스는 이번 실행용 값을 만들어 넣는다.

### D-b. 로깅·에러
- pino 인스턴스를 `lib/logger.ts`가 만든다. 요청 직렬화는 메서드·경로(쿼리 제외)·라우트·requestId만, 헤더·본문은 찍지 않는다. 그 위에 편집 경로(차수 문서 목록: authorization, cookie, set-cookie, x-api-key, messages, prompt, input, choices, output + password, apiKey, token, secret)를 깊이 0~3에 건다.
- 에러 직렬화기는 V8 `JSON.parse` 오류처럼 입력 일부를 담는 메시지를 버린다(`invalid JSON`). 4xx는 에러 객체 없이 코드만 기록한다.
- `AppError(code, httpStatus, publicMessage, details?)`, 응답 `{ error: { code, message, requestId } }`. `/v1/*`은 OpenAI SDK 호환을 위해 `type`을 더한다(상위 집합). 예상 못 한 에러는 500 `internal_error`, 내부 내용 숨김. requestId는 서버가 만든 UUIDv7(받은 헤더는 믿지 않음)이고 `x-request-id`로 돌려준다.

### D-c. 사람 인증: argon2id + 서버 저장 세션 + CSRF 이중 제출(세션 결합)
- 비밀번호: argon2id m=19,456 KiB, t=2, p=1(OWASP Password Storage Cheat Sheet 최소 권장, 2026-10-10 확인). 비밀번호 길이 12~256자. 라이브러리 `@node-rs/argon2`(MIT, 플랫폼별 사전 빌드, 설치 스크립트 없음). Node 22에는 내장 argon2가 없다.
- 세션: 32바이트 무작위 토큰(쿠키) → DB에는 SHA-256만(`sessions.token_hash`). 유휴 7일 / 절대 30일(설정 가능, T34). `last_seen_at`은 1분에 한 번만 갱신. 로그인 때 늘 새 토큰을 만들고 들고 온 옛 세션은 폐기(고정 공격 방지). 로그아웃 = `revoked_at`. 계정 비활성화 = 그 사용자의 세션 전부 폐기 + 조회 때도 확인.
- 쿠키: httpOnly, SameSite=Lax, Path=/, https면 Secure + `__Host-` 접두사.
- CSRF: 상태를 바꾸는 쿠키 인증 경로(`/api/*`의 POST·PUT·PATCH·DELETE)는 ① Origin(없으면 Referer의 오리진)이 `WEB_ORIGIN`과 같고 ② `x-csrf-token` 헤더 = CSRF 쿠키 값이어야 한다. 로그인 상태면 ③ 토큰 = HMAC(SESSION_SECRET에서 유도한 키, 세션 토큰 해시)여야 한다(쿠키 주입으로 토큰을 바꿔치기 못 함). 로그인 전 토큰은 `GET /api/auth/csrf`가 무작위로 준다. 로그인 성공 때 세션 결합 토큰으로 바꾼다.
- 로그인 실패: 같은 메시지("이메일 또는 비밀번호가 올바르지 않습니다"), 없는 계정·비활성 계정도 더미 해시로 argon2 검증을 한 번 돌리고, 실패 응답은 최소 시간(기본 400ms)까지 채운다. 속도 제한: 계정(정규화 이메일)별 실패 5회/15분이면 잠금(429), IP별 시도 30회/15분. 계정 키는 존재 여부와 무관하게 같은 규칙이라 잠금 응답도 존재를 드러내지 않는다. 성공하면 계정 실패 횟수를 지운다.
- 가입: owner·buyer만(operator는 CLI). 약관 버전 동의(현재 버전과 같아야 함)를 기록. 이미 있는 이메일이어도 같은 202 응답·같은 시간(해시 1회)이고 자동 로그인하지 않는다. 한계: 이메일 확인이 없으므로 "가입 → 그 비밀번호로 로그인"으로 존재 여부를 알아낼 수 있다. 이메일 발송은 v0.1 범위 밖이라 수용한 위험으로 기록한다(REPORT, THREAT_MODEL WEB-07 비고). 운영자는 `auth.signup_enabled` 설정으로 가입을 닫을 수 있다.
- 대안: JWT(무상태). 버림: ADR 0012에서 이미 버림(폐기 어려움). 대안: 서명된 쿠키 세션. 버림: 서버 쪽 폐기·비활성화가 어렵다.

### D-d. 구매자 API 키
- 형식 `sp_test_<8자 base62>_<32자 base62>`(약 190비트 + 표시 id 48비트). 차수 문서의 `bj_`는 옛 이름(binjari)이라 ADR 0020에 따라 `sp_`로 바꾼다(가정). `PAYMENTS_MODE=live`는 시작 거부라 `sp_live_`는 아직 만들어지지 않는다.
- 저장: 표시용 prefix `sp_test_<8자>`(고유), `key_hash = HMAC-SHA256(pepper, 전체 키)`, `hash_key_id = API_KEY_PEPPER_ID`. 조회는 해시로 한 번(비밀 비교를 앱에서 하지 않으므로 타이밍 누출 없음). 생성 응답에만 전체 키가 있다.
- 스코프 `chat`, `batch`, `models:read`(기본 셋 다). `/v1/chat/completions`는 `chat` 필요.
- 키별 분당 한도(`rate_limit_rpm`, 없으면 설정 `api_keys.default_rpm` 기본 60)와 동시 요청 한도(설정 `api_keys.default_concurrency` 기본 4, 키마다 따로 셈). 초과는 429 + `Retry-After`. 키별 동시 한도 값을 키마다 다르게 두는 열은 만들지 않는다(마이그레이션 없이 설정으로 충분, 필요하면 S14).
- `last_used_at`은 1분에 한 번만 갱신. 비활성 사용자·폐기·만료 키는 401(이유를 구분하지 않음).
- 작업 행에 `api_key_id`를 기록한다(구매자는 자기 키·작업만).

### D-e. 권한: 문서 표가 원본, 코드 표와 동작을 테스트로 대조
- `docs/PERMISSIONS.md`에 동작(행) × 역할(operator, owner, buyer, anonymous) 표. 칸 값: `허용`, `자기 것`, `거부`. 각 행에 메서드·경로를 함께 적는다.
- 코드: `http/permissions.ts`의 같은 표(TS 상수). 라우트는 `defineRoute({ action, ... })`로만 등록하고, 인증·권한 검사는 그 래퍼가 표를 보고 한다(핸들러가 잊을 수 없음). `자기 것`은 핸들러가 소유권 조건을 쿼리에 넣는다(남의 것은 404 — 존재 여부도 숨김).
- 테스트: ① 문서 표를 파싱해 TS 표와 같은지 ② 등록된 모든 라우트 = 표의 행(라우트 자동 대조, THREAT_MODEL BUY-06·WEB-04) ③ 모든 행 × 모든 역할을 실제 HTTP로 실행: 허용 → 401/403 아님, 거부 → 익명 401·로그인 403, 자기 것 → 자기 자원 성공 + 남의 자원 404. 행마다 '탐침(probe)'이 없으면 테스트 실패.
- S05 라우트(최소한으로): 인증 5개, API 키 3개, 매장 조회 2개(사장님 자기 매장), 작업 조회 1개(구매자 자기 작업 메타데이터만), 운영자 설정 조회·변경·감사 조회·사용자 비활성화, 구매자 API 1개, 공개 3개(`/healthz`, `/readyz`, `/api/openapi.json`).
- 대안: 핸들러마다 `if (role !== ...)`. 버림: 빠뜨려도 아무도 모른다.

### D-f. 감사
- `audit/audit.ts`: `record(tx, { actor, action, target, data, ip })`. data는 메타데이터만(비밀번호·키·프롬프트 금지 — 키는 prefix만). IP는 HMAC(SESSION_SECRET 유도 키, ip) hex. 같은 트랜잭션에서 기록해 동작과 감사가 함께 커밋되거나 함께 취소된다.
- 대상 동작: 가입, 로그인 성공·실패(계정이 있을 때), 로그아웃, 키 생성·폐기, 설정 변경, 사용자 생성·비활성화·비밀번호 재설정(CLI), CLI의 모든 쓰기. 킬스위치·가격·정산 기록은 해당 차수가 같은 함수를 쓴다.
- CLI는 `actor_kind = 'system'`, data에 `via: 'cli'`와 OS 사용자 이름(누가 했는지).

### D-g. 멱등성 (`Idempotency-Key`)
- 모듈 `idempotency/`: (scope, key) 행을 `in_progress`로 선점 → 끝나면 `completed` + 응답 메타데이터. 같은 키 + 다른 본문(정규화 JSON의 SHA-256 비교) → 409 `idempotency_key_reused`, 같은 키 + 진행 중 → 409 `idempotency_in_progress`, 같은 키 + 같은 본문 + 완료 → 같은 응답 재생. 만료 24시간(T27과 같게), 청소는 주기 작업.
- 적용: 돈에 영향을 주는 POST는 지금 `/v1/chat/completions` 하나다. 응답 재생에는 출력이 필요한데 `idempotency_keys.response`에는 콘텐츠를 넣지 않는다(ADR 0010, 열 주석). 그래서 키가 있는 요청만 출력을 `job_payloads(kind=output)`에 AES-GCM으로 24시간 저장하고, 재생 때 작업 행 + 복호화한 출력으로 같은 본문을 다시 만든다. 키가 없으면 지금처럼 출력은 저장하지 않는다.
- 과금 없이 끝난 실패(용량 없음, 마감, 취소 등)는 선점을 지워 같은 키로 다시 시도할 수 있게 한다(과금이 없었으니 안전). 과금 여부를 모르는 실패(`result_undelivered`, `outcome_unknown`)는 완료로 남겨 재시도가 두 번 과금하지 않게 한다. 서버가 죽어 `in_progress`로 남은 행은 작업 마감 + 여유(11분)가 지나면 새 요청이 넘겨받는다(재시작 때 그 작업은 과금 없이 취소됨, S04).
- 대안: 메모리에 응답 보관. 버림: 프로세스가 콘텐츠를 오래 쥔다. 대안: S14로 미룸. 버림: 차수 문서 6절 요구사항이고 BUY-02의 담당이 S05.

### D-h. 속도 제한
- `RateLimiter` 인터페이스(`hit(key, rule)`, `peek`, `reset`)와 메모리 구현(고정 창, 주입된 Clock, 만료 키 청소 + 키 수 상한). 동시 요청 한도는 별도 `ConcurrencyLimiter`(메모리). 다중 인스턴스용 Postgres 저장은 선택 확장.

### D-i. OpenAPI·CLI
- OpenAPI 3.1은 `defineRoute`에 준 zod 스키마(params, query, body, response)에서 `z.toJSONSchema`(draft 2020-12)로 만든다. `/api/openapi.json`. 테스트는 공식 OAS 3.1 스키마(`@apidevtools/openapi-schemas`, MIT, devDependency)를 Ajv 2020으로 검증하고, 모든 라우트가 문서에 있는지 본다.
- CLI `pnpm --filter @spareon/server cli <명령>`: `user:create`, `user:disable`, `user:set-password`, `key:create`, `key:revoke`, `settings:get`, `settings:set`, `audit:tail`. 명령 함수는 의존성(db, clock, 출력, 비밀번호 입력)을 주입받아 테스트한다. 비밀번호는 `--password-stdin`으로 받거나, 없으면 무작위로 만들어 한 번만 출력한다. 서버와 같은 `.env`와 `spareon_app` 역할로 접속한다.

### D-j. 개발 세계와 SKELETON(S05) 교체
- `ensureSkeletonWorld`는 매장·가격 버전·운영자·사장님만 만든다(S08·S10 표시는 그대로). 개발용 구매자는 개발 전용 `ensureDevBuyer`가 **실제** 계정 함수(`createUser`)와 키 함수(`createApiKey`)로 만들고 테스트 충전을 한 번 기록한다. 개발 서버·데모·테스트 하네스는 그 키를 쓴다.
- 운영 진입점 `main.ts`는 이제 실제 서버를 띄운다(DB 역할 확인, 개발 세계 중 매장·가격 버전만 — 구매자·충전 없음).
- 서버 모듈 의존 방향(ARCHITECTURE 2.2)을 import 경계 테스트로 강제한다(ARCHITECTURE가 S05에 맡긴 일).

## 새 의존성
| 패키지 | 이유 | 라이선스 |
|---|---|---|
| `@node-rs/argon2` 2.2.1 | argon2id(Node 22에 내장 없음), 사전 빌드라 설치 스크립트 없음 | MIT |
| `pino` 10.4.0 | 로거 인스턴스·편집 경로를 직접 만들기 위해(Fastify가 이미 쓰는 같은 버전) | MIT |
| `@apidevtools/openapi-schemas` 2.1.0 (dev) | OAS 3.1 공식 JSON Schema로 생성 문서 검증 | MIT |
| `ajv` 8.20.0 (dev, 카탈로그에 이미 있음) | 위 검증 | MIT |

## 위험
- 인가 누락(IDOR): 래퍼 + 표 + 라우트 자동 대조 + 행 × 역할 테스트로 막는다.
- 로그 누출: 직렬화 최소화 + 편집 경로 + 에러 직렬화기 + 표식 문자열 테스트(정상·오류·500 경로).
- 메모리 속도 제한은 재시작하면 초기화된다(단일 인스턴스 단계 A에서 수용, 선택 확장에서 Postgres 저장).
- S04 테스트·데모 회귀: 하네스가 실제 키를 쓰게 바꾸고 각 체크포인트마다 S04 통합 테스트와 `pnpm demo`를 돌린다.

## 체크포인트
1. 설정·lib(errors, logger, crypto)·에러 처리기·requestId·`/readyz`·`.env.example` 생성기·`main.ts` — 검증: config 단위 테스트(안전 스위치, 값 비노출), env 예제 최신성, 에러 형식 테스트.
2. 감사·속도 제한·비밀번호·세션·CSRF·인증 라우트 — 검증: 인증 통합 테스트(틀린 비밀번호, 잠금, 고정 방지, 로그아웃, CSRF 거부, 타이밍 균일).
3. API 키 모듈·라우트·구매자 API 인증 교체·개발 구매자(실제 키)·SKELETON(S05) 제거 — 검증: 키 테스트, S04 통합 테스트 전체, `pnpm demo`.
4. 권한 표(`docs/PERMISSIONS.md`)·`defineRoute`·소유권 라우트(매장·작업)·운영자 라우트·표 생성 테스트·라우트 대조·import 경계 테스트.
5. 멱등성(채팅 완료 재생)·설정 레지스트리 — 검증: 같은 키 같은 본문 = 같은 응답, 다른 본문 409, 과금 1회.
6. OpenAPI·CLI — 검증: OAS 3.1 검증, CLI 테스트(감사 포함).
7. 로그 편집 종합 테스트·문서(ARCHITECTURE, ADR 0021, DEMO_0, THREAT_MODEL 비고)·게이트(verify, 적대적 검토 반영).
