# S00 보고서 — 환경·저장소·CI 부트스트랩

- 상태: DONE
- 커밋 범위: `stage-S00-start..stage-S00-done`
- 시작 / 종료: 2026-10-08 07:43 / 2026-10-08 15:30

> 작성 메모: 서브에이전트 환경에서 보고서 파일 쓰기가 막혀, 서브에이전트가 넘긴 내용을 지휘자가 그대로 옮겨 적었다. 지휘자는 작성 직전 `pnpm verify`를 다시 돌려 PASS(9단계)를 확인했다.

## 한 일
1. pnpm 11 모노레포(TS 6 strict, ESLint 10 타입 기반 규칙, Prettier)를 만들었다. 서버 `/healthz`, 웹·shared·protocol 자리표시, Go 에이전트 `version` 명령도 넣었다.
2. `pnpm verify` 한 줄로 포맷→문서→린트→타입→테스트→Go(gofmt·vet·test·Windows 교차 빌드)를 돌린다. 쉘 없이 실행하고 실패를 삼키지 않는다(단위·프로세스 테스트로 확인).
3. 테스트 DB 키트를 만들었다. DATABASE_URL이 없으면 embedded-postgres 16을 띄우고 테스트 파일마다 템플릿에서 복제한 독립 DB를 준다. 실패한 테스트가 종료 코드 0으로 나오던 숨은 버그를 찾아 고쳤다.
4. 서버 시계 금지·돈 경로 부동소수점 금지 린트 규칙을 만들고 주석으로 끄는 우회까지 막았다. ESLint API로 위반 샘플이 실제로 에러를 내는지 증명했다.
5. GitHub Actions CI(linux 전체 검증, windows Go 테스트, actionlint)와 README, ENVIRONMENT, ADR 0000·0001을 썼다. 깨끗한 클론에서 전체 통과를 확인했다.

## 실행하는 법
```
corepack enable
pnpm install
pnpm verify              # 전체 게이트
pnpm verify --quick      # *.int.test.ts 제외
pnpm verify --only=go    # Go 단계만 (--only=ts)
pnpm --filter @binjari/server dev     # http://127.0.0.1:8080/healthz
cd apps/agent && go run ./cmd/binjari-agent version
pnpm lint:ci             # actionlint (Go 필요)
```

## 수용 기준 결과
| # | 기준 | 실행한 명령 | 결과 |
|---|---|---|---|
| 1 | 깨끗한 클론에서 install+verify | 스크래치 폴더 `git clone` → `pnpm install --frozen-lockfile` → `pnpm verify` | PASS(9단계, 리뷰 반영 전 코드). 리뷰 반영 후 작업 트리에서 재실행 PASS (9 step(s) passed), 지휘자 재확인 PASS |
| 2 | Windows 교차 빌드 | `pnpm verify`의 `go:build-windows`(GOOS=windows GOARCH=amd64 go build ./...) | PASS |
| 3 | DATABASE_URL 없이 DB 테스트 | `pnpm --filter @binjari/testkit test` (URL 미설정) | PASS (17 tests, embedded-postgres 16.14, Windows) |
| 4 | 린트 규칙 증명 | `pnpm --filter @binjari/repo-checks test` (lint-rules.test.ts) | PASS. 규칙을 약화한 변이 실험 3회 모두 테스트 실패로 잡힘 |
| 5 | ENVIRONMENT.md에 버전·네트워크 | 파일 확인 | PASS |
| 6 | CI YAML 검증 | `pnpm lint:ci`(actionlint v1.7.12) + ci-config.test.ts | PASS (지적 0건) |

