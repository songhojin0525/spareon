# 권한 표 (PERMISSIONS)

> 역할 × 동작 권한의 원본이다. 서버 코드의 같은 표(`apps/server/src/http/permissions.ts`)와 다르면 테스트가 실패한다(`apps/server/test/auth/permissions.int.test.ts`). 그 테스트는 이 문서의 표를 읽어서 **모든 행 × 모든 역할**을 실제 HTTP 요청으로 실행하고, 서버에 등록된 라우트가 모두 이 표(또는 아래 '표 밖 경로')에 있는지도 확인한다. S05에서 만들었다. 새 라우트를 더하는 차수는 이 표에 행을 먼저 더한다.

## 칸의 뜻
- **허용**: 그 역할은 라우트가 가리키는 대상 누구의 것이든 이 동작을 할 수 있다.
- **자기 것**: 자기 자원에만 할 수 있다. 소유권 조건은 쿼리 자체에 들어간다. 남의 자원은 '없음'(404)과 구별되지 않는다(존재 여부를 드러내지 않음). 목록은 자기 것만 나온다.
- **거부**: 익명은 401, 로그인한 역할은 403. API 키 라우트에서는 키가 없거나 틀리면 모두 401(`invalid_api_key`)이다.

인증 열:
- **세션**: 웹 로그인 쿠키. 상태를 바꾸는 요청(POST·PUT·DELETE)은 Origin(없으면 Referer) = `WEB_ORIGIN`이고 `x-csrf-token` = CSRF 쿠키 = 세션에 묶인 토큰이어야 한다.
- **API 키**: `Authorization: Bearer sp_test_…`. 쿠키를 받지 않는다(CSRF 대상 아님). 라우트가 요구하는 스코프가 없으면 403 `insufficient_scope`.
- **공개**: 로그인 없이 부를 수 있다. 상태를 바꾸는 공개 요청(가입·로그인)도 같은 CSRF 검사를 받는다(로그인 전 토큰은 `GET /api/auth/csrf`).

역할: operator(운영자, CLI로만 만든다), owner(사장님), buyer(구매자), anonymous(로그인 안 함).

## 표

| 동작 | 메서드 | 경로 | 인증 | operator | owner | buyer | anonymous | 소유권·비고 |
|---|---|---|---|---|---|---|---|---|
| health.live | GET | /healthz | 공개 | 허용 | 허용 | 허용 | 허용 | 프로세스가 살아 있음 |
| health.ready | GET | /readyz | 공개 | 허용 | 허용 | 허용 | 허용 | DB가 응답함(아니면 503) |
| docs.openapi | GET | /api/openapi.json | 공개 | 허용 | 허용 | 허용 | 허용 | OpenAPI 3.1 문서 |
| auth.csrf | GET | /api/auth/csrf | 공개 | 허용 | 허용 | 허용 | 허용 | 로그인 상태면 세션에 묶인 토큰 |
| auth.signup | POST | /api/auth/signup | 공개 | 거부 | 거부 | 거부 | 허용 | owner·buyer만 가입. 있는 이메일도 같은 응답 |
| auth.login | POST | /api/auth/login | 공개 | 허용 | 허용 | 허용 | 허용 | 새 세션 발급, 들고 온 세션은 폐기 |
| auth.logout | POST | /api/auth/logout | 세션 | 허용 | 허용 | 허용 | 거부 | 자기 세션만 끝난다 |
| auth.session | GET | /api/auth/session | 세션 | 허용 | 허용 | 허용 | 거부 | 자기 계정 정보 |
| api_keys.list | GET | /api/api-keys | 세션 | 거부 | 거부 | 자기 것 | 거부 | 자기 키의 prefix·메타데이터만(키 자체는 없음) |
| api_keys.create | POST | /api/api-keys | 세션 | 거부 | 거부 | 허용 | 거부 | 언제나 자기 계정의 키를 만든다. 키는 이 응답에만 |
| api_keys.revoke | DELETE | /api/api-keys/:keyId | 세션 | 허용 | 거부 | 자기 것 | 거부 | 운영자는 사고 대응으로 누구의 키든 폐기 |
| stores.list | GET | /api/stores | 세션 | 허용 | 자기 것 | 거부 | 거부 | 사장님은 자기 매장만 |
| stores.get | GET | /api/stores/:storeId | 세션 | 허용 | 자기 것 | 거부 | 거부 | 남의 매장은 404 |
| jobs.get | GET | /api/jobs/:jobId | 세션 | 허용 | 거부 | 자기 것 | 거부 | 메타데이터만(프롬프트·출력 없음). 남의 작업은 404 |
| ops.settings.list | GET | /api/ops/settings | 세션 | 허용 | 거부 | 거부 | 거부 | 운영 설정과 현재 값 |
| ops.settings.set | PUT | /api/ops/settings/:key | 세션 | 허용 | 거부 | 거부 | 거부 | 등록된 키만, 스키마 검증, 감사 기록 |
| ops.audit.list | GET | /api/ops/audit | 세션 | 허용 | 거부 | 거부 | 거부 | 감사 기록 조회 |
| ops.users.disable | POST | /api/ops/users/:userId/disable | 세션 | 허용 | 거부 | 거부 | 거부 | 세션 폐기, API 키 무효. 자기 자신은 불가 |
| buyer.chat_completions | POST | /v1/chat/completions | API 키 | 거부 | 거부 | 허용 | 거부 | 스코프 `chat`. 자기 지갑에서만 과금, 작업은 키의 주인 것 |

## 표 밖 경로
사람·구매자의 동작이 아니라서 위 표에 넣지 않는 경로다. 테스트는 이 목록에 없는 라우트가 표 밖에 있으면 실패한다.

| 경로 | 이유 |
|---|---|
| /agent/v1/ws | 에이전트는 프로토콜 챌린지(서명)로 인증한다(S02, S11). 사람 역할이 아니다 |
| /dev | 개발용 대시보드. `NODE_ENV=development` 또는 `DEV_DASHBOARD=1`일 때만 등록되고 메타데이터만 보인다. 운영에서는 시작 거부 |

## 감사 기록되는 동작
`auth.signup`, `auth.signup_duplicate`, `auth.login`, `auth.login_failed`(계정이 있을 때), `auth.logout`, `api_key.create`, `api_key.revoke`, `settings.set`, `user.disable`, 그리고 CLI의 모든 쓰기(`user.create`, `user.disable`, `user.set_password`, `api_key.create`, `api_key.revoke`, `settings.set`, `actor_kind = system`, `data.via = cli`). 기록에는 메타데이터만 들어간다(비밀번호·키·프롬프트 없음, 키는 prefix만, IP는 HMAC).
