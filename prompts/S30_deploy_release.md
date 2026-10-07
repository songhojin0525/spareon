# S30 · 배포·릴리스 파이프라인

| 항목 | 값 |
|---|---|
| 의존 | S29 |
| 권장 모델 | Sonnet 5.5 |
| 규모 | L |
| 사람 필요 | 끝에 필수 — 계정 생성, 도메인, 비밀값 입력, 실제 첫 배포 |

이 차수는 `prompts/_PROTOCOL.md`를 따른다.

## 목표
창업자가 체크리스트만 따라 하면 첫 배포가 되도록 모든 것을 준비한다: 컨테이너, 운영 설정, 웹 배포 설정, 아티팩트 저장소, 에이전트 릴리스 자동화, 마이그레이션, 비용 추정. 1인 운영에 맞게 단순하게: 서버 1대(VPS) + 관리형 Postgres + 웹 호스팅 + S3 호환 저장소.

## 먼저 읽을 것
- `CLAUDE.md`(운영 제약), `docs/OPERATIONS.md`, `docs/KEY_MANAGEMENT.md`, `docs/UPDATES.md`, `docs/WEB.md`, `docs/GATEWAY.md`(다중 인스턴스·LISTEN/NOTIFY)

## 산출물
- `apps/server/Dockerfile`(다단계, 비루트, 헬스체크), `deploy/compose.prod.yml`(서버 + Caddy, 선택적 자체 Postgres), `deploy/Caddyfile`(TLS, WebSocket)
- `docs/ENV.md` — 모든 환경변수 표(서버 zod 스키마에서 자동 생성, 생성물 최신성 검사)
- 웹 배포 설정(Vercel 기준 — `SERVER_URL`, rewrite)과 대안 문서
- `.github/workflows/release.yml` — 태그 시: 에이전트 Windows 빌드·MSI(S21) → (인증서 있으면) 서명 → SHA-256 → 저장소 업로드 → 서버에 릴리스 초안 등록(서명은 오프라인 키 절차 — KEY_MANAGEMENT 참조, CI에 서명 개인키를 두지 않는 방식이면 "서명 대기" 상태로 등록)
- `scripts/deploy-dryrun.mjs` — 새 임시 DB에 마이그레이션 → 운영과 같은 설정으로 서버 부팅 → 헬스체크 → 종료
- `docs/DEPLOY.md` — 첫 배포 체크리스트(사람용, 한국어, 단계별), 업데이트 배포, 롤백, 비용 추정 표

## 상세 요구사항

### 1. 운영 구성
- 서버: VPS 1대에 Docker Compose(서버 + Caddy). 운영 모드에서 개발 기능 시작 거부(S05) 재확인.
- DB: 관리형 Postgres(예: Supabase). **주의 문서화**: 연결 풀러의 트랜잭션 모드에서는 `LISTEN/NOTIFY`가 동작하지 않으므로, 서버의 LISTEN 연결은 직접 연결 또는 세션 모드를 써야 한다. 일반 쿼리 풀과 LISTEN 전용 연결을 분리하는 설정(`DATABASE_URL`, `DATABASE_LISTEN_URL`)을 구현.
- 저장소: S3 호환(예: Cloudflare R2 — 송신 비용 측면 검토, '확인 필요'). 아티팩트는 서명 URL로.
- 웹: Vercel(또는 대안), `SERVER_URL` 환경변수, 같은 출처 rewrite 동작 확인 방법.
- 마이그레이션: 배포 전 별도 1회 실행 단계(서버 시작과 분리), 실패 시 배포 중단.
- 무중단에 가깝게: 서버 드레인(S11) 후 재시작, 에이전트는 자동 재연결.

### 2. 비밀값
- `.env.production.example`(키 이름과 설명만), 실제 값은 서버의 파일·비밀 관리에. 서명 개인키는 서버에 두지 않는다(KEY_MANAGEMENT).

### 3. 비용 추정 (`docs/DEPLOY.md`)
- 항목별(VPS, 관리형 DB, 저장소·송신, 웹 호스팅, 도메인, 코드 서명 인증서) 무료·저가 티어 기준 월 비용 범위 — **가격은 웹에서 확인 가능하면 날짜와 출처, 불가하면 '확인 필요'**. 파일럿(1~3매장)과 30매장 두 단계.

### 4. 첫 배포 체크리스트 (사람이 할 일 — HUMAN_TODO에 링크)
- 계정 만들기(서버, DB, 저장소, 웹, 도메인), 비밀값 생성 명령(이 저장소의 CLI), DNS 설정, 첫 운영자 계정 CLI 생성, 서명 키 생성·보관, 첫 모델·런타임 등록, 첫 에이전트 릴리스 서명·등록, 백업 설정, 알림 연결 — 각 단계에 "성공 확인 방법".

## 하지 말 것
- 실제 클라우드 계정 생성·결제·배포(사람이 한다)
- CI에 서명 개인키 저장

## 수용 기준
1. `pnpm verify` 통과
2. Docker가 있으면 `docker build` 성공·이미지 헬스체크 통과(없으면 NEEDS-HUMAN 기록), compose 파일 검증
3. `node scripts/deploy-dryrun.mjs` 성공(운영과 같은 설정 검증, LISTEN 연결 분리 포함)
4. `docs/ENV.md` 자동 생성·최신성 테스트, 릴리스 워크플로 문법 검증
5. `docs/DEPLOY.md` 체크리스트·비용 표 완성, HUMAN_TODO 추가, 상태 `DONE_NEEDS_HUMAN`

## 적대적 검토 포인트
- 운영 이미지에 개발 도구·테스트 비밀값 포함
- 마이그레이션 실패 시 반쯤 배포된 상태
- 저장소 버킷 공개 설정 실수

## 선택 확장
- 스테이징 환경 구성 가이드(같은 compose, 다른 비밀값)
- 서버 2대 구성으로 넘어가는 시점과 절차 문서
