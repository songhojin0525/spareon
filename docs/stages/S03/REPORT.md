# S03 보고서 — DB 스키마·마이그레이션·테스트 키트

- 상태: DONE
- 커밋 범위: `stage-S03-start..stage-S03-done`
- 시작 / 종료: 2026-10-09 19:26 / 2026-10-10 01:30

## 한 일 (5줄 이내, 사람이 30초 안에 읽을 수 있게)
- v0.1 전체 테이블 36개를 Drizzle 스키마와 검토한 SQL 마이그레이션 4개로 만들었다: 0000 테이블, 0001 불변식 트리거, 0002 앱 역할, 0003 검토 반영. 실수 열과 타임존 없는 시각 열은 없다. 구매자 콘텐츠는 암호문 열에만 둔다.
- 돈·감사 불변식을 DB가 직접 강제한다: 통화별 합 0(커밋 시점), 잔액은 기입에서만 바뀜, 음수 금지, 원장·감사·가격·환율은 추가만 가능, 돈 기록(홀드·수익·정산 기록) 보호. 서버는 최소 권한 역할 `binjari_app`으로 접속하므로 트리거를 끌 수 없다.
- 실행기를 직접 만들었다(up/down, 체크섬, 잠금 대기 상한, 읽기 전용 status). up → down → up 스키마가 같고, TS 스키마와 어긋나지 않는지도 테스트한다.
- 테스트 키트(템플릿 DB 복제·빈 DB·FakeClock·시드 난수), 팩토리, 로컬 전용 시드, 일시적 충돌을 재시도하는 DB 클라이언트(40001·40P01 실제 유도 테스트)를 만들었다.
- 문서: `docs/DB.md`(ERD·불변식 → 강제 위치 표), ADR 0018. CI에 Postgres 16 서비스 잡(`DATABASE_URL` 경로)을 추가했다.

## 실행하는 법 (복사해서 바로 쓰는 명령)
```
pnpm verify                                             # 전체 게이트
pnpm --filter @binjari/server test                      # 서버 DB 테스트(embedded-postgres 자동)
DATABASE_URL=postgres://user:pw@127.0.0.1:5432/postgres pnpm --filter @binjari/server test   # 실제 서버 경로
cd apps/server
DATABASE_URL=... pnpm db:migrate        # 적용
DATABASE_URL=... pnpm db:status         # 적용/대기 목록(읽기 전용)
DATABASE_URL=... pnpm db:rollback --yes [--steps N | --all]
DATABASE_URL=... pnpm db:seed           # 로컬 DB만, 두 번 실행해도 그대로
pnpm db:generate                        # TS 스키마 → 새 마이그레이션 SQL(사람이 검토)
```

## 수용 기준 결과
| # | 기준 | 실행한 명령 | 결과 |
|---|---|---|---|
| 1 | `pnpm verify` 통과. embedded-postgres와 `DATABASE_URL` 양쪽에서 마이그레이션 적용 | `pnpm verify`. embedded-postgres를 별도 서버로 띄우고 `DATABASE_URL=<그 URL> pnpm --filter @binjari/server test`, 같은 URL로 `db:migrate`·`db:status`·`db:seed`(두 번)·`db:rollback --yes --all` 실행 | PASS(9단계, 지휘자가 마무리 전에 다시 실행해 확인). embedded 경로는 전역 설정 템플릿과 `migrate.int.test.ts`에서 확인. `DATABASE_URL` 경로는 그 시점 10개 파일 73개 테스트 통과(검토자가 0003 뒤 다시 돌려 79개 통과). CLI 모두 정상. CI `postgres` 잡(postgres:16 서비스)은 다음 push 때 확인 |
| 2 | 제약 테스트: 합 ≠ 0 커밋 실패, `audit_log` UPDATE 실패, 비허용 계정 음수 실패, 중복 멱등 키 실패 | `test/db/invariants.int.test.ts` | PASS. BJ001이 COMMIT에서 남, `audit_log` 등 7개 표의 UPDATE·DELETE·TRUNCATE가 BJ002(replica 모드에서도), 음수는 23514, 원장·HTTP 멱등 키 중복은 23505 |
| 3 | up → down → up 뒤 스키마가 같다(덤프 비교) | `test/db/migrate.int.test.ts` | PASS. 카탈로그 덤프(표·열·제약·인덱스·트리거·함수·권한)가 문자 단위로 같다. 1~4단계 부분 down → up도 같다. down 뒤 public 객체 0개 |
| 4 | `docs/DB.md`에 ERD와 불변식 표 | `node scripts/check-docs.mjs`, `tools/repo-checks` mermaid 구문 테스트 | PASS. erDiagram과 불변식 표(M1~M11, A1~A4, Q1, C1 → 강제 위치·구현·테스트) |

