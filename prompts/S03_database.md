# S03 · DB 스키마·마이그레이션·테스트 키트

| 항목 | 값 |
|---|---|
| 의존 | S01 |
| 권장 모델 | Opus 5.5 |
| 규모 | L |
| 사람 필요 | 없음 |

이 차수는 `prompts/_PROTOCOL.md`를 따른다.

## 목표
v0.1 전체가 쓸 PostgreSQL 스키마를 한 번에 제대로 설계한다. 돈과 감사 기록의 불변식은 애플리케이션만 믿지 않고 **DB 제약으로도** 강제한다. 테스트가 빠르고 서로 독립적으로 돌도록 테스트 키트를 완성한다.

## 먼저 읽을 것
- `docs/ARCHITECTURE.md`(상태 기계, 데이터 보존 표), ADR 0005·0007·0008·0009·0010, `docs/BUSINESS_CONTEXT.md` 6·10절

## 산출물
- `apps/server/src/db/schema/*.ts`(Drizzle), `apps/server/drizzle/`(SQL 마이그레이션, 사람이 읽을 수 있게 검토된 상태)
- `apps/server/src/db/client.ts`(풀, 트랜잭션 헬퍼, 재시도 유틸)
- `docs/DB.md` — ERD(mermaid), 테이블별 설명, 불변식 목록과 강제 위치(DB 제약 / 앱)
- `packages/testkit` 확장 — 마이그레이션이 적용된 템플릿 DB, 테스트 파일별 격리 DB, 팩토리, 가상 시계
- 개발용 시드 스크립트(`pnpm --filter @spareon/server db:seed`)

## 상세 요구사항

### 1. 테이블 (최소 목록 — 더 나은 설계가 있으면 ADR로 근거를 남기고 바꾼다)
- 사람·인증: `users`(id, email(대소문자 무시 고유), password_hash, role: operator | owner | buyer, display_name, locale, terms_version, terms_accepted_at, disabled_at, created_at), `sessions`, `api_keys`(prefix, hash, scopes, rate_limit, last_used_at, revoked_at), `idempotency_keys`(key, scope, request_hash, response, expires_at)
- 매장·노드: `stores`(owner_id, name, timezone 기본 Asia/Seoul, electricity_won_per_kwh, policy jsonb, policy_version, paused_at), `enrollment_codes`(store_id, code_hash, kind: single | image, max_uses, uses, expires_at, revoked_at), `nodes`(store_id, display_name, device_pubkey, hw_fingerprint_hmac, state, last_seen_at, agent_version, runtime_version, os_build, gpu_summary jsonb, reputation, quarantined_at, quarantine_reason, disabled_at), `node_events`(감사·디버그용), `presence_intervals`(node_id, kind: eligible | customer | paused | offline, started_at, ended_at — 손님 없는 시간 예측과 사장님 보고에 쓰인다)
- 모델·배포: `models`(slug, family, params_b, quantization, context_len, min_vram_mb, license, license_url, source_url, commercial_use_ok, status: draft | active | retired), `model_artifacts`(kind: gguf | tokenizer, sha256, size, storage_key, signature), `runtime_releases`, `agent_releases`(version, sha256, signature, rollout_percent, target_store_ids, status: draft | rolling | paused | complete | rolled_back)
- 작업: `jobs`(buyer_id, api_key_id, kind: chat | batch_item | canary | verification, model_id, status, priority, stream, params jsonb, input_ciphertext, input_key_id, input_bytes, max_tokens, price_version_id, hold_id, batch_id, parent_job_id, deadline_at, attempts, result_ciphertext, result_expires_at, tokens_in, tokens_out, cost_ucr, failure_code, created_at, completed_at), `job_attempts`(job_id, node_id, status, offered_at, accepted_at, lease_expires_at, ended_at, end_reason, reported_tokens_in, reported_tokens_out, output_sha256, timings jsonb, continuation_of_attempt_id), `batches`
- 검증: `verifications`(job_id, kind: canary | redundancy | fingerprint, subject_attempt_id, reference_attempt_id, expected_sha256, method, score, verdict: pass | fail | inconclusive, adjudicated_at, details), `reputation_events`
- 돈: `ledger_accounts`(kind, owner_type, owner_id, currency: CR | USD | KRW, allow_negative), `ledger_transactions`(kind, idempotency_key 고유, memo, reverses_tx_id, created_by, created_at, metadata), `ledger_postings`(tx_id, account_id, currency, amount bigint — 부호 있음), `account_balances`(account_id, currency, balance, version), `holds`(buyer_account_id, amount, status: active | captured | released | expired, job_id, expires_at), `earnings`(node_id, store_id, attempt_id, amount_ucr, status: pending | matured | clawed_back, matures_at, tx_id), `payout_records`(store_id, amount_ucr, krw_amount, method: manual_bank_transfer, reference, recorded_by, tx_id — 기록 전용), `price_versions`, `price_entries`(model_id, input_ucr_per_mtok, output_ucr_per_mtok, node_payout_bps, provider_cost_uusd_per_mtok_in/out), `fx_rates`(pair, rate_micros, source, effective_at), `external_usage`
- 운영: `settings`(key, value jsonb — 기능 플래그 포함), `audit_log`(actor_user_id, actor_kind, action, target_kind, target_id, data, ip_hash, at)

