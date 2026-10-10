-- 0002_app_role: least-privilege role for the running server (S03, ADR 0018).
-- spareon_app is a NOLOGIN group role. Production login roles are made members of it (docs/DB.md, S30).
-- It owns nothing and has no DDL, TRUNCATE, TRIGGER or REFERENCES privilege, so it cannot drop or
-- disable the invariant triggers, and session_replication_role needs superuser.
-- Every table must appear in exactly one group below; test/db/roles.int.test.ts fails if a new table
-- has no grant decision.
-- Roles are cluster-wide: creating it can race with another database's migration (handled), and the
-- down migration only revokes this database's grants (the role may be used by other databases).
-- Locking: GRANT/REVOKE take brief locks on catalog entries only.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spareon_app') THEN
    BEGIN
      CREATE ROLE spareon_app NOLOGIN;
    EXCEPTION
      -- Another database's migration created it at the same moment.
      WHEN duplicate_object OR unique_violation THEN NULL;
    END;
  END IF;
END
$$;
--> statement-breakpoint

-- Objects are created only by the migration owner.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO spareon_app;
--> statement-breakpoint

-- Append-only: read and add, never change or remove.
GRANT SELECT, INSERT ON
  ledger_accounts, ledger_transactions, ledger_postings, audit_log,
  price_versions, price_entries, fx_rates
  TO spareon_app;
--> statement-breakpoint

-- Written only by the ledger triggers (SECURITY DEFINER).
GRANT SELECT ON account_balances TO spareon_app;
--> statement-breakpoint

-- Money records: state changes allowed (guarded by triggers), rows never deleted.
GRANT SELECT, INSERT, UPDATE ON holds, earnings, payout_records TO spareon_app;
--> statement-breakpoint

-- Ordinary tables: full row access (retention and cleanup jobs delete rows).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, sessions, api_keys, idempotency_keys,
  stores, enrollment_codes, nodes, node_events, presence_intervals, kill_switches,
  models, model_artifacts, runtime_releases, agent_releases,
  batches, batch_files, jobs, job_attempts, job_payloads,
  verifications, reputation_events,
  external_usage, reserve_reservations,
  settings, outbox_events
  TO spareon_app;
--> statement-breakpoint

-- Identity columns (ledger_postings.id, outbox_events.id).
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO spareon_app;