## 적대적 검토 결과
1차(높음 1, 중간 6, 낮음 7)와 2차(0003 검증, 중간 1).
| 심각도 | 지적 | 조치(고침 / 안 고친 이유) |
|---|---|---|
| 높음 | 앱 역할이 M1을 깰 수 있음: 합 0 기입 → `SET CONSTRAINTS IMMEDIATE` → `OVERRIDING SYSTEM VALUE`로 id=-1인 +1,000,000 기입 → 커밋 성공. 거래별 합 검사가 최대 id 기입에서만 돌았기 때문 | 고침(0003). 기입은 그 거래 안에서 id가 커지는 순서로만 붙도록 BEFORE 트리거가 강제한다(BJ001). 슈퍼유저 재현과 `binjari_app` 재현 모두 회귀 테스트로 막힘 확인 |
| 중간 | M1-b 경합 우회: 아직 커밋 안 된 남의 거래에 기입을 넣으면 BEFORE 트리거가 거래 행을 못 찾아 통과 | 고침(0003). 거래 행이 보이지 않아도 BJ004로 거부. 두 연결로 회귀 테스트 |
| 중간 | M10이 UPDATE 때만 검사됨. INSERT로 바로 정산 연결되거나 다른 매장 정산 기록에 연결 가능 | 고침(0003). 홀드·수익·정산 기록은 INSERT 때 초기 상태만 허용(BJ005). 복합 FK `(node_id, store_id)`, `(attempt_id, job_id, node_id)`, `(payout_record_id, store_id)` 추가. 회귀 테스트 |
| 중간 | 문서가 실제보다 강하게 주장함(탈취된 앱 연결로 돈을 만들 수 없다는 취지). 음수 허용 계정에서 합 0 거래로 CR 발행이 가능 | 고침(문서). DB.md 4절과 ADR 0018에 "M9는 DB가 아니라 S06(거래 종류별 허용 계정)과 대사·감사가 막는다"를 명시. 우회 3건을 막은 사실도 기록 |
| 중간 | DB.md는 `CONCURRENTLY`를 권하는데 실행기는 파일마다 트랜잭션이라 쓸 수 없음 | 문서를 고침. 실행기 제약을 적고, 큰 테이블 변경은 런북 절차(운영자가 CONCURRENTLY로 먼저 만들고 `USING INDEX`·`NOT VALID`+`VALIDATE`로 나눔, S30)로 안내. 파일럿 전에는 표가 비어 해당 없음 |
| 중간 | 큐 인덱스에 `model_id`가 없고, EXPLAIN 테스트가 seqscan을 끈 채 다른 쿼리를 봄(동어반복) | 고침(0003). `jobs_queue_model_idx(model_id, priority DESC, created_at, id) WHERE status='queued'` 추가. 테스트는 통계를 갖춘 약 2만 3천 행에서 실제 claim 쿼리의 플랜이 이 인덱스를 고르는지 확인 |
| 중간(2차) | 0003 첫 판의 열 단위 INSERT 권한 때문에 Drizzle 기입 INSERT(`"id" ... VALUES (default, ...)`)가 `binjari_app`에서 42501로 실패 | 고침. 표 단위 INSERT 권한으로 되돌림(id 순서 트리거만으로 M1 우회가 막힘). `binjari_app`으로 Drizzle 원장 기입이 성공하는 회귀 테스트와, 골라 넣은 id 공격이 BJ001로 막히는 테스트 추가 |
| 낮음 | 실행기 advisory lock 대기에 상한이 없음 | 고침. `pg_try_advisory_lock` 폴링, 상한 기본 120초. 테스트 |
| 낮음 | unlock 실패가 원래 오류를 덮음 | 고침. unlock·연결 종료 오류는 무시 |
| 낮음 | down 파일 체크섬 없음, `db:status`가 DDL 실행 | status는 고침(읽기 전용, 잠금 없음, 테스트). down 체크섬은 안 고침: down은 개발·사고 대응용이고 운영 되돌리기는 새 up으로 한다(DB.md 6절) |
| 낮음 | 오퍼 만료 스윕용 인덱스 없음 | 고침(0003). `job_attempts_offered_sweep_idx` |
| 낮음 | M4 대사용 활성 홀드 부분 인덱스 없음 | 고침(0003). `holds_active_account_idx`. 기입 계정 인덱스의 `INCLUDE (amount)`는 S06이 측정한 뒤 판단 |
| 낮음 | 시드가 빈 호스트·`host=` 파라미터를 로컬로 판정 | 고침. testkit과 같은 보수적 판정. 테스트 |
| 낮음 | `electricity_won_per_kwh`가 정수 원이라 소수 요금에서 오차 | 안 고침: 오차가 kWh당 0.5원 이하이고 열 이름 변경은 drizzle-kit이 대화형 확인을 요구함. S07에서 필요하면 밀리원으로 바꾼다(가정) |
| 낮음 | `sessions.ip_hash`(bytea)와 `audit_log.ip_hash`(hex text) 형식 불일치 | 안 고침: 두 값을 조인할 쿼리가 아직 없다. S05가 IP 해시 유틸을 만들 때 통일한다 |

