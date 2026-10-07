# S00 · 환경·저장소·CI 부트스트랩

| 항목 | 값 |
|---|---|
| 의존 | 없음 |
| 권장 모델 | Sonnet 5.5 (effort 보통 이상) |
| 규모 | M |
| 사람 필요 | 시작 시 권장 — 도구 설치·권한 확인창이 뜰 수 있다 |

이 차수는 `prompts/_PROTOCOL.md`를 따른다.

## 목표
어떤 개발 환경(Windows, macOS, Linux, Claude Code 클라우드)에서도 `pnpm verify` 한 줄로 전체 검증이 돌아가는 빈 모노레포와 CI를 만든다. 이후 32개 차수가 모두 이 기반 위에서 움직이므로, 여기서 정한 규칙(린트, 포맷, 테스트 DB, 검증 스크립트)이 흔들리지 않아야 한다.

## 먼저 읽을 것
- `CLAUDE.md`(기술 스택·구조·규칙), `prompts/STAGES.md`, `START_HERE.md`

## 산출물
- `docs/ENVIRONMENT.md` — OS, 도구 버전, 네트워크 접근 가능 여부(npm 레지스트리, Go 모듈 프록시, GitHub, 일반 웹), Docker 유무, Playwright 브라우저 경로
- 루트: `package.json`(private, `packageManager` 고정, scripts), `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc`, `.editorconfig`, `.gitattributes`, `.gitignore`(보강), `.node-version`
- `scripts/verify.mjs` — 교차 플랫폼 검증 오케스트레이터
- `scripts/check-docs.mjs` — 문서 검사 초기 버전(이후 차수가 확장)
- `apps/server` — Fastify 최소 앱(`GET /healthz`) + 테스트 1개
- `apps/web` — 자리표시 패키지(테스트 1개). Next.js는 S23에서 만든다.
- `apps/agent` — Go 모듈 `binjari/agent`, `cmd/binjari-agent/main.go`(`version` 출력) + 테스트 1개
- `packages/shared`, `packages/protocol`(자리표시), `packages/testkit`(테스트 DB 헬퍼, 아래 4절)
- `.github/workflows/ci.yml`
- `README.md`(프로젝트 소개 짧게 + START_HERE 링크), `docs/adr/0000-template.md`, `docs/adr/0001-record-decisions.md`

## 상세 요구사항

### 1. 환경 감지와 설치
- 확인: `node -v`, `corepack -v`, `pnpm -v`, `go version`, `git --version`, `docker --version`, `psql --version`, 환경변수 `PLAYWRIGHT_BROWSERS_PATH`.
- Node가 22 미만이면 HUMAN_TODO에 업그레이드 절차를 적는다. pnpm은 `corepack enable` 후 `packageManager`에 고정한 버전을 쓴다.
- Go가 없으면 OS 패키지 관리자 또는 공식 배포본으로 설치를 **1회만** 시도한다. 네트워크 제한으로 실패하면 반복하지 않는다. 그 경우 Go 코드는 작성하되 실행 검증은 NEEDS-HUMAN으로 기록한다.
- 네트워크 접근 여부는 실제 요청 1회로 확인해 ENVIRONMENT.md에 적는다(실패해도 반복 재시도 금지).

### 2. TypeScript·린트 규칙
- `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`, target ES2022 이상, module/moduleResolution NodeNext.
- ESLint flat config: typescript-eslint `strictTypeChecked`, `no-floating-promises`, `consistent-type-imports`, import 순서.
- **커스텀 금지 규칙** (`no-restricted-syntax` 등):
  - `apps/server/src/**`에서 `Date.now()`와 인자 없는 `new Date()` 금지. 예외: `apps/server/src/lib/clock.ts`.
  - 돈 관련 경로(`**/money/**`, `**/ledger/**`, `**/pricing/**`)에서 `parseFloat`, `Number(`, `Math.round`, 부동소수점 리터럴 연산 금지.
- 위 규칙이 실제로 위반을 잡는지 증명하는 테스트: ESLint Node API로 위반 샘플 코드를 검사해 에러가 나는지 확인한다.

