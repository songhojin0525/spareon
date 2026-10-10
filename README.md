# spareon (Spareon, 가칭)

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
| `apps/server` | Fastify 서버 (현재 `GET /healthz`만). DB 스키마·마이그레이션·팩토리는 `src/db`·`drizzle/`·`src/testing`([docs/DB.md](docs/DB.md)) |
| `apps/web` | 웹 자리표시 (Next.js는 S23) |
| `apps/agent` | Go 에이전트 `spareon/agent` (`go run ./cmd/spareon-agent version`). `internal/protocol`은 같은 스키마로 검증하는 Go 쪽 계약 |
| `packages/shared` | 공용 유틸(UUIDv7, 전송 시각 형식). 돈 유틸은 S06 |
| `packages/protocol` | 에이전트⇄서버 프로토콜: JSON Schema 원천, 생성 TS 타입·검증기, fixture, 서명 벡터([docs/PROTOCOL.md](docs/PROTOCOL.md)). 스키마를 고치면 `pnpm --filter @spareon/protocol gen` |
| `packages/testkit` | 테스트 DB(`startTestDatabase`, 템플릿 복제 `createIsolatedDatabase`), `FakeClock`, `createSeededRandom`, `dumpSchema`, 공용 Vitest 설정 |
| `tools/repo-checks` | 저장소 규칙 테스트(린트 금지 규칙 증명, verify 판정, 문서 검사, CI 설정) |
| `scripts/` | `verify.mjs`, `check-docs.mjs`, 진행 보드(`board.mjs`, `status.mjs`) |

## 자주 쓰는 명령
| 명령 | 설명 |
|---|---|
| `pnpm --filter @spareon/server dev` | 서버 실행(watch). 필요한 환경변수는 `apps/server/.env.example`(없거나 틀리면 무엇이 잘못됐는지 출력하고 종료). 개발용으로는 `pnpm dev:server`가 비밀을 만들어 준다 |
| `pnpm --filter @spareon/server cli <명령>` | 운영자 CLI: `user:create`(운영자 계정은 이것으로만), `user:disable`, `user:set-password`, `key:create`, `key:revoke`, `settings:get/set`, `audit:tail`. 모든 쓰기는 감사 기록 |
| `pnpm --filter @spareon/server env:example` | `apps/server/.env.example`을 설정 스키마에서 다시 만든다 |
| `pnpm --filter @spareon/server db:migrate` · `db:status` · `db:rollback --yes` | DB 마이그레이션(`DATABASE_URL`). 스키마·불변식은 [docs/DB.md](docs/DB.md) |
| `pnpm --filter @spareon/server db:seed` | 개발용 시드(로컬 DB만, 두 번 실행해도 그대로) |
| `pnpm --filter @spareon/server db:generate` | 스키마(TS)에서 새 마이그레이션 SQL 생성(drizzle-kit) 후 사람이 검토 |
| `pnpm lint:fix` · `pnpm format` | 자동 수정 |
| `pnpm check-docs` | 문서 링크·ADR 형식·상태 값 검사 |
| `pnpm lint:ci` | GitHub Actions 워크플로 검사(actionlint, Go 필요) |
| `pnpm board` · `pnpm board:web` | 진행 보드 |