## 가정 (사람이 나중에 확인할 것)
| 가정 | 근거 | 틀리면 바꿀 곳 |
|---|---|---|
| 팩토리는 testkit이 아니라 `apps/server/src/testing`에 둔다 | Drizzle 타입을 써야 스키마 변경이 컴파일 오류로 드러난다. testkit → server는 순환 의존 | `packages/testkit`, 각 차수 테스트 |
| 역할 생성 권한(`CREATEROLE`)이 없는 DB에서는 마이그레이션이 실패한다(조용히 건너뛰지 않음) | 건너뛰면 서버가 소유자 권한으로 돌아 DB 보호가 사라진다 | `0002_app_role.sql`, S30 런북 |
| M9(크레딧 발행 경로)는 DB가 아니라 S06 원장 서비스와 대사가 막는다 | DB는 합 0·음수 금지·기록 불변까지만 보장. 앱 역할은 음수 허용 계정을 만들 수 있다 | S06 `LEDGER.md`, 대사 |
| 배포 전이라 검토 반영을 새 마이그레이션 0003으로 추가했다(0000~0002 체크섬 유지). 0003은 2차 검토 반영 때 한 번 고쳐 썼다 | 어떤 운영 DB에도 적용된 적이 없다 | — |
| 마이그레이션 파일에서는 `CREATE INDEX CONCURRENTLY`를 쓸 수 없다. 큰 테이블 변경은 런북 절차로 나눈다 | 실행기는 파일당 트랜잭션으로 단순하게 유지 | `migrate.ts`, S30 |
| 전기요금은 정수 원/kWh | 오차 0.5원/kWh 이하 | S07에서 밀리원 열로 변경 |
| 시드 사용자는 로그인할 수 없는 비밀번호 표시값, 시드 환율 USD/KRW 1,400은 개발용 가짜 값 | S05 전에는 진짜 해시가 없다. 실제 시세가 아님을 `source`에 적음 | `src/db/seed.ts` |
| 앱 역할이 기입 id를 직접 고를 수는 있다(큰 id를 골라 미래 identity 값과 충돌시키는 서비스 방해는 가능) | Drizzle INSERT 호환. 돈 우회는 id 순서 트리거가 막는다 | 0003, S28 감사 |

## 사람이 확인할 것 (HUMAN_TODO에도 추가함)
- 다음 push 뒤 CI의 새 `postgres` 잡(Postgres 16 서비스, `DATABASE_URL` 경로)이 초록인지 확인.
- 운영 DB를 고를 때 관리 계정에 `CREATEROLE`이 있는지 확인(S30 전).

