# binjari (빈자리, 가칭)

PC방에서 손님이 없는 PC의 GPU로 오픈소스 AI 모델 추론을 처리하고, 그 대가로 매장에 **크레딧**을 적립해 주는 플랫폼이다. 구매자는 크레딧으로 오픈소스 모델과 외부 모델을 쓴다.

- 처음이라면: [START_HERE.md](START_HERE.md)
- 작업 규칙: [CLAUDE.md](CLAUDE.md) · 진행 상황: [PROGRESS.md](PROGRESS.md) · 사람이 할 일: [HUMAN_TODO.md](HUMAN_TODO.md)
- 사업 배경: [docs/BUSINESS_CONTEXT.md](docs/BUSINESS_CONTEXT.md) · 개발 환경: [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) · 결정 기록: [docs/adr/](docs/adr/)

## 빠른 시작
요구 사항: Node.js 22.13 이상(corepack 포함), Go 1.27(에이전트), Git. Docker와 Postgres 설치는 필요 없다(테스트 DB는 embedded-postgres가 자동으로 띄운다).

```
corepack enable          # package.json의 packageManager(pnpm 버전)를 그대로 쓴다
pnpm install
pnpm verify              # 포맷·문서·린트·타입·테스트·Go 전체 검증
pnpm verify --quick      # 통합 테스트(*.int.test.ts) 제외
pnpm verify --only=go    # Go 단계만 (--only=ts 는 TS·문서 단계만)
```

## 구조
| 경로 | 내용 |
|---|---|
| `apps/server` | Fastify 서버 (현재 `GET /healthz`만) |
| `apps/web` | 웹 자리표시 (Next.js는 S23) |
| `apps/agent` | Go 에이전트 `binjari/agent` (`go run ./cmd/binjari-agent version`) |
| `packages/shared` · `packages/protocol` | 공용 유틸 · 프로토콜 스키마 (자리표시) |
| `packages/testkit` | 테스트 DB(`startTestDatabase`, `createIsolatedDatabase`)와 공용 Vitest 설정 |
| `tools/repo-checks` | 저장소 규칙 테스트(린트 금지 규칙 증명, verify 판정, 문서 검사, CI 설정) |
| `scripts/` | `verify.mjs`, `check-docs.mjs`, 진행 보드(`board.mjs`, `status.mjs`) |

## 자주 쓰는 명령
| 명령 | 설명 |
|---|---|
| `pnpm --filter @binjari/server dev` | 서버 개발 실행 (기본 `127.0.0.1:8080`, `HOST`·`PORT` 환경변수) |
| `pnpm lint:fix` · `pnpm format` | 자동 수정 |
| `pnpm check-docs` | 문서 링크·ADR 형식·상태 값 검사 |
| `pnpm lint:ci` | GitHub Actions 워크플로 검사(actionlint, Go 필요) |
| `pnpm board` · `pnpm board:web` | 진행 보드 |
