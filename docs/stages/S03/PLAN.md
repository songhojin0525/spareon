# S03 계획 — DB 스키마·마이그레이션·테스트 키트

## 목표 요약
v0.1이 쓸 PostgreSQL 스키마를 Drizzle(TS)로 정의하고, drizzle-kit이 만든 SQL을 검토·다듬어 `apps/server/drizzle/`에 둔다. 돈과 감사 기록의 불변식(통화별 합 0, 추가 전용, 음수 잔액 금지, 멱등 키 고유, 정산 연결 규칙)은 **DB 제약·트리거로도** 강제한다. 마이그레이션은 up/down이 있고 up → down → up 뒤 스키마 덤프가 같다. 테스트 키트는 마이그레이션이 적용된 템플릿 DB를 한 번 만들고 파일마다 복제한다. 팩토리·가상 시계·시드 고정 난수·개발용 시드 스크립트를 더한다.

## 핵심 설계 결정 (대안 → 선택 → 스스로 반박)

### D-a. 마이그레이션 실행기는 직접 만든다 (drizzle-kit은 생성기로만)
- drizzle-kit `generate`로 SQL과 스냅숏(`drizzle/meta`)을 만들고, 사람이 읽을 수 있게 다듬는다. 트리거·함수는 `drizzle-kit generate --custom`으로 만든 빈 마이그레이션에 손으로 쓴다(저널 순서 유지).
- 적용은 `apps/server/src/db/migrate.ts`: 저널 순서대로, 파일마다 한 트랜잭션, `binjari_meta.migrations`에 태그·SHA-256 체크섬 기록, 적용된 파일이 바뀌면 거부, advisory lock으로 동시 실행 방지. down은 `drizzle/down/<tag>.sql`을 역순으로.
- 대안: drizzle-orm 내장 migrator. 버림: down이 없고, 적용 기록이 해시만이라 어떤 파일인지 알기 어렵다. 반박: "직접 만든 실행기는 버그 위험" → 실행기 자체를 통합 테스트(체크섬 변조 거부, 부분 실패 롤백, 동시 실행, down 순서)로 덮는다.

### D-b. 스키마 일치 검사 두 겹
1. up → 전체 down → up 뒤 카탈로그 덤프(테이블·열·제약·인덱스·트리거·함수·권한)가 처음 up과 같다(수용 기준 3). `pg_dump` 바이너리에 기대지 않고 카탈로그 질의로 덤프한다(embedded-postgres에 pg_dump가 없을 수 있고 `DATABASE_URL` 환경에서도 같게 돌아야 함).
2. 드리프트 검사: 마이그레이션을 적용한 DB와 Drizzle TS 스키마를 `drizzle-kit/api`의 `pushSchema`로 비교해 바꿀 문장이 없어야 한다(손으로 다듬은 SQL과 TS가 어긋나면 실패). 도구가 표현하지 못하는 차이가 나오면 그 항목만 명시적 허용 목록으로 둔다.

### D-c. 잔액은 DB가 기입에서 유도한다 (account_balances = 기입 합의 캐시)
- `ledger_postings` INSERT 트리거가 같은 트랜잭션에서 `account_balances.balance += amount`, `version += 1`을 한다. `account_balances`를 직접 INSERT·UPDATE·DELETE·TRUNCATE하면 거부한다(트리거 안에서만 허용 — `pg_trigger_depth()`).
- `allow_negative`를 `account_balances`에 복합 FK `(account_id, currency, allow_negative)`로 복사하고 `CHECK (allow_negative OR balance >= 0)` — 음수 잔액은 기입 INSERT 순간 실패한다.
- 대안: 앱(S06)이 잔액을 갱신하고 대사로만 확인. 버림: DATA-02(원장 밖 잔액 변경)를 DB가 막지 못하고 10분 대사까지 틀린 잔액으로 돈이 나간다. 반박: "트리거에 비즈니스 로직 금지" → 이 트리거는 '잔액 = 기입 합'(M2) 불변식을 유지하는 기계적 합산뿐이고, 어떤 거래를 만들지는 S06이 정한다. 잠금 순서(계정 ID 순 `FOR UPDATE`)는 S06이 기입 전에 먼저 잡으면 그대로 유지된다.