### 3. `scripts/verify.mjs`
- 순서: `format:check` → `lint` → `typecheck` → `test`(pnpm -r) → Go(`gofmt -l` 결과가 비어야 함, `go vet ./...`, `go test ./...`, `GOOS=windows GOARCH=amd64 go build ./...`).
- 옵션: `--only=ts|go`, `--quick`(통합 테스트 제외; 파일명 규칙 `*.int.test.ts`).
- 끝에 단계별 결과 표(PASS / FAIL / SKIPPED, 소요 시간). 하나라도 FAIL이면 종료 코드 1.
- Go가 없으면 Go 단계는 SKIPPED로 크게 표시하고, 환경변수 `REQUIRE_GO=1`이면 FAIL로 처리한다(CI에서 사용).
- Windows PowerShell, macOS, Linux에서 모두 동작해야 한다. 쉘 전용 문법 금지(`child_process.spawn`, `shell: false`, 실행 파일 이름은 플랫폼별로 처리).
- 루트 `package.json`: `"verify": "node scripts/verify.mjs"`.
- 루트 `package.json`에 `"board": "node scripts/board.mjs"`, `"board:web": "node scripts/board.mjs --web --open"`도 추가한다. `scripts/board.mjs`·`scripts/status.mjs`·`scripts/board-web.cmd`는 키트가 미리 넣어 둔 의존성 없는 도구다: 지우지 말고, 린트·포맷 검사가 이 파일들 때문에 실패하면 고치지 말고 ESLint·Prettier ignore에 추가한다(이유를 PLAN에 적는다). S00 자체도 `_PROTOCOL.md` 10절대로 상태를 보고한다.

### 4. 테스트 DB (`packages/testkit`)
- `startTestDatabase()`: `TEST_DATABASE_URL` 또는 `DATABASE_URL`이 있으면 그걸 쓰고, 없으면 `embedded-postgres`로 임시 Postgres를 띄운다(랜덤 포트, 임시 디렉터리, 종료 시 정리).
- Vitest `globalSetup`으로 한 번만 띄워 재사용한다. 테스트 파일마다 독립 데이터베이스를 쓰는 `createIsolatedDatabase()`를 제공한다(템플릿 DB 복제 방식 — S03에서 마이그레이션이 적용된 템플릿으로 확장).
- 테스트: 임시 DB에서 테이블 생성·조회.

### 5. CI (`.github/workflows/ci.yml`)
- `linux` 잡: Node LTS + pnpm 캐시 + Go 캐시 → `pnpm install --frozen-lockfile` → `REQUIRE_GO=1 pnpm verify`.
- `windows` 잡(`windows-latest`): Go 설치 → `apps/agent`에서 `go test ./...`. 이후 차수(S21)가 설치 프로그램 빌드를 여기에 추가한다.
- `concurrency`로 같은 브랜치의 이전 실행 취소, `permissions: contents: read`.
- 가능하면 `actionlint`로 검증. 설치가 안 되면 YAML 파싱 검증으로 대체하고 REPORT에 적는다.

### 6. Git
- 저장소가 아니면 `git init`(기본 브랜치 `main`). 이미 저장소면 그대로 쓴다.
- `.gitignore` 보강: `dist/`, `.next/`, `coverage/`, `apps/agent/bin/`, `*.gguf`, `models-cache/`, `*.msi`, `.turbo/`, OS 잡파일.
- `.gitattributes`: `* text=auto eol=lf`, `*.ps1 text eol=crlf`, `*.bat text eol=crlf`, 바이너리 확장자 지정.

### 7. Claude Code 자산
- `.claude/settings.json`이 유효한 JSON인지 확인한다. 이 차수에서 필요했는데 허용 목록에 없던 명령은 REPORT의 "추가 권장 허용 명령"에 적는다. 권한을 직접 넓히지 않는다.

## 하지 말 것
- Next.js 앱 생성(S23), DB 스키마(S03), 실제 기능 구현
- 사용자 환경을 크게 바꾸는 전역 설치(필요하면 최소한으로 하고 ENVIRONMENT.md에 기록)

## 수용 기준
1. 깨끗한 클론에서 `pnpm install && pnpm verify` 통과(Go가 없으면 Go SKIPPED 표시 + NEEDS-HUMAN 기록)
2. Go가 있으면 `GOOS=windows GOARCH=amd64 go build ./...` 성공
3. 테스트 DB 테스트가 `DATABASE_URL` 없이도 통과
4. 린트 규칙 증명 테스트 통과(위반 샘플이 실제로 에러를 낸다)
5. `docs/ENVIRONMENT.md`에 도구 버전과 네트워크 확인 결과가 있다
6. CI YAML 검증 통과

## 적대적 검토 포인트
- verify가 실패를 삼키는 경로(종료 코드 무시, 에러 출력만 하고 성공 처리)
- Windows에서 깨질 경로 구분자·쉘 문법·줄바꿈
- 테스트 DB가 테스트 사이에 상태를 공유해 순서 의존 테스트가 생길 여지

## 선택 확장
- lefthook으로 커밋 전 `pnpm verify --quick`
- Renovate 설정(주 1회 묶음 업데이트, 메이저는 수동)
- `.devcontainer/` 설정
