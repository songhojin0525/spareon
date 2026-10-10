# S05 보고서 — 서버 기반: 설정·인증·권한·API 키·감사

- 상태: DONE
- 커밋 범위: `stage-S05-start..stage-S05-done`
- 시작 / 종료: 2026-10-10 15:00 / 2026-10-10 (완료 커밋 시각)

## 한 일 (5줄 이내, 사람이 30초 안에 읽을 수 있게)
1. zod 설정 검증과 안전 스위치를 넣었다. `PAYMENTS_MODE=live`, `CASHOUT_ENABLED=true`, mock이 아닌 `EXTERNAL_PROVIDERS`, 운영의 개발 설정, 없어진 `DEV_API_KEY`는 모두 시작을 거부한다. 오류에는 변수 이름만 나오고 값은 나오지 않는다. `.env.example`은 스키마에서 생성한다. 로그는 헤더·본문을 남기지 않고 편집 경로를 걸었다. 에러는 `AppError` 한 형식이고, 요청 ID는 서버가 UUIDv7로 만든다. `/readyz`를 추가했다.
2. 사람 로그인을 만들었다: argon2id(OWASP 최소값), 서버 저장 세션(유휴 7일·절대 30일), 세션에 묶인 이중 제출 CSRF + Origin 검사. 고정 공격 방지, 계정별·IP별 시도 제한, 실패 응답 400ms 균일화, 존재를 드러내지 않는 가입을 넣었다.
3. 구매자 API 키 `sp_test_…`를 만들었다. DB에는 HMAC만 남고 키는 한 번만 보여 준다. 스코프와 키별·구매자별 분당·동시 한도가 있다. S04의 개발용 키 하나·구매자 한 명(`SKELETON(S05)` 4곳)을 실제 계정·키로 바꿨다.
4. `docs/PERMISSIONS.md` 표(19행 × 4역할)가 HTTP 테스트를 만든다. 남의 자원은 404이고, 라우트와 표를 자동으로 대조한다. import 경계 테스트(ARCHITECTURE 2.2), 감사 기록, 채팅 `Idempotency-Key`(재생·409·과금 1회), OpenAPI 3.1, 운영자 CLI도 넣었다.
5. 적대적 검토를 2회 받았다(1차 높음 1·중간 5·낮음 10, 2차 중간 2·낮음 8). 높음·중간은 모두 고쳤다.

## 실행하는 법 (복사해서 바로 쓰는 명령)
```
pnpm verify
pnpm demo                                            # 10/10 완료, 원장 합 0 (개발용 구매자는 실제 계정·키)
pnpm dev:server                                      # 켤 때마다 새 sp_test_ 키를 보여 준다
pnpm --filter @spareon/server env:example            # .env.example 다시 만들기
pnpm --filter @spareon/server cli user:create --role operator --email me@example.com
pnpm --filter @spareon/server cli key:create --user buyer@example.com --scopes chat
pnpm --filter @spareon/server cli settings:get
pnpm --filter @spareon/server cli audit:tail --limit 20
cd apps/server && npx vitest run test/auth test/cli src/config.test.ts src/app.test.ts src/architecture.test.ts
```

