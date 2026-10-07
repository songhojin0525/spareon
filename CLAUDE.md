# binjari(빈자리) — Claude Code 작업 규칙

> `binjari`는 가칭 코드네임이다. 이 파일은 모든 세션이 자동으로 읽는다. 짧게 유지하고, 세부 내용은 링크된 문서를 필요한 만큼만 읽는다.

## 무엇을 만드는가
PC방에서 손님이 없는 PC의 GPU로 오픈소스 AI 모델 추론을 처리하고, 그 대가로 매장(PC방)에 **크레딧**을 적립해 주는 플랫폼이다. 구매자는 크레딧으로 오픈소스 모델과 외부 모델(Claude Opus·Sonnet·Haiku 등)을 쓴다. 장기 비전은 크레딧이 여러 AI 모델로 환전되는 "컴퓨팅 본위 화폐"가 되는 것이다.
사업 배경·근거·수치·미결정 사항: `docs/BUSINESS_CONTEXT.md` — 판단이 필요할 때 관련 절을 읽고 근거로 쓴다.

구성요소 3개:
1. **서버(coordinator)** — 매장·노드 관리, 작업 배정, 크레딧 원장, 검증, 구매자 API, 외부 모델 환전
2. **Windows 에이전트** — PC방 PC에 설치되어 손님이 없을 때만 추론을 실행
3. **웹** — 사장님·구매자·운영자 화면

## 절대 규칙 (어떤 차수 프롬프트보다 우선한다)
1. **손님 경험 최우선.** 손님 입력이 감지되면 연산을 즉시 멈추고 GPU 메모리를 비운다. 상태가 불확실하면 기본값은 '멈춤'이다. 이 보장을 약하게 하는 변경은 금지.
2. **실제 돈·외부 유료 호출은 기본 꺼짐.** 실결제, 현금 출금, 외부 유료 API 호출은 환경변수로 명시적으로 켜기 전엔 절대 실행되지 않는다. 테스트는 항상 모의 객체를 쓴다. 출금(cash-out)은 법률 검토 전까지 코드상 존재하지 않는다(수동 정산 '기록'만 허용).
3. **돈은 정수, 이동은 원장으로만.** 크레딧·달러·원화는 bigint 최소 단위(µCR, µUSD, 원)로만 다룬다. 부동소수점 금지. 모든 잔액 변화는 이중기입 원장 거래(통화별 합 0)로만 일어난다.
4. **데이터 최소 보관.** 구매자 프롬프트·출력은 로그·메트릭·에러 리포트에 남기지 않는다. 노드에서는 메모리에만 두고 디스크에 쓰지 않는다. 서버 보관은 암호화 + 보존 기한.
5. **사람에게 묻지 않는다.** 사람은 자리에 없다고 가정한다. 애매하면 BUSINESS_CONTEXT와 ADR을 근거로 가장 합리적인 쪽을 고르고 `가정`으로 기록한다. 되돌릴 수 없는 일(실제 돈, 외부 게시, 유료 가입, 사용자 데이터 삭제)은 하지 말고 `HUMAN_TODO.md`에 적는다.
6. **파괴적 작업 금지.** force push, 히스토리 재작성, `git reset --hard`, 저장소 밖 파일 삭제, 비밀값 커밋 금지.
7. **테스트를 속이지 않는다.** 테스트 삭제·skip·기준 완화로 통과시키지 않는다. 환경 때문에 불가능하면 `NEEDS-HUMAN` 또는 `BLOCKED`로 정직하게 기록한다.
8. **문서와 코드가 일치한다.** 문서·보고서·사장님 안내문의 주장은 실제 코드 동작과 같아야 한다. 측정 전인 값은 '목표'라고 쓴다.

## 작업 방식
- 차수 실행 규칙: `prompts/_PROTOCOL.md` (모든 차수 공통)
- 차수 목록·의존성·권장 모델: `prompts/STAGES.md`
- 진행 상태: `PROGRESS.md` · 사람이 할 일: `HUMAN_TODO.md`
- 결정 기록: `docs/adr/NNNN-*.md` · 차수별 계획/보고: `docs/stages/SNN/PLAN.md`, `REPORT.md`