## 막힌 것
| 증상 | 시도한 것 | 추정 원인 | 사람이 확인할 것 |
|---|---|---|---|
| (해결된 우회) drizzle-kit `pushSchema`로 드리프트 검사 시 42P02 뒤 `process.exit(1)` | drizzle-kit/api 직접 호출 | drizzle-kit 내부 조회가 우리 CHECK 식을 다루지 못함 | 없음. drizzle-kit이 TS에서 만든 SQL을 빈 DB에 적용해 카탈로그끼리 비교하는 방식으로 바꿈(PLAN 위험 항목대로) |

## 다음 차수에 미치는 영향
- S06: 잔액은 기입 트리거가 갱신하므로 원장 서비스는 기입만 쓴다. 잠금 순서는 계정 ID 순 `FOR UPDATE`. 한 거래의 기입은 같은 DB 트랜잭션에서 id 순서대로 넣는다(Drizzle 기본 동작). M9(발행 경로)와 M4·M11 대사는 S06 몫. 거래 종류 CHECK 목록은 S06이 확정한다.
- S05·S12·S13·S15·S16: 테이블과 상태 이름은 ARCHITECTURE 5절과 일치한다. 구매자 콘텐츠는 `job_payloads`·`batch_files` 암호문 열에만 둔다. 이름에 콘텐츠를 암시하는 열을 새로 만들면 `schema.int.test.ts`가 실패한다.
- 새 테이블을 만드는 차수: 그 마이그레이션에서 `binjari_app` 권한을 정해야 한다(`roles.int.test.ts`가 강제). down 파일도 함께 쓴다.
- S30: 서버는 `binjari_app` 멤버인 로그인 역할로 접속하고, 마이그레이션은 소유자 계정으로 돌린다(런북). 운영 DB의 `CREATEROLE`을 확인해야 한다.
- 테스트: 서버 통합 테스트는 `openTestDb()`(템플릿 복제), 마이그레이션 테스트는 `openTestDb({ empty: true })`, 데이터는 `createFactories({ db, clock: FakeClock, random: createSeededRandom })`로 만든다.
- S04·S09·S10·S12·S13·S17~S22: S03 진행 중에 사람의 결정으로 ADR 0019(AMD GPU를 Vulkan 시험 노드로 지원)가 추가됐다. 차수 문서의 'NVIDIA 전용' 문구보다 ADR 0019가 우선한다. DB에는 아직 반영할 열이 없다(노드 GPU 요약은 `nodes.gpu_summary` jsonb). 백엔드별 배정·검증 조건은 S09·S12·S13이 정한다.

## 수치
- 서버 테스트 80개(10개 파일): 스키마 7, 클라이언트 5, 재시도·오류 단위 12, 실행기·드리프트·CLI 19, 불변식 17, 역할 7, 팩토리·가드·시드 7, 기존 app·config 6.
- 전체 verify 기준 테스트: testkit 39, protocol 526, shared 17, web 2, repo-checks 166, server 80. `pnpm verify`는 약 3~4분(test 단계 약 2.5분).
- 속성 테스트: 시드 20261009 고정, 40회 실행. 매회 잔액 = 기입 합, CR 총합 0, 음수 불가 계정 음수 0건, 실패한 거래는 잔액 무변화.
- 마이그레이션 4개, 표 36개, 트리거 31개(제약 트리거 2개 포함), 부동소수점·numeric·타임존 없는 시각 열 0개.
- 큐 EXPLAIN: 약 2만 3천 행 + ANALYZE 상태에서 claim 쿼리가 `jobs_queue_model_idx`를 선택.

## 선택 확장 결과
- DB 역할 분리(선택 확장 1)는 검토 포인트 '다른 연결 역할'에 대한 답이라 본 작업(0002, 0003)에 포함했다. 우회 시도 테스트 7개.
- `presence_intervals` 월 단위 파티셔닝 설계는 하지 않았다(노드당 열린 구간 고유 인덱스만 있음). 목표 90일 보존과 파일럿 규모(1~3곳)에서는 필요 없다. S29 보존 작업 때 재검토.
- 별도: `tools/repo-checks/test/mermaid-syntax.test.ts`의 mermaid 로드 대기를 60초에서 180초로 늘렸다. 모든 패키지 테스트가 병렬로 돌 때 라이브러리 로드만 60초를 넘겨 실패한 일이 있었다. 단언 기준은 그대로다.
