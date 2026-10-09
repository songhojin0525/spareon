# 0018. 돈·감사 불변식은 DB 트리거·제약·최소 권한 역할로도 강제하고, 마이그레이션은 drizzle-kit으로 생성해 자체 실행기(up/down·체크섬)로 적용한다

- 상태: 채택
- 날짜: 2026-10-10
- 차수: S03

## 맥락
- 절대 규칙 3: 돈은 정수, 모든 잔액 변화는 이중기입 원장 거래로만. ARCHITECTURE 9.5의 M1~M11 중 일부는 'DB 제약'으로 강제하기로 했다(ADR 0005).
- 서버 버그·잘못된 수동 쿼리·탈취된 앱 연결이 원장을 바꾸면 10분 대사까지 틀린 잔액으로 돈이 나간다(THREAT_MODEL DATA-02).
- 1인 운영: 운영 DB는 관리형 Postgres(무료·저가 티어)일 수 있고, 테스트는 Docker 없이 embedded-postgres와 `DATABASE_URL` 양쪽에서 돌아야 한다.
- 스택은 Drizzle ORM + SQL 마이그레이션(CLAUDE.md). drizzle-kit은 SQL을 만들지만 down 마이그레이션이 없고, 내장 실행기는 적용 기록이 해시뿐이다.
- 차수 문서(S03)의 테이블 목록은 S01 설계(ARCHITECTURE 5절 상태 이름, D2·D3·D13·D14, ADR 0010)보다 먼저 쓰여 일부가 어긋난다.

## 결정
1. **잔액은 DB가 유도한다.** `ledger_postings` INSERT 트리거가 같은 트랜잭션에서 `account_balances`를 갱신하고, 그 밖의 쓰기는 거부한다. 음수 금지는 `allow_negative`를 복합 FK로 복사한 CHECK다.
2. **통화별 합 0은 지연 제약 트리거 두 개**(거래마다·기입마다)로 커밋 시점에 검사하고, 기입은 거래를 만든 DB 트랜잭션 안에서만 붙일 수 있다(`created_xid`).
3. **추가 전용·불변 테이블**(원장 3종, `audit_log`, 가격표 2종, 환율)은 UPDATE·DELETE·TRUNCATE를 트리거로 거부한다. `holds`·`earnings`·`payout_records`는 상태만 바뀌고 금액·주체는 고정, 삭제 금지, 끝난 상태는 최종(트리거). 모든 불변식 트리거는 `ENABLE ALWAYS`.
4. **최소 권한 역할 `binjari_app`**: 서버는 테이블 소유자가 아닌 이 역할의 멤버로 접속한다. 추가 전용 테이블은 SELECT·INSERT, 잔액은 SELECT, 돈 기록은 DELETE 없음, DDL·TRUNCATE·TRIGGER 없음 → 트리거를 끄거나 지울 수 없다.
5. **트리거는 불변식에만.** 어떤 거래를 만들지(종류별 계정 이동, 잠금 순서, 멱등 재실행)는 S06 원장 서비스가 정한다.
6. **마이그레이션**: drizzle-kit `generate`로 SQL·스냅숏을 만들고 사람이 다듬는다. 트리거·권한은 `--custom` 빈 마이그레이션에 손으로 쓴다. 적용은 자체 실행기(`src/db/migrate.ts`): 저널 순서, 파일당 트랜잭션, 체크섬 기록·변조 거부, advisory lock, `drizzle/down/<tag>.sql`로 down. up → down → up 덤프 비교와 TS 스키마 드리프트 검사를 테스트로 둔다.
7. **명세와 다르게 한 것**: 상태 이름은 ARCHITECTURE 5절을 따른다(노드 `pending`·`excluded`, 수익 `held`·`under_review`·`payout_recorded`·`settled` 등). 통화에 `TCR`(D2). 구매자 콘텐츠는 `jobs`가 아니라 `job_payloads`(암호문·보존 기한·행 삭제로 파기, ADR 0010). 지문은 `fp_store`·`fp_global`(D3)과 `UNIQUE(store_id, fp_store)`. `params_b`·`score`·`reputation` 실수 대신 `params_millions`·`score_ppm`·`reputation_ppm` 정수(부동소수점 열 0개). 홀드는 도메인 테이블을 FK로 참조하지 않는다(`purpose`, `reference_id`). 시각 열에 DB `now()` 기본값 없음(주입된 Clock). 열거형은 `text + CHECK`. 팩토리는 testkit이 아니라 서버(`src/testing/`)에 둔다(Drizzle 타입을 써야 하고, testkit → server는 순환).