### 2. DB 수준 불변식
- **원장**: 거래 하나의 통화별 posting 합 = 0. 커밋 시점에 검사하는 지연 제약 트리거(`CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`).
- `ledger_postings`, `ledger_transactions`, `audit_log`는 추가만 가능(UPDATE·DELETE를 트리거로 거부).
- `account_balances.balance >= 0` — 단, `allow_negative = true`인 계정(변환 계정 등)은 예외.
- 금액 컬럼은 전부 `bigint`. `numeric`/`real` 금지.
- 고유 제약: `(store_id, hw_fingerprint_hmac)`(이미지 재부착용), `idempotency_key`, API 키 prefix 등.
- 큐용 부분 인덱스: `jobs(status='queued')`를 priority, created_at 순으로.
- 트리거는 위 불변식에만 쓰고, 비즈니스 로직은 넣지 않는다.

### 3. 마이그레이션
- drizzle-kit으로 생성 후 SQL을 직접 검토·다듬는다. 위험한 연산(테이블 잠금이 큰 변경)은 주석으로 표시한다.
- 빈 DB에 처음부터 적용, 롤백 가능한 범위는 down 마이그레이션 제공, 다시 up 해서 같은 스키마가 되는지 테스트.

### 4. 테스트 키트
- 마이그레이션을 적용한 템플릿 DB를 한 번 만들고, 테스트 파일마다 `CREATE DATABASE ... TEMPLATE`으로 복제해 격리한다.
- 팩토리: 사용자(역할별), 매장, 노드, 모델, 가격표, 작업, 원장 계정.
- `FakeClock`(조작 가능한 가상 시계)과 시드 고정 난수 유틸.

## 하지 말 것
- 원장·스케줄러 비즈니스 로직(S06, S12)
- 프롬프트를 평문으로 저장하는 컬럼

## 수용 기준
1. `pnpm verify` 통과. 마이그레이션이 embedded-postgres와 `DATABASE_URL` 양쪽에서 적용된다.
2. 제약 테스트: 합이 0이 아닌 거래는 커밋 실패, `audit_log` UPDATE 실패, 음수 잔액(비허용 계정) 실패, 중복 멱등 키 실패
3. up → down → up 후 스키마가 같다(스키마 덤프 비교)
4. `docs/DB.md`에 ERD와 불변식 표(불변식 → 강제 위치)

## 적대적 검토 포인트
- 앱이 우회할 수 있는 돈 불변식(트리거 비활성화 경로, 다른 연결 역할)
- 시간 컬럼 타입(timestamptz 아닌 것), 금액 타입 실수
- 인덱스 누락으로 큐·대사 쿼리가 느려질 곳

## 선택 확장
- DB 역할 분리(앱 역할은 원장 테이블에 INSERT만, 마이그레이션 역할만 DDL)
- `presence_intervals` 월 단위 파티셔닝 설계