## 수용 기준 결과
| # | 기준 | 실행한 명령 | 결과 |
|---|---|---|---|
| 1 | `pnpm verify` 통과 | `pnpm verify` (2026-10-10, 4eaad14 내용 기준, 6c498bf 직전. 지휘자가 6c498bf에서 다시 실행) | PASS 9/9: format·docs·lint·typecheck·test(server 337, protocol 539, repo-checks 172, testkit 39, shared 17, web 2)·gofmt·vet·go test·Windows 교차 빌드 |
| 2 | 권한 표 기반 테스트 전부 통과(모든 행 × 모든 역할) | `npx vitest run test/auth/permissions.int.test.ts` | 81 통과. 내용: 문서 표 = 코드 표, '표 밖 경로' 일치, 탐침이 모든 행에 있음, 19행 × 4역할 실행(허용 2xx·거부 401/403·자기 것은 자기 자원 2xx와 남의 자원 404, 목록은 자기 것만), 등록 라우트 ↔ 표 자동 대조. 매장 소유권 조건을 지운 변이에서 실패를 확인했고, 9회 연속 통과 |
| 3 | 인증: 틀린 비밀번호, 잠금·속도 제한, 세션 고정 방지, 로그아웃 후 세션 무효, CSRF 거부 | `npx vitest run test/auth/auth.int.test.ts test/auth/sessions.int.test.ts` | 통과. 틀린 비밀번호 = 없는 이메일(같은 코드·문구). 계정 잠금(5회/15분)은 없는 이메일에도 똑같고 창이 지나면 풀린다. 병렬 12회 시도에도 401은 5회 이하. IP별 30회 한도를 넘긴 IP는 계정 카운터를 건드리지 않는다. 가입은 IP당 10회/시간. 재로그인하면 토큰이 바뀌고 옛 토큰·심은 쿠키는 401. 로그아웃 뒤 옛 쿠키 401과 감사 기록. CSRF는 Origin 없음·다른 출처·`null`·토큰 없음·불일치·세션에 묶이지 않은 쌍을 403으로 거부하고 Referer 대체는 허용. 실패 4종 응답이 모두 바닥 시간 이상이고 차이 250ms 미만. 유휴 7일·절대 30일·`last_seen_at` 1분 쓰로틀 |
| 4 | 로그 편집: 프롬프트·키가 포함된 요청을 보낸 뒤 캡처한 로그에 그 문자열이 0번 | `npx vitest run test/auth/log-redaction.int.test.ts src/app.test.ts src/lib/security-units.test.ts` | 통과. 서버 전체를 trace 레벨로 캡처했다. 표식 프롬프트·stop·출력·API 키(Authorization, x-api-key)·비밀번호·세션·CSRF 토큰·새 키가 정상·오류(깨진 JSON, 잘못된 필드, 없는 모델, 틀린 키, 실패 로그인, 거부된 가입) 경로 모두에서 0회. 500 경로는 app.test가 표식을 담은 예외로 확인(메시지는 로그에 남기지 않음) |
| 5 | 안전 스위치: `CASHOUT_ENABLED=true` 또는 `PAYMENTS_MODE=live`면 시작 실패 | `npx vitest run src/config.test.ts` | 통과(26). live는 개발·운영 모두 거부. CASHOUT `true`·`1`은 "legal review" 문구로 거부, `yes`는 형식 오류. EXTERNAL_PROVIDERS anthropic 거부. 운영의 DEV_* 거부. https 강제. 오류 문구에 값이 나오지 않음. `main.ts`는 ConfigError면 항목을 출력하고 exit 1 |
| 6 | OpenAPI 문서 유효성 검사 통과, CLI 테스트 통과 | `npx vitest run test/auth/openapi-ops.int.test.ts test/cli/cli.int.test.ts` | 통과. `/api/openapi.json`이 공식 OAS 3.1 스키마(@apidevtools/openapi-schemas)를 Ajv 2020으로 통과하고, 깨진 문서는 거부됨을 확인했다. 포함된 스키마 전부가 JSON Schema 2020-12 메타 검증 통과. `/healthz`를 뺀 모든 표 행이 문서에 있다. CLI 8개 시나리오 모두 감사 기록과 함께 통과했고, 실제 프로세스(`pnpm cli`)로도 1회 확인 |