## 검토한 대안
| 대안 | 장점 | 단점 | 버린 이유 |
|---|---|---|---|
| 잔액을 앱(S06)이 갱신하고 대사로만 확인 | 트리거 없음, 단순 | 원장 밖 잔액 변경을 DB가 못 막는다. 대사 주기 동안 틀린 잔액으로 돈이 나감 | DATA-02 완화가 약하다 |
| 잔액 테이블 없이 매번 `SUM(postings)` | 캐시 불일치 불가 | 홀드·캡처마다 계정 전체 합산, 음수 금지를 CHECK로 못 건다 | 처리량 목표(초당 캡처 200)와 M3 DB 강제를 함께 못 맞춘다 |
| 합 0 검사를 앱만 | 트리거 비용 없음 | 버그 하나로 돈이 생긴다 | 절대 규칙 3의 마지막 방어선이 없어진다 |
| Postgres RLS·뷰로 쓰기 제한 | 선언적 | 정책이 트리거보다 복잡, 소유자는 우회 | 권한(GRANT) + 트리거로 충분하고 테스트가 쉽다 |
| drizzle-orm 내장 migrator | 코드 없음 | down 없음, 기록이 해시뿐, 변조 감지 없음 | 수용 기준 3(up → down → up)과 운영 추적성 |
| 별도 도구(dbmate, graphile-migrate 등) | 검증된 실행기 | 새 의존성·바이너리, Windows·클라우드 환경 차이 | 실행기는 250줄이고 통합 테스트로 덮을 수 있다 |
| Postgres enum 타입 | 타입 안전 | 값 제거·down이 어렵다 | `text + CHECK`로 같은 보장 |
| `pushSchema`(drizzle-kit/api)로 드리프트 검사 | 공식 비교 | 우리 CHECK 식을 읽다가 42P02로 실패하고 `process.exit` | drizzle-kit이 만든 SQL을 빈 DB에 적용해 카탈로그끼리 비교 |

## 결과와 트레이드오프
- 쉬워지는 것: 앱 버그·잘못된 수동 쿼리·탈취된 앱 연결로는 원장 기록을 고치거나 지우거나, 합이 0이 아닌 거래를 만들거나, 음수 불가 계정을 마이너스로 만들 수 없다. S06은 '어떤 거래를 만드는가'에만 집중한다.
- 어려워지는 것: 기입마다 잔액 UPDATE(같은 계정에 동시 기입이 몰리면 행 잠금 경합 — 핫 계정 분할 `shard` 열로 대비, S06이 측정). 잘못 들어간 원장 기록은 고칠 수 없고 역분개(`REVERSAL`)로만 바로잡는다. 새 테이블마다 권한 결정을 마이그레이션에 써야 한다(테스트가 강제).
- 운영 제약: 서버가 소유자 계정으로 접속하면 4번의 보호가 사라진다(S30 런북). 역할 생성 권한이 없는 DB에서는 마이그레이션이 실패한다.
- 되돌리는 비용: 트리거·역할은 0001·0002의 down으로 제거 가능. 잔액 유도 방식을 앱 갱신으로 바꾸려면 S06 원장 서비스와 대사 수정이 필요하다.

## 재검토 조건
- S06 부하 측정에서 기입 트리거 또는 잔액 행 경합이 처리량 목표를 못 맞출 때(→ 핫 계정 분할, 또는 잔액을 배치로 유도).
- 운영 DB가 역할 생성을 허용하지 않을 때(→ 사람이 역할을 미리 만드는 런북, 또는 권한 모델 재설계).
- drizzle-kit이 down 마이그레이션이나 체크섬 기록을 지원하게 될 때(→ 자체 실행기 대체 검토).
- 다중 리전·논리 복제를 도입할 때(`ENABLE ALWAYS` 트리거가 구독자에서도 돈다는 점 재검토).
