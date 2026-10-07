# S05 · 서버 기반: 설정·인증·권한·API 키·감사

| 항목 | 값 |
|---|---|
| 의존 | S04 |
| 권장 모델 | Sonnet 5.5 (보안 부분이 걱정되면 Opus) |
| 규모 | L |
| 사람 필요 | 없음 |

이 차수는 `prompts/_PROTOCOL.md`를 따른다.

## 목표
S04 뼈대의 서버를 운영 가능한 기반으로 바꾼다: 검증된 설정, 안전한 로깅, 일관된 에러, 사람 인증(세션), 구매자 API 키, 역할별 권한, 감사 기록, 멱등성, 속도 제한, OpenAPI, 운영자 CLI. 이후 모든 서버 차수가 이 위에 기능을 얹는다.

## 먼저 읽을 것
- `docs/ARCHITECTURE.md`(서버 모듈), `docs/THREAT_MODEL.md`(인증·인가 행), ADR 0010·0012, `docs/stages/S04/REPORT.md`의 교체 목록

## 산출물
- `apps/server/src/config.ts` — zod 환경변수 스키마(시작 시 검증 실패면 즉시 종료, 무엇이 잘못됐는지 출력). `.env.example` 자동 생성 스크립트.
- `apps/server/src/lib/{clock,ids,errors,logger,crypto}.ts`
- 인증·세션, API 키, 권한, 감사, 멱등성, 속도 제한 모듈
- `docs/PERMISSIONS.md` — 역할 × 동작 권한 표(이 표에서 테스트를 생성한다)
- `/api/openapi.json`, 운영자 CLI(`pnpm --filter @binjari/server cli <명령>`)
- `/healthz`(살아 있음), `/readyz`(DB 연결 확인)

## 상세 요구사항

### 1. 설정
- 필수: `DATABASE_URL`, `SESSION_SECRET`, `API_KEY_PEPPER`, `DATA_ENCRYPTION_KEY`(+ `DATA_ENCRYPTION_KEY_ID`), `PUBLIC_BASE_URL`, `WEB_ORIGIN`.
- 안전 스위치: `PAYMENTS_MODE`(test만 허용 — live면 시작 거부), `CASHOUT_ENABLED`(true면 시작 거부, "법률 검토 전 출금 기능 없음" 메시지), `EXTERNAL_PROVIDERS`(기본 mock).
- 개발 편의값(`DEV_AGENT_SECRET`, `DEV_DASHBOARD`)은 `NODE_ENV=production`에서 설정되어 있으면 시작 거부.

### 2. 로깅과 에러
- pino 구조화 로그, 요청마다 requestId. **편집(redaction) 경로**: authorization, cookie, set-cookie, x-api-key, 요청 본문의 messages·prompt·input, 응답 본문의 choices·output. 프롬프트는 어떤 레벨에서도 로그에 남지 않는다.
- 에러는 `AppError(code, httpStatus, publicMessage, details?)`. 응답 형식 `{ "error": { "code", "message", "requestId" } }`. 예상 못 한 에러는 내부 내용을 숨기고 500.

### 3. 사람 인증(세션)
- 이메일 + 비밀번호(argon2id, 파라미터는 OWASP 권장 수준을 근거와 함께 기록). 이메일 대소문자 무시.
- 세션: httpOnly, Secure(운영), SameSite=Lax 쿠키, 로그인 시 세션 ID 교체(고정 공격 방지), 유휴 7일 / 절대 30일(설정 가능), 로그아웃 시 폐기.
- CSRF: 상태를 바꾸는 요청은 Origin/Referer가 `WEB_ORIGIN`과 같아야 하고, 추가로 이중 제출 토큰.
- 로그인 실패 속도 제한(계정별·IP별), 실패 응답 시간 균일화, 계정 존재 여부를 드러내지 않는 메시지.
- 회원가입: owner 또는 buyer 역할 선택, 약관 버전 동의 기록(약관 문구는 S23에서 '초안'으로). operator는 CLI로만 만든다.

### 4. 구매자 API 키
- 형식 `bj_test_<랜덤>`(PAYMENTS_MODE=test에서), 표시용 prefix 저장, 비밀 부분은 `HMAC-SHA256(pepper, key)`로 저장, 생성 직후 한 번만 보여 준다.
- 스코프(chat, batch, models:read 등), 키별 분당 속도 제한·동시 요청 제한, last_used_at, 폐기.
- S04의 개발용 단일 키를 제거하고 실제 키로 바꾼다(테스트 픽스처 포함).

### 5. 권한
- `docs/PERMISSIONS.md` 표: 역할(operator, owner, buyer, anonymous) × 동작. 소유권 검사(사장님은 자기 매장만, 구매자는 자기 키·작업만)를 명시.
- 이 표에서 권한 테스트를 생성한다(표와 코드가 어긋나면 테스트 실패).

### 6. 감사·멱등성·속도 제한
- 감사: 로그인, 키 생성·폐기, 설정 변경, 가격·정책 변경, 킬스위치, 수동 정산 기록 등 민감 동작은 `audit_log`에 남긴다(누가, 무엇을, 대상, 요약 데이터, IP 해시).
- 멱등성: 돈에 영향을 주는 POST는 `Idempotency-Key` 헤더를 지원한다. 같은 키 + 같은 본문 → 같은 응답, 같은 키 + 다른 본문 → 409.
- 속도 제한: 단일 인스턴스는 메모리 저장으로 시작하되 인터페이스로 분리(나중에 Postgres·Redis로 교체 가능).

### 7. OpenAPI와 CLI
- zod 스키마에서 OpenAPI 3.1 생성(`/api/openapi.json`), 생성 결과가 유효한지 테스트.
- CLI: `user:create --role operator --email ...`, `user:disable`, `key:create --user ...`, `settings:get/set`, `audit:tail`. 모든 CLI 동작도 감사 기록.

## 하지 말 것
- 원장·가격 로직(S06, S08), 노드 등록(S10)
- 소셜 로그인, 이메일 발송(v0.1 범위 밖 — 비밀번호 재설정은 CLI로)

## 수용 기준
1. `pnpm verify` 통과
2. 권한 표 기반 테스트 전부 통과(모든 행 × 모든 역할)
3. 인증 테스트: 틀린 비밀번호, 잠금·속도 제한, 세션 고정 방지, 로그아웃 후 세션 무효, CSRF 거부
4. 로그 편집 테스트: 프롬프트·키가 포함된 요청을 보낸 뒤 캡처한 로그에 그 문자열이 0번 등장
5. 안전 스위치 테스트: `CASHOUT_ENABLED=true` 또는 `PAYMENTS_MODE=live`면 시작 실패
6. OpenAPI 문서 유효성 검사 통과, CLI 테스트 통과

## 적대적 검토 포인트
- 인가 누락(IDOR): 다른 사장님 매장, 다른 구매자 작업 접근
- 타이밍 공격, 사용자 열거, 세션·CSRF 우회
- 로그·에러 응답으로 새는 비밀값

## 선택 확장
- 운영자 계정 TOTP 2단계 인증
- 속도 제한 Postgres 저장 구현(다중 인스턴스 대비)