추가로 확인한 것:
- `pnpm demo`: 10/10 완료, 원장 합 CR 0·KRW 0(검토 반영 뒤에도 같음).
- S04 통합 테스트(test/skeleton) 전부 통과. 하네스가 실제 계정·키를 쓴다.
- 멱등성(12): 같은 키 + 같은 본문은 같은 응답(키 순서 무관, 캡처 1회), 다른 본문은 409, 진행 중은 409, 과금 없는 실패는 키를 비운다, 출력 보존이 끝나면 410. 장애 주입: 과금 뒤 기록이 빠진 claim은 다시 실행하지 않고 500 `result_undelivered`로 답한다. 과금 없이 끝난 작업의 claim은 바로 다시 실행한다. 넘겨받힌 claim의 옛 주인은 complete·release·attach를 못 한다.
- 종료: 멈춘 요청이 있어도 drain 시간 뒤 `close()`가 끝난다. drain이 길면 3초 안에 끝나지 않음을 대조 테스트로 확인했다.

## 적대적 검토 결과
### 1차 (521e2c4..e464d4c, 높음 1·중간 5·낮음 10) — 반영 커밋 af62c0c
| 심각도 | 지적 | 조치(고침 / 안 고친 이유) |
|---|---|---|
| 높음 | permissions 테스트 afterAll의 `h.close()`가 가끔 끝나지 않아 verify가 운에 달림(9회 중 3회) | 고침. 계측해 보니 `server.app.close()`에서 멈췄다. 테스트 브라우저가 응답 본문을 읽지 않는 것이 원인이었다(추정). Browser가 본문을 다 읽게 바꾼 뒤 9회 연속 통과했고 close는 약 10ms. 서버에도 백스톱을 넣었다: preClose 뒤 drain 시간(기본 30초 = T32)이 지나면 남은 연결을 끊는다. 대조 테스트 포함 |
| 중간 | 과금 뒤 `complete()` 실패나 종료 시 claim이 `in_progress`로 남아, 11분 뒤 다시 실행되어 이중 과금 | 고침. claim이 작업 생성 트랜잭션 안에서 jobId를 기록한다(`submit({onCreate})` → `attach`). 끝나지 않은 claim은 작업 상태로 판정한다(열림 409 / 과금 없이 끝남은 재실행 / 완료인데 기록 없음은 오래된 경우 `result_undelivered`로 확정하고 재실행 안 함). 작업 없이 끝난 실패만 키를 비운다 |
| 중간 | complete·release가 claim 주인을 구분하지 않음 | 고침. claim 토큰(claim 시각)을 WHERE에 넣었다. 테스트 포함 |
| 중간 | 계정 잠금을 argon2 전에 peek로 보고 hit는 뒤에 해서 병렬 요청이 모두 통과 | 고침. 확인 전에 hit, 성공하면 reset. 병렬 12회 테스트 |
| 중간 | 구매자가 키 rpm을 10,000까지 정하고 구매자 단위 합계가 없음 | 고침. 구매자는 `api_keys.default_rpm` 이하로만 정할 수 있다(400 `rpm_above_default`). 구매자별 합계 설정 `buyers.rpm`(120)·`buyers.concurrency`(8)를 추가했다 |
| 중간 | IP별 로그인·가입 한도 테스트 없음 | 고침. 테스트 추가 |
| 낮음 | `staleAfterMs`가 스케줄러 설정과 무관한 상수 | 고침. 조립 루트가 마감 + 대기 여유 + 1분으로 계산하고, 더 작으면 시작 거부 |
| 낮음 | 운영에서 TRUST_PROXY가 없으면 IP 한도가 전역이 됨 | 일부 고침. 운영에서 없으면 경고 로그를 남기고 HUMAN_TODO(S30)에 적었다. 거부는 하지 않는다: 프록시 없이 직접 띄우는 배포도 정상이다 |
| 낮음 | 키가 꽉 차면 `#evict`가 요청마다 전체를 훑음 | 고침. 한 번에 10%를 지운다 |
| 낮음 | 솔트 없는 SHA-256 요청 해시 | 고침. SESSION_SECRET에서 유도한 키로 HMAC |
| 낮음 | 500 경로가 예외 메시지를 로그에 남김 | 고침. DB 오류(SQLSTATE 요약)만 메시지를 남기고, 나머지는 유형·코드·스택만. app.test가 표식으로 확인 |
| 낮음 | 테스트가 `setTimeout(300)`에 기댐 | 고침. claim 행(jobId)·작업 행이 생길 때까지 `waitFor` |
| 낮음 | 개발 하네스의 설정 변경이 감사되지 않음 | 고침. 바뀔 때 `settings.set`(system, dev-stack) 기록 |
| 낮음 | 동시 한도로 거절돼도 분당 예산을 씀 | 고침. 동시 한도를 먼저 보고, 분당 한도에 걸리면 슬롯을 돌려준다 |
| 낮음 | 있는 계정의 실패 경로만 감사 INSERT 뒤에 대기 시간을 채움 | 고침. 바닥 시간을 채운 뒤 감사를 비동기로 기록(실패는 로그) |
| 낮음 | 설정 목록이 저장값을 보여 주지만 실제로는 기본값이 쓰임 | 고침. 실제 적용값과 `invalidStored`를 함께 보여 준다(웹·CLI) |

