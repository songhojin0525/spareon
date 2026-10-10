# S00 계획 — 환경·저장소·CI 부트스트랩

## 목표 요약
어떤 개발 환경에서도 `pnpm install && pnpm verify` 한 줄로 포맷·린트·타입·테스트·Go 검증이 도는 빈 모노레포와 CI를 만든다. 이후 모든 차수의 수용 기준이 이 게이트 위에서 판정되므로 "실패를 삼키지 않는 것"이 최우선 설계 목표다.

## 감지한 환경 (상세는 `docs/ENVIRONMENT.md`)
Windows 11 / Node 22.18.0 / corepack 0.33.0 / pnpm 11.28.2(전역) / Go 1.27.0 / git 2.55 / Docker·psql 없음 / 네트워크(npm, Go proxy, GitHub, 일반 웹) 모두 열림 / 관리자 아님(embedded-postgres에 유리).

## 핵심 설계 결정 (대안 → 선택 → 이유, 스스로 반박해 본 결과)

1. **pnpm 버전 고정: `pnpm@11.28.2`**
   - 대안: 최신 12.10.1. 반박: 12는 나온 지 얼마 안 된 메이저이고 로컬에 없다. 11.28.2는 11 계열 최신(`latest-11`)이며 이미 설치돼 있어 추가 다운로드가 없다. → 11.28.2.
2. **TypeScript 6.0.3 (7.x 아님)**
   - TS 7.0.2(네이티브 포트)가 최신이지만 typescript-eslint 8.71.1의 peer 범위가 `>=4.8.4 <6.1.0`이다. 타입 기반 린트(`strictTypeChecked`)가 필수이므로 6.0.3으로 고정. 재검토 조건: typescript-eslint가 7을 지원할 때.
3. **ESLint 10 + typescript-eslint `strictTypeChecked` + `eslint-plugin-simple-import-sort`**
   - import 순서용으로 `eslint-plugin-import-x`도 검토. 리졸버 설정이 필요하고 무겁다. 이 단계에서 필요한 건 순서뿐이라 의존성이 없고 자동 수정되는 simple-import-sort(MIT)를 고른다.
   - 타입 기반 규칙은 `**/*.ts`에만 건다. `.mjs` 스크립트는 JS 권장 규칙으로 린트하고, 타입은 루트 `tsconfig.json`(`checkJs`)로 검사한다.
4. **커스텀 금지 규칙은 `no-restricted-syntax`로 구현하고, 경로가 겹치면 합친다**
   - flat config에서는 뒤의 설정 객체가 같은 규칙을 통째로 덮어쓴다. 그래서 "서버 ∩ 돈 경로"는 시간 금지와 돈 금지 셀렉터를 모두 담은 별도 객체로 둔다(반박: 겹치는 경로에서 한쪽 규칙이 조용히 사라질 수 있다 → 증명 테스트에 겹치는 파일 사례를 넣는다).
   - 돈 경로 금지 범위는 스펙보다 넓게 잡는다. `parseFloat`, `Number(...)`, `Number.parseFloat/parseInt`, `Math.*` 전체, `.toFixed`, 부동소수점 리터럴이다. 돈은 bigint이고 `Math.*`는 bigint를 받지 않으므로 잃는 것이 없다.
   - 시간 금지는 `Date.now()`, 인자 없는 `new Date()`, `Date()` 호출이다. 예외는 `apps/server/src/lib/clock.ts` 하나.
   - 증명 테스트: ESLint Node API로 **실제 `eslint.config.mjs`**를 불러 가상 파일 경로로 `lintText`한다. 가상 파일은 TS 프로젝트에 없으므로 테스트에서만 타입 기반 파싱을 끈다(`disableTypeChecked`). 금지 규칙은 타입 정보가 필요 없으므로 증명력은 그대로다.
5. **Prettier는 코드·설정만 검사하고 Markdown은 제외한다**
   - 문서는 한국어 산문과 표 위주이고, PROGRESS.md 표는 보드(`scripts/board.mjs`)가 파싱한다. Prettier가 표를 재정렬하면 위험이 생긴다. 문서 품질은 `scripts/check-docs.mjs`가 맡는다.
   - 키트 도구 `scripts/board.mjs`, `scripts/status.mjs`, `scripts/board-web.cmd`, `scripts/run-stages.*`는 Prettier·ESLint ignore에 넣는다. 스펙 요구: 키트 파일은 고치지 않는다.
6. **`scripts/verify.mjs`: `shell: false`, 모든 단계를 끝까지 돌리고 하나라도 FAIL이면 종료 코드 1**
   - Windows에서 Node는 `.cmd`를 `shell:false`로 실행하지 못한다(CVE-2024-27980 대응). pnpm은 다음 순서로 찾는다.
     ① `npm_execpath`(`pnpm verify`로 실행하면 pnpm의 JS 진입점) → `node <그 파일>`
     ② PATH의 npm 전역 설치본(`node_modules/pnpm/bin/pnpm.cjs`)
     ③ Node에 번들된 `corepack.js pnpm`
     ④ 비Windows는 `pnpm` 실행 파일
     못 찾으면 FAIL.
   - Go 단계: `go version`이 ENOENT면 SKIPPED를 크게 표시한다. `REQUIRE_GO=1`이면 FAIL이다. `gofmt -l` 출력이 비어 있지 않으면 FAIL이다.
   - 실패 판정: 종료 코드 ≠ 0, 시그널 종료, spawn 오류는 모두 FAIL이다. 반박: "에러만 출력하고 성공 처리"하는 경로를 막으려고 판정 함수를 분리해 단위 테스트한다.
   - `--quick`은 환경변수 `SPAREON_TEST_QUICK=1`로 전달한다. 공용 Vitest 설정(`packages/testkit/src/vitest-config.ts`의 `defineSpareonVitestConfig`)이 이 값을 보고 `*.int.test.ts`와 DB globalSetup을 뺀다. CLI 글롭 인자를 pnpm 경유로 넘기면 셸마다 글롭 해석이 달라서 이 방식을 쓴다.
   - `docs` 단계(`scripts/check-docs.mjs`)를 format 다음에 둔다. 게이트 4번 요구사항이다.
