# 개발 환경 기록

> S00에서 실제 명령으로 확인한 값이다(확인일 2026-10-08). 환경이 바뀌면 다시 확인하고 갱신한다.

## 이 저장소를 처음 만든 환경
| 항목 | 값 | 확인 명령 |
|---|---|---|
| OS | Windows 11 Pro Education 10.0.22631, x64 (Git Bash: MINGW64 3.6.10) | `uname -a` |
| 권한 | 일반 사용자(관리자 아님) — embedded-postgres는 관리자 권한에서 실행되지 않으므로 오히려 맞다 | `net session` |
| Node.js | v22.18.0 (Active LTS 22 이상 충족) | `node -v` |
| corepack | 0.33.0 (Node 번들) | `corepack -v` |
| pnpm | 11.28.2 (npm 전역 설치본) — 저장소는 `packageManager: pnpm@11.28.2`로 고정 | `pnpm -v` |
| Go | go1.27.0 windows/amd64, `GOPROXY=https://proxy.golang.org,direct` | `go version`, `go env` |
| git | 2.55.0.windows.5, `core.autocrlf=true`(저장소는 `.gitattributes`로 LF 고정) | `git --version` |
| Docker | 없음 | `docker --version` → command not found |
| psql | 없음 (테스트 DB는 embedded-postgres로 대체) | `psql --version` → command not found |
| actionlint | 전역 설치 없음 — `go run github.com/rhysd/actionlint/cmd/actionlint@<버전>`로 실행 | `actionlint -version` |
| `PLAYWRIGHT_BROWSERS_PATH` | 설정 안 됨(기본 경로 사용: Windows `%LOCALAPPDATA%\ms-playwright`). Playwright는 S23에서 도입 | `echo $PLAYWRIGHT_BROWSERS_PATH` |

## 네트워크 접근 (각 1회 요청, 재시도 없음)
| 대상 | 결과 | 명령 |
|---|---|---|
| npm 레지스트리 `https://registry.npmjs.org/` | 200 (가능) | `curl -s -o /dev/null -w '%{http_code}' <URL>` |
| Go 모듈 프록시 `https://proxy.golang.org/` | 200 (가능) | 같음 |
| GitHub `https://github.com/` | 200 (가능) | 같음 |
| 일반 웹 `https://www.example.com/` | 200 (가능) | 같음 |

## 고정한 주요 도구 버전 (2026-10-08 npm 레지스트리 기준)
| 도구 | 고정 버전 | 비고 |
|---|---|---|
| pnpm | 11.28.2 | 최신은 12.10.1. 이미 설치된 11 계열 최신을 고정(PLAN 결정 1) |
| TypeScript | 6.0.3 | 최신 7.0.2는 typescript-eslint 8.71.1 지원 범위(`<6.1.0`) 밖 |
| ESLint | 10.x | typescript-eslint 8.71.x `strictTypeChecked` |
| Vitest | 5.x | Node `^22.12.0` 이상 필요 |
| embedded-postgres | 16.14.0-beta.17 | 운영 하한 PostgreSQL 16과 맞춤 |
| Go | 1.27.0 (`apps/agent/go.mod`) | CI는 `go.mod`에서 버전을 읽는다 |

정확한 버전은 루트·패키지 `package.json`과 `pnpm-lock.yaml`이 진실 원천이다.

## 테스트 DB 선택 규칙 (`packages/testkit`)
1. `TEST_DATABASE_URL`이 있으면 그 서버를 쓴다(전용 테스트 서버로 간주).
2. 없고 `DATABASE_URL`이 있으면, 호스트가 `localhost`·`127.0.0.1`·`[::1]`일 때만 쓴다. 원격 호스트면 테스트가 실패한다. 테스트가 그 서버에 DB를 만들고 지우기 때문이다. 정말 원격을 쓰려면 `BINJARI_ALLOW_REMOTE_TEST_DB=1`을 설정한다.
3. 둘 다 없으면 embedded-postgres 16을 임시 디렉터리와 빈 포트로 띄우고, 끝나면 지운다.
어느 경우든 이번 실행이 만든 `binjari_tpl_<runId>`, `binjari_t_<runId>_*` DB만 만들고 지운다.

## 다른 환경에서 확인할 것
- **Claude Code 클라우드(리눅스, 네트워크 제한)**: npm 레지스트리 접근이 막히면 `pnpm install` 자체가 불가능하다. 그 경우 `HUMAN_TODO.md`에 적고 끝낸다. root로 실행되면 testkit이 embedded-postgres에 `createPostgresUser`를 켠다(initdb는 root 실행을 거부).
- **macOS/Linux**: embedded-postgres 플랫폼 바이너리(`@embedded-postgres/<os>-<arch>`)가 선택적 의존성으로 설치된다.
- Go가 없는 환경: `pnpm verify`가 Go 단계를 `SKIPPED`로 크게 표시한다. `REQUIRE_GO=1`이면 FAIL로 처리한다(CI).