### 2차 (af62c0c, 높음 0·중간 2·낮음 8) — 반영 커밋 4eaad14
| 심각도 | 지적 | 조치(고침 / 안 고친 이유) |
|---|---|---|
| 중간 | 차단된 IP도 계정 카운터를 올림(모든 계정을 무한히 잠금, limiter 키 범람) | 고침. IP가 거절되면 계정 키를 건드리지 않는다. 테스트로 카운터 0 확인 |
| 중간 | 해석기가 FOR UPDATE를 쥔 채 풀에서 두 번째 연결을 빌림(동시 재시도 시 풀 고갈) | 고침. 해석기가 claim 트랜잭션의 `tx`로 조회한다 |
| 낮음 | `attach()`가 false여도 작업이 커밋됨 | 고침. false면 예외로 작업·홀드 트랜잭션 전체를 롤백하고 409. 넘겨받힌 뒤 attach가 false인지 테스트 |
| 낮음 | claim 토큰이 ms 시각이라 같은 ms 넘겨받기에서 같아질 수 있음 | 안 고침. 넘겨받기는 claim이 11.5분 넘게 오래됐거나 그 작업이 과금 없이 끝났을 때만 일어나서, 같은 ms 충돌은 시계가 뒤로 갈 때만 가능하다. 무작위 토큰 열은 마이그레이션이 필요해 S12(지속 결과)에서 재검토 |
| 낮음 | drain 기본 10초 ≠ T32 30초, drain으로 끊긴 요청의 cancel이 풀 종료와 경합 | 일부 고침. 기본값 30초. cancel 경합은 안 고침: 이중 과금은 없고 남은 작업·홀드는 다음 시작의 재시작 복구(S04)가 과금 없이 정리한다. 지속 결과·드레인은 S11·S12 범위 |
| 낮음 | 요청 해시 키가 SESSION_SECRET에 묶임(교체하면 24시간 키가 409) | 문서화. `.env.example`의 SESSION_SECRET 설명에 적었다. 별도 비밀은 운영 비밀 회전 절차(S29·S30)에서 재검토 |
| 낮음 | 키 rpm 상한은 생성 때만 검사, CLI로 올려도 `buyers.rpm`이 상한 | 문서화. ARCHITECTURE 10절에 "실제 한도는 둘 중 작은 쪽, 구매자별 예외 없음"을 적었다. 배포 전이라 기존 키 정리 마이그레이션은 필요 없다 |
| 낮음 | 구매자별 동시 한도·슬롯 반환 테스트 없음 | 고침. `buyers.concurrency=1`에서 키 2개, rate_limited 3회 뒤 슬롯이 남아 있는지 테스트 |
| 낮음 | IP 한도 테스트가 앞 테스트의 예산 사용에 결합 | 고침. 자기 하네스·limiter로 독립 |
| 낮음 | people.ts 주석과 PLAN의 SHA-256·11분 문구 | 주석 고침. PLAN과의 차이는 아래에 적었다 |