### D-d. 통화별 합 0은 지연 제약 트리거 두 개 + 같은 트랜잭션 규칙
- `ledger_transactions` AFTER INSERT 지연 트리거: 커밋 때 기입이 있고 통화별 합이 0인지.
- `ledger_postings` AFTER INSERT 지연 트리거: 같은 검사(`SET CONSTRAINTS ... IMMEDIATE` 뒤 기입을 더 붙이는 우회 차단). 한 거래에 기입이 많을 때 O(k²)이 되지 않게 그 거래의 마지막 기입(최대 id)에서만 합을 계산한다.
- 기입은 거래를 만든 DB 트랜잭션 안에서만 붙일 수 있다(`ledger_transactions.created_xid = pg_current_xact_id()`를 트리거가 강제로 채우고 기입 INSERT 때 비교). 이미 커밋된 옛 거래에 '합 0인 쌍'을 몰래 붙이는 위조를 막는다.

### D-e. 추가 전용·불변 테이블
`ledger_transactions`·`ledger_postings`·`audit_log`·`ledger_accounts`·`price_versions`·`price_entries`·`fx_rates`: UPDATE·DELETE는 행 트리거, TRUNCATE는 문장 트리거로 거부. 트리거는 `ENABLE ALWAYS`로 걸어 `session_replication_role = replica`에서도 동작한다. 가격표·환율은 작업·거래가 버전 ID로 참조하므로 고치면 과거 과금 근거가 바뀐다 → 새 버전만 추가.

### D-f. DB 수준 돈 제약 (CHECK·FK로 표현 가능한 것은 트리거 없이)
- 계정 종류별 허용 통화(M8: 정산 처리 중·외부 환전 정산은 CR만, 준비금 등은 KRW), 종류별 소유자 유형, 음수 허용은 비용·출처·변환 계정만. 기입 통화 = 계정 통화(복합 FK).
- 홀드: `captured + released <= amount`, 끝난 홀드는 `captured + released = amount`.
- 수익: 정산 기록 연결은 CR이고 상태가 `payout_recorded`·`settled`일 때만, 연결은 `matured`에서 한 번만(M10, 트리거). 시도당 수익 1건(UNIQUE).
- 금액은 모두 `bigint`. 열 타입 검사 테스트가 `numeric`·`real`·`double precision`·`money`·`timestamp without time zone`이 없음을 확인한다.

### D-g. 명세에서 바꾸거나 더한 것 (ADR 0018에 기록)
- 상태 이름은 ARCHITECTURE 5절을 따른다(노드 `pending`·`excluded`, 수익 `held`·`under_review`·`payout_recorded`·`settled`, 릴리스 `signed`·`rolling_out`·`revoked` 등). 통화에 `TCR`(D2).
- 구매자 콘텐츠는 `jobs`가 아니라 `job_payloads`(암호문만, 보존 기한 열, 행 삭제로 파기)에 둔다. `jobs`에는 길이·토큰 수 같은 메타데이터만 남는다(ADR 0010, 큐 테이블을 작게).
- 지문은 `fp_store`·`fp_global` 두 개(D3), `UNIQUE (store_id, fp_store)`. 해시·공개키는 프로토콜과 같은 소문자 hex 문자열(CHECK).
- `stores.verified_at`(D13), `stores.accept_tcr_jobs`(D14), 노드 `eligible` 속성(5.1).
- `params_b`(소수) 대신 `params_millions`(정수), `score`(실수) 대신 `score_ppm`, 평판은 `reputation_ppm`. 부동소수점 열 0개.
- 홀드는 도메인 테이블을 FK로 참조하지 않는다(`purpose`, `reference_id` + UNIQUE). 원장은 다른 도메인을 모른다(ARCHITECTURE 2.2).
- 시각 열에 DB 기본값 `now()`를 두지 않는다. 서버는 주입된 `Clock`으로 값을 넣는다(가상 시계 테스트). 예외: 마이그레이션 기록.
- 열거형은 Postgres enum 대신 `text + CHECK`(값 추가·down이 쉬움).
- ID는 앱이 만든 UUIDv7. 예외: `ledger_postings`·`outbox_events`는 `bigint identity`(순서가 의미 있고 외부에 노출되지 않음).