7. **테스트 DB (`packages/testkit`)**
   - `TEST_DATABASE_URL` → `DATABASE_URL` → embedded-postgres 순서로 고른다. embedded-postgres는 **16.x**(`16.14.0-beta.17`)로 고정한다. 운영 하한이 16이므로 하한 버전에서 테스트해야 17+ 전용 기능을 실수로 쓰지 않는다.
   - globalSetup이 한 번 띄우고 실행마다 고유한 `runId`로 템플릿 DB `spareon_tpl_<runId>`를 만든다. `createIsolatedDatabase()`는 `CREATE DATABASE spareon_t_<runId>_<rand> TEMPLATE …`로 테스트 파일마다 새 DB를 준다.
   - 안전: 외부 DB(`DATABASE_URL`)를 쓸 때도 **이번 실행이 만든 접두사 DB만** 만들고 지운다. 다른 DB는 건드리지 않는다. 식별자는 정규식으로 검증한다.
   - root로 실행되는 리눅스(클라우드)에서는 initdb가 거부하므로 `createPostgresUser`를 켠다.
   - 포트는 OS가 준 빈 포트를 쓰고, 시작 실패 시 최대 3회 다른 포트로 재시도한다.
8. **내부 패키지는 소스(`src/index.ts`)를 직접 export한다(JIT 패키지)**
   - 대안: 각 패키지를 빌드해 `dist`를 export. S00 단계에서는 빌드 순서 관리가 짐만 된다. 운영 번들링은 S30에서 결정한다(가정으로 기록).
9. **테스트 러너 위치**: 린트 규칙 증명, verify 판정, check-docs, CI YAML 구조 테스트는 `tools/repo-checks`(`@spareon/repo-checks`) 패키지에 둔다. `pnpm -r`은 루트를 포함하지 않으므로 루트 테스트를 따로 두면 빠질 위험이 있다.
10. **CI**: `linux` 잡은 `REQUIRE_GO=1 pnpm verify`, `windows` 잡은 `apps/agent`에서 `go test ./...`. `concurrency`와 `permissions: contents: read`를 둔다. YAML은 `actionlint`(`go run`, 1회 시도)와 repo-checks의 구조 테스트로 검증한다.

## 새 의존성과 이유 (모두 MIT/Apache-2.0/ISC)
| 패키지 | 이유 |
|---|---|
| typescript 6.0.3 | 타입체크 (위 2번) |
| eslint, @eslint/js, typescript-eslint, globals, eslint-plugin-simple-import-sort, eslint-config-prettier | 린트 (위 3번) |
| prettier | 포맷 |
| vitest | 테스트 (스택 결정) |
| fastify, zod | 서버 최소 앱과 환경변수 검증 (스택 결정) |
| tsx | 서버 개발 실행 (`pnpm --filter @spareon/server dev`) |
| embedded-postgres, pg, @types/pg | 테스트 DB (스택 결정) |
| yaml | CI YAML 구조 테스트 |
| @types/node | Node 타입 |

## 위험
- pnpm 11의 빌드 스크립트 승인 정책 때문에 embedded-postgres 플랫폼 패키지 설치가 막힐 수 있다 → 설치 결과를 보고 필요하면 `pnpm-workspace.yaml`에 허용을 명시한다.
- Windows 줄바꿈: `core.autocrlf=true` 환경이다. `.gitattributes`(eol=lf)와 Prettier `endOfLine: lf`로 고정하고, gofmt는 CRLF를 차이로 보므로 반드시 LF여야 한다.
- embedded-postgres는 관리자 권한에서 실행되지 않는다(Postgres 정책). 지금 환경은 관리자가 아니다. 그래도 ENVIRONMENT.md에 적는다.
- typescript-eslint와 TS 버전 범위가 어긋나면 린트가 경고를 낸다 → 6.0.3으로 고정해 피한다.

## 체크포인트
| # | 내용 | 검증 |
|---|---|---|
| 1 | PLAN.md, ENVIRONMENT.md, `.gitignore`·`.gitattributes`·`.editorconfig`·`.node-version` | 파일 존재, `git check-attr` |
| 2 | 루트 워크스페이스 설정(package.json, pnpm-workspace, tsconfig, prettier, eslint) + 패키지 골격(server healthz, web, shared, protocol) + 각 테스트 | `pnpm install`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm lint`, `pnpm format:check` |
| 3 | 커스텀 금지 규칙 + 증명 테스트(`tools/repo-checks`) | 위반 샘플이 에러, 예외 파일·정상 코드는 통과 |
| 4 | testkit: `startTestDatabase`, globalSetup, `createIsolatedDatabase` + int 테스트 | `DATABASE_URL` 없이 `pnpm --filter @spareon/testkit test` |
| 5 | Go 에이전트 모듈 + 테스트 | `gofmt -l`, `go vet`, `go test`, `GOOS=windows go build` |
| 6 | `scripts/verify.mjs`, `scripts/check-docs.mjs` + 판정 단위 테스트 | `pnpm verify`, `pnpm verify --quick`, `--only=go` |
| 7 | CI 워크플로, README, ADR 0000/0001 | actionlint 또는 YAML 구조 테스트, check-docs |
| 8 | 게이트·적대적 검토 반영·REPORT | `pnpm verify` 전체 통과 |