2차 반영분(4eaad14)은 3차 검토를 받지 않았다. 고친 곳마다 테스트를 붙였고 `pnpm verify` PASS와 `pnpm demo` 10/10을 다시 확인했다.

## PLAN과의 차이
- D-g: PLAN은 "같은 키 + 진행 중이면 11분 뒤 넘겨받기"였다. 검토 뒤에는 claim이 작업 ID를 기록하고 작업 상태로 판정한다. 기준 시간은 스케줄러 설정에서 계산한다(현재 11분 30초). 요청 해시는 SHA-256이 아니라 서버 키 HMAC이다.
- D-d·D-h: 구매자별 합계 한도(`buyers.rpm`, `buyers.concurrency`)를 추가했다. 구매자가 정하는 키 rpm은 기본값 이하로 제한된다.
- D-c: 계정 잠금은 "실패 5회"가 아니라 "시도 5회(성공하면 초기화)"로 바꿨다(병렬 우회 방지). 거절된 IP는 계정 카운터를 건드리지 않는다.
- D-b: 500 로그는 DB 오류 요약만 메시지로 남긴다. 종료는 drain 30초 뒤 연결을 강제로 끊는다.
- 라우트: PLAN의 `ops.settings.get`은 목록 하나(`GET /api/ops/settings`)로 합쳤다.
- 개발 서버·하네스는 개발 DB의 동시·구매자 한도 설정을 올린다(데모·스케줄링 테스트의 버스트용, 감사 기록).

## 교체 목록 (SKELETON)
| 파일 | 대체 차수 | 단순화한 것 |
|---|---|---|
| `apps/server/src/retention/payloads.ts` | S12 | 멱등 재생용 출력 저장만 하는 보존 모듈(키 회전, `x-spareon-retention: none` 없음) |

S04의 `SKELETON(S05)` 4곳(app.ts, buyer-api/chat-completions.ts, config.ts, skeleton/bootstrap.ts)은 없어졌다. 표시는 45개에서 42개가 됐다(S05 −4, S12 +1). chat-completions.ts의 `SKELETON(S14)`는 "SSE 없음, 사용량은 노드 보고값"으로 줄었다.

## 가정 (사람이 나중에 확인할 것)
| 가정 | 근거 | 틀리면 바꿀 곳 |
|---|---|---|
| API 키 접두사는 차수 문서의 `bj_test_`가 아니라 `sp_test_` | ADR 0020 이름 변경, 배포 전 | api-keys.ts, ADR 0021 |
| argon2id m=19 MiB·t=2·p=1 | OWASP Password Storage Cheat Sheet 최소 권장(2026-10-10 웹 확인) | auth/password.ts |
| 가입은 있는 이메일에도 같은 응답이지만, 이메일 확인이 없어 '가입 → 그 비밀번호로 로그인'으로 존재 확인 가능(수용한 잔여 위험) | 이메일 발송은 v0.1 범위 밖. 운영자가 `auth.signup_enabled`로 가입을 닫을 수 있음 | 이메일 도입 차수, THREAT_MODEL WEB-07 |
| 속도 제한·로그인 잠금은 메모리 저장(재시작하면 초기화, 인스턴스 간 공유 없음) | 단계 A 단일 인스턴스(ADR 0002), 인터페이스 분리 | lib/rate-limit.ts(Postgres 저장은 선택 확장) |
| 키별 동시 한도는 키마다 다른 열이 아니라 전역 설정(기본 4), 구매자 합계 8 | 마이그레이션 없이 충분 | S14 |
| 멱등 재생용 출력은 `Idempotency-Key`가 있을 때만 24시간 AES-GCM으로 저장 | ADR 0010 보존 기한 안, 키 없으면 출력 미저장 | retention(S12) |
| 개발 서버는 켤 때마다 개발용 구매자의 새 키를 만들고 이전 개발 키를 폐기 | DB에는 해시만 있어 이전 키를 다시 보여 줄 수 없음 | skeleton/dev-buyer.ts, DEMO_0 |
| 500 응답의 원래 예외 메시지는 로그에 남기지 않는다(DB 오류 요약만) | 절대 규칙 4. 디버깅은 유형·코드·스택으로 | lib/logger.ts |
| 종료 drain 30초 뒤 남은 연결을 강제로 끊는다 | T32, 종료가 영원히 걸리지 않게 | app.ts, S11 드레인 |
| 멱등 요청 해시 키는 SESSION_SECRET에서 유도(교체하면 24시간 동안 같은 키가 409) | 비밀 하나 줄임. .env.example에 명시 | S29·S30 비밀 회전 |