## 적대적 검토 결과 (2회)
| 심각도 | 지적 | 조치 |
|---|---|---|
| 높음(자체 발견) | embedded-postgres의 async-exit-hook이 beforeExit에서 process.exit(0)을 호출해, DB를 쓰는 vitest 실행은 테스트가 실패해도 종료 코드 0 | 고침: `preserveFailingExitCode()`. 회귀 테스트 `exit-code.int.test.ts`가 실패·성공 fixture를 실제로 실행한다. 가드를 빼면 실패하는 것을 확인했고 리뷰어도 재현했다 |
| 중간 | 주석(`eslint-disable…`, 자기 자신을 끄는 블록 주석 포함)으로 금지 규칙을 끌 수 있음 | 고침: 돈·서버 경로는 `noInlineConfig`(주석 무시 + 경고 → `--max-warnings=0`으로 실패), 전체 경로는 eslint-comments 규칙. 변이 실험으로 증명 |
| 중간 | 돈 규칙 구멍(parseInt, map(Number), 단항 +, globalThis.parseFloat, toPrecision, Math 구조분해) | 고침: 식별자 단위로 금지(Number·Math·parseFloat·parseInt·Infinity·NaN), globalThis 접근, 단항 +, toPrecision·toExponential 금지. 사례별 테스트 |
| 중간 | Windows EBUSY로 teardown 오류가 나고 그 오류가 삼켜짐 | 고침: persistent:true + 자체 rm(재시도). teardown 실패 시 종료 코드 1 |
| 낮음 | 망가진 Go를 SKIPPED로 처리 / 모두 SKIPPED여도 PASS / engine-strict가 동작 안 함 / PLAN 경로 오류 / 원격·`?host=` DATABASE_URL / DB 테스트 순서 의존 / test 스크립트 누락 패키지 / 링크 대소문자 / CI에 actionlint 없음 / 확장자 불일치 / `.obsidian`이 format 깨뜨림 | 모두 고침 |
| 낮음 | 의도적 시간 우회 남음(`const D = Date; D.now()`, `Reflect.construct`, 템플릿 키, performance.now) | 안 고침. 린트는 실수를 막는 장치다. `Date` 식별자를 전면 금지하면 타입 표기까지 막힌다. performance.now는 단조 시계여서 허용했다. S05에서 다시 본다 |
| 중간(지휘자 발견) | `check-docs`가 PROGRESS.md의 가정 기록 표 행(`| S00 | <가정> |`)까지 상태로 검사해 실패 | 고침: 첫 번째 표(상태 표)만 검사. 회귀 테스트 추가(check-docs.test.ts) |
| 낮음 | 액션을 SHA가 아닌 메이저 태그로 고정 | 안 고침. contents: read라 위험이 작다. S30에서 검토 |

## 가정
| 가정 | 근거 | 틀리면 바꿀 곳 |
|---|---|---|
| pnpm 11.28.2 고정(최신 12.10.1 아님) | 설치된 11 계열 최신, 12는 신규 메이저 | package.json packageManager |
| TypeScript 6.0.3(7.x 아님) | typescript-eslint 8.71.1이 <6.1.0만 지원 | pnpm-workspace.yaml catalog |
| 테스트 Postgres 16.x | 운영 하한 16에 맞춤 | catalog embedded-postgres |
| 내부 패키지가 TS 소스를 export | 빌드 순서 부담 회피. 번들은 S30에서 | 각 package.json exports |
| Markdown은 Prettier 제외 | 보드가 PROGRESS 표를 파싱. 문서는 check-docs가 검사 | .prettierignore |
| 원격 DATABASE_URL 거부(`BINJARI_ALLOW_REMOTE_TEST_DB=1`로 허용) | 테스트가 DB를 만들고 지움. 운영 DB 보호 | packages/testkit/src/db.ts |

## 사람이 확인할 것 (HUMAN_TODO에 추가함)
- GitHub 원격 연결 후 push해서 CI 첫 실행 확인(Linux·Windows 러너).
- 루트의 `board-web.cmd`(차수 밖에서 생성, 루트에서는 동작 안 함). git 추적에서 뺐다. 필요 없으면 삭제.
- `.claude/settings.json` 허용 목록 추가 검토.

## 막힌 것
없음. (보고서 파일 쓰기가 서브에이전트에서 막힌 것은 지휘자가 대신 작성해 해결했다.)

## 다음 차수에 미치는 영향
- 모든 패키지는 `defineBinjariVitestConfig()`를 쓴다. DB가 필요하면 `{ useTestDatabase: true }` + `*.int.test.ts` + `createIsolatedDatabase()`.
- S03: `packages/testkit/src/global-setup.ts`의 SKELETON(S03) 자리에서 템플릿 DB에 마이그레이션을 적용한다.
- 서버 시간은 `apps/server/src/lib/clock.ts`의 Clock만 쓴다. money/ledger/pricing 폴더에서는 Number·Math·부동소수점 금지이고 인라인 ESLint 주석이 무시된다.
- 새 패키지 규칙: `@binjari/<폴더>`, private, type module, typecheck 스크립트, 테스트가 있으면 `test: vitest run`(repo-checks가 검사). 설치 스크립트가 필요한 의존성은 pnpm-workspace.yaml `allowBuilds`에 이유와 함께 추가한다.

## 수치
- TS 테스트: server 8, web 2, testkit 17(통합 8), repo-checks 약 140. Go 테스트 함수 6. 모두 통과.
- `pnpm verify` 약 2분(lint 30초, test 60초), `--quick` 약 1분 (Windows 11).

## 추가 권장 허용 명령
`Bash(git clone:*)`, `Bash(env:*)`, `Bash(date:*)`, `Bash(uname:*)`, `Bash(whoami:*)`, `Bash(net session:*)`, `Bash(sed:*)`, `Bash(grep:*)`, `Bash(printf:*)`

## 선택 확장 결과
하지 않음(게이트 통과와 리뷰 반영에 집중).