## 기술 스택 (결정됨 — 바꾸려면 ADR로 근거를 남긴다)
| 영역 | 선택 |
|---|---|
| 모노레포 | pnpm workspaces(corepack, 버전 고정), Node.js Active LTS(22 이상), TypeScript strict |
| 서버 | Fastify, zod(경계 검증), Drizzle ORM + SQL 마이그레이션, pino 로깅, `@fastify/websocket` |
| DB | PostgreSQL 16+ · 작업 큐도 Postgres(`FOR UPDATE SKIP LOCKED`, `LISTEN/NOTIFY`) · 운영은 관리형 Postgres 가능(예: Supabase) |
| 테스트(TS) | Vitest, fast-check(속성 기반), embedded-postgres(`DATABASE_URL` 없을 때), Playwright(E2E) |
| 웹 | Next.js(App Router), Tailwind CSS, next-intl(ko 기본), `/api/*`는 Next.js rewrite로 서버에 프록시(같은 출처 쿠키) |
| 에이전트 | Go(현재 안정 버전), Windows 서비스(`golang.org/x/sys/windows/svc`), WebSocket(`github.com/coder/websocket`) |
| 추론 런타임 | llama.cpp `llama-server`(버전 고정, 서명된 배포본) · 개발용 Ollama 어댑터 병행 |
| 프로토콜 | JSON Schema(2020-12)가 단일 진실 원천 → TS(Ajv)·Go(jsonschema) 양쪽 검증 + 계약 테스트 |
| 서명 | ed25519 (모델·런타임·업데이트 매니페스트, 기기 인증) |

## 저장소 구조
```
apps/server       Fastify 서버
apps/web          Next.js 웹 (사장님 /owner · 구매자 /app · 운영자 /ops)
apps/agent        Go 에이전트 (cmd/binjari-agent, cmd/binjari-helper, cmd/binjari-updater, cmd/nodesim)
packages/protocol JSON Schema + TS 타입 + fixtures
packages/shared   돈·ID·시간 유틸
packages/testkit  테스트 DB, 가짜 에이전트, 가상 시계
tools/econ-sim    경제 시뮬레이터
tools/loadgen     구매자 부하 생성기
deploy/  docs/  prompts/  scripts/
```
패키지 이름은 `@binjari/<폴더명>`. Go 모듈은 `binjari/agent`.

## 명령
- `pnpm verify` — 전체 게이트: 포맷 검사, 린트, 타입체크, TS 테스트, (Go가 있으면) `gofmt`·`go vet`·`go test`·Windows 교차 빌드. 모든 차수의 기본 수용 기준.
- `pnpm verify --quick` — 통합 테스트(`*.int.test.ts`) 제외.
- `node scripts/status.mjs ...` — 진행 보드에 상태 보고(`_PROTOCOL.md` 10절). `node scripts/board.mjs` — 사람용 진행 보드. 둘 다 의존성 없는 키트 도구이므로 지우거나 패키지를 추가하지 않는다.
- 차수별 추가 명령은 각 차수 문서와 `docs/stages/SNN/REPORT.md`에 있다.

## 코딩 규칙
- 서버 코드는 주입된 `Clock`으로만 시간을 얻는다(`Date.now()`/인자 없는 `new Date()` 금지, 린트로 강제).
- ID는 UUIDv7. DB 시간은 UTC(timestamptz), 화면 표시는 Asia/Seoul.
- 경계(HTTP, WS, DB, 환경변수)는 zod 또는 JSON Schema로 검증. 에러는 타입이 있는 에러 코드로.
- Go: 모든 I/O에 `context.Context`, 라이브러리 코드에서 panic 금지, 에러는 `%w`로 감싼다. Windows 전용 코드는 빌드 태그로 분리하고, 인터페이스 + 가짜 구현으로 리눅스에서도 테스트한다.
- 코드 주석·커밋 메시지는 영어. 문서·보고서는 한국어. UI 문구는 한국어(i18n 키로).
- 미완성 임시 구현은 `// SKELETON(SNN): <무엇이 대체하는가>` 표시. v0.1 전에 0개가 되어야 한다.

## 운영 제약
- 1인 개발, 저비용 우선, 운영 부담 최소화. 관리형 서비스는 무료·저가 티어 우선.
- 개발·테스트는 Windows/macOS/Linux와 Claude Code 클라우드(리눅스, 네트워크 제한)에서 모두 돌아야 한다. Docker 없이도 테스트가 돌아야 한다.

## 용어
- **크레딧(credit, CR)**: 사업 문서에서 말하는 '토큰'. 코드·UI에서는 항상 '크레딧'. 1 CR = 1,000,000 µCR.
- **모델 토큰**: LLM 입력/출력 단위. 코드에서는 `tokensIn`/`tokensOut`.
- **노드**: 에이전트가 설치된 PC 1대 · **매장**: PC방 1곳 · **사장님(owner)** · **구매자(buyer)** · **운영자(operator)**
- **시도(attempt)**: 작업 하나를 노드 하나가 실행한 1회. 작업은 선점·실패로 여러 시도를 가질 수 있다.