### D-h. 테스트 키트
- `createTestDatabaseSetup({ prepareTemplate })`: 전역 설정이 템플릿 DB를 만들고 훅(서버는 마이그레이션 적용)을 한 번 실행. `defineBinjariVitestConfig({ useTestDatabase, globalSetup })`로 패키지가 자기 설정 파일을 지정.
- `createIsolatedDatabase({ empty: true })`: 마이그레이션 테스트용 빈 DB.
- `FakeClock`(set·advance, 구조적으로 서버 `Clock` 호환), `createSeededRandom(seed)`(sfc32, 결정적), `dumpSchema(client)`.
- **팩토리는 서버(`apps/server/src/testing/`)에 둔다**(명세는 testkit). 이유: 팩토리는 Drizzle 테이블 타입을 써야 스키마가 바뀔 때 컴파일 오류로 드러난다. testkit이 서버를 import하면 순환 의존(server devDep → testkit → server)이 생긴다. testkit에는 스키마를 모르는 일반 도구만 둔다. (가정으로 기록)

### D-i. DB 역할 분리 (선택 확장을 본 작업에 포함 — 검토 포인트 '다른 연결 역할'의 답)
- 마이그레이션이 `binjari_app` 역할(NOLOGIN 그룹 역할)을 만들고 권한을 준다: 원장 추가 전용 테이블은 SELECT·INSERT만, `account_balances`는 SELECT만, 그 밖은 SELECT·INSERT·UPDATE·DELETE. DDL·TRUNCATE·TRIGGER 권한 없음, 테이블 소유자 아님 → 트리거 비활성화 불가. 운영 로그인 역할은 `binjari_app`의 멤버로 만든다(S30, 런북).
- 역할은 클러스터 전역이라 동시 생성 경합(duplicate_object)을 잡는다. down은 이 DB의 권한만 회수하고 역할은 지우지 않는다(다른 DB가 쓸 수 있음).

## 새 의존성
- `drizzle-orm` 0.45.3 (Apache-2.0), `drizzle-kit` 0.31.11 (MIT): 스택 결정(CLAUDE.md). 두 버전은 같은 날(2026-09-21) 나온 짝. 0.45.4는 하루 전 출시라 피했다.
- `pg`·`@types/pg`(이미 catalog)를 서버 의존성에 추가. `fast-check`(이미 catalog)를 서버 devDependency에.

## 위험
- `pushSchema`가 CHECK 식 표기 차이를 변경으로 볼 수 있다 → 체크포인트 4에서 실제로 돌려 보고, 안 되면 스냅숏 기반 검사로 바꾼다.
- 역할 생성 권한이 없는 관리형 DB(Supabase 등) → 마이그레이션이 실패하지 않게 `CREATEROLE`이 없으면 역할 생성을 건너뛰고 알림(NOTICE)만. 권한 부여는 역할이 있을 때만.
- 트리거 비용(기입마다 잔액 UPDATE) → 지금 처리량 목표(초당 캡처 200)에서는 앱이 직접 해도 같은 비용. S06이 측정.
- 템플릿 DB에 연결이 남아 있으면 `CREATE DATABASE ... TEMPLATE`이 실패 → 마이그레이션 함수가 풀을 닫는지 테스트.

## 체크포인트
| # | 내용 | 검증 |
|---|---|---|
| 1 | 테스트 키트 확장: 템플릿 준비 훅, 빈 DB 옵션, FakeClock, 시드 난수, 스키마 덤프 | testkit 단위·통합 테스트 |
| 2 | DB 클라이언트(`client.ts`: 풀, 트랜잭션 헬퍼, 직렬화 실패·교착 재시도) | 서버 통합 테스트(실제 40001 유도) |
| 3 | Drizzle 스키마 전체 + drizzle-kit 설정 + 생성 SQL 검토본(0000) | typecheck, 생성 SQL 적용 |
| 4 | 불변식 마이그레이션(트리거) + 실행기(up/down/체크섬/잠금) + CLI(`db:migrate`·`db:rollback`) + 템플릿에 적용 | 제약 테스트(수용 2), up→down→up 덤프 비교(수용 3), 드리프트 검사 |
| 5 | 앱 역할 분리 + 우회 시도 테스트 | 역할로 UPDATE·DISABLE TRIGGER·잔액 직접 변경 실패 |
| 6 | 팩토리 + 시드 스크립트(`db:seed`) | 팩토리 통합 테스트, 시드 두 번 실행 |
| 7 | `docs/DB.md`(ERD·불변식 표), ADR 0018, ARCHITECTURE·README 갱신, CI에 Postgres 서비스(`DATABASE_URL` 경로) | check-docs, `pnpm verify`, `DATABASE_URL`로 서버 테스트 |