## 사람이 확인할 것 (HUMAN_TODO에도 추가함)
- (S30, 운영 서버를 처음 켤 때) 운영자 계정은 CLI `user:create --role operator`로만 만든다. HUMAN_TODO "S05에서 추가"에 절차가 있다.
- (S30, 배포 설정 때) 웹 프록시 뒤라면 `TRUST_PROXY`를 설정한다. 없으면 IP별 로그인 한도가 모든 사용자에게 공유되고 감사 IP 해시가 쓸모없어진다.
- 실기 확인이 필요한 것은 없다(사람 필요: 없음).

## 막힌 것
| 증상 | 시도한 것 | 추정 원인 | 사람이 확인할 것 |
|---|---|---|---|
| 없음 | | | |

참고: Ajv가 OAS 3.1 스키마의 `$dynamicRef`와 `unevaluatedProperties`를 함께 처리하지 못해 오검출이 났다. 그래서 테스트는 `$dynamicRef: "#meta"`를 같은 뜻의 `$ref`로 바꿔 문서를 검증하고, 포함된 스키마는 2020-12 메타 스키마로 따로 검증한다.

## 다음 차수에 미치는 영향
- 새 라우트는 `Router.add({ action })`로만 등록하고 `docs/PERMISSIONS.md`·`http/permissions.ts`에 행을, permissions 테스트에 탐침을 더해야 한다(없으면 테스트 실패).
- S06: 원장 서비스는 `audit/recordAudit`을 쓰고, 돈에 영향을 주는 새 POST는 `lib/idempotency`(토큰·attach·해석기)를 쓴다. `TEST_TOPUP` CLI(OPS-01)는 S06에서 추가한다.
- S08: 가격·정책 변경은 설정 레지스트리(`lib/settings.ts`)나 별도 표 + 감사로 한다.
- S10·S24: 사장님 화면 API는 `자기 것` 패턴(쿼리에 owner 조건, 남의 것 404)을 따른다.
- S12·S14: 멱등 claim의 작업 기록·해석기는 지속 결과가 생기면 완료 재생을 출력 없이 복원하도록 확장할 수 있다. 무작위 claim 토큰 열은 S12에서 재검토한다.
- S23: 웹은 `GET /api/auth/csrf` → `x-csrf-token` 헤더, 쿠키는 https면 `__Host-`. 약관 버전 상수는 `CURRENT_TERMS_VERSION = '2026-10-draft'`.
- S28: 운영자 TOTP(선택 확장 안 함), 메모리 limiter의 다중 인스턴스 한계.

## 수치
- TS 테스트: server 337(S04 145 → +192, 그중 권한 표 81), protocol 539, repo-checks 172, testkit 39, shared 17, web 2. Go 6개 패키지 통과.
- 권한 표 19행 × 4역할 = 76칸 실행, permissions 테스트 9회 연속 통과(수정 전 약 1/3 실패).
- argon2id 해시 1회 약 30ms(개발 PC). 로그인 실패 응답 바닥 400ms(설정 가능).
- SKELETON 표시 42개(S06 3·S08 3·S09 3·S10 4·S11 6·S12 9·S14 1·S17 5·S18 1·S19 4·S20 1·S21 1·S23 1).

## 선택 확장 결과
하지 않았다(운영자 TOTP, Postgres 속도 제한 저장). 게이트까지의 여력은 적대적 검토 2회 반영에 썼다.
