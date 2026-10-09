-- 0001_invariants: money and audit invariants enforced by the database itself (S03, ADR 0018).
-- Triggers here only keep invariants (docs/DB.md "불변식"); they contain no business rules.
-- Every trigger is ENABLE ALWAYS so it also fires under session_replication_role = replica.
-- Custom SQLSTATEs (mapped in src/db/errors.ts):
--   BJ001 ledger transaction does not balance per currency, or has no postings  (M1)
--   BJ002 append-only table: UPDATE, DELETE or TRUNCATE                          (audit, ledger, prices)
--   BJ003 account_balances written directly (only the posting trigger may)       (M2)
--   BJ004 posting added to a ledger transaction created by another DB transaction
--   BJ005 money record changed in a forbidden way (holds, earnings, payouts)     (M6, M10)
-- Locking: creates functions and triggers on new, empty tables only.

-- ===================================================================================
-- Append-only tables: ledger_accounts, ledger_transactions, ledger_postings, audit_log,
-- price_versions, price_entries, fx_rates
-- ===================================================================================
CREATE FUNCTION binjari_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'BJ002', TABLE = TG_TABLE_NAME;
END
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_accounts_append_only BEFORE UPDATE OR DELETE ON ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION binjari_reject_change();
CREATE TRIGGER ledger_accounts_no_truncate BEFORE TRUNCATE ON ledger_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION binjari_reject_change();
CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION binjari_reject_change();
CREATE TRIGGER ledger_transactions_no_truncate BEFORE TRUNCATE ON ledger_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION binjari_reject_change();
CREATE TRIGGER ledger_postings_append_only BEFORE UPDATE OR DELETE ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION binjari_reject_change();
CREATE TRIGGER ledger_postings_no_truncate BEFORE TRUNCATE ON ledger_postings
  FOR EACH STATEMENT EXECUTE FUNCTION binjari_reject_change();
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION binjari_reject_change();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION binjari_reject_change();
CREATE TRIGGER price_versions_append_only BEFORE UPDATE OR DELETE ON price_versions
  FOR EACH ROW EXECUTE FUNCTION binjari_reject_change();
CREATE TRIGGER price_versions_no_truncate BEFORE TRUNCATE ON price_versions
  FOR EACH STATEMENT EXECUTE FUNCTION binjari_reject_change();
CREATE TRIGGER price_entries_append_only BEFORE UPDATE OR DELETE ON price_entries
  FOR EACH ROW EXECUTE FUNCTION binjari_reject_change();
CREATE TRIGGER price_entries_no_truncate BEFORE TRUNCATE ON price_entries
  FOR EACH STATEMENT EXECUTE FUNCTION binjari_reject_change();
CREATE TRIGGER fx_rates_append_only BEFORE UPDATE OR DELETE ON fx_rates
  FOR EACH ROW EXECUTE FUNCTION binjari_reject_change();
CREATE TRIGGER fx_rates_no_truncate BEFORE TRUNCATE ON fx_rates
  FOR EACH STATEMENT EXECUTE FUNCTION binjari_reject_change();
--> statement-breakpoint

-- ===================================================================================
-- Ledger transactions: remember which DB transaction created each one, and allow postings
-- only from that same DB transaction (no balanced pair slipped into an old, committed entry).
-- pg_current_xact_id() is the top-level id, so savepoints (nested transactions) still match.
-- ===================================================================================
CREATE FUNCTION binjari_ledger_tx_stamp() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_xid := pg_current_xact_id();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_stamp BEFORE INSERT ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION binjari_ledger_tx_stamp();
--> statement-breakpoint
CREATE FUNCTION binjari_ledger_posting_same_xact() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  tx_xid xid8;
BEGIN
  SELECT created_xid INTO tx_xid FROM public.ledger_transactions WHERE id = NEW.tx_id;
  -- A missing transaction is left to the foreign key, which reports it precisely.
  IF FOUND AND tx_xid <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'posting for ledger transaction % must be inserted in the DB transaction that created it', NEW.tx_id
      USING ERRCODE = 'BJ004', TABLE = 'ledger_postings';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_postings_same_xact BEFORE INSERT ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION binjari_ledger_posting_same_xact();
--> statement-breakpoint

-- ===================================================================================
-- M1: postings of one ledger transaction sum to zero per currency, checked at COMMIT.
-- Two deferred constraint triggers: one per transaction (also catches "no postings") and one per
-- posting (catches postings added after SET CONSTRAINTS ... IMMEDIATE already checked the sum).
-- The per-posting check only runs on the transaction's last posting, so k postings cost O(k), not O(k^2).
-- ===================================================================================
CREATE FUNCTION binjari_assert_tx_balanced(p_tx uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  bad record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ledger_postings WHERE tx_id = p_tx) THEN
    RAISE EXCEPTION 'ledger transaction % has no postings', p_tx
      USING ERRCODE = 'BJ001', CONSTRAINT = 'ledger_tx_balanced', TABLE = 'ledger_transactions';
  END IF;
  SELECT currency, sum(amount) AS total INTO bad
    FROM public.ledger_postings
   WHERE tx_id = p_tx
   GROUP BY currency
  HAVING sum(amount) <> 0
   ORDER BY currency
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ledger transaction % does not balance: % postings sum to %', p_tx, bad.currency, bad.total
      USING ERRCODE = 'BJ001', CONSTRAINT = 'ledger_tx_balanced', TABLE = 'ledger_transactions';
  END IF;
END
$$;
--> statement-breakpoint
CREATE FUNCTION binjari_ledger_tx_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM binjari_assert_tx_balanced(NEW.id);
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_tx_balanced AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION binjari_ledger_tx_balanced();
--> statement-breakpoint
CREATE FUNCTION binjari_ledger_postings_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Identity ids grow within a DB transaction, and postings only come from the creating transaction,
  -- so the max id is the last posting; all pending checks fire together, so one full sum suffices.
  IF NEW.id = (SELECT max(id) FROM public.ledger_postings WHERE tx_id = NEW.tx_id) THEN
    PERFORM binjari_assert_tx_balanced(NEW.tx_id);
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_postings_balanced AFTER INSERT ON ledger_postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION binjari_ledger_postings_balanced();
--> statement-breakpoint

-- ===================================================================================
-- M2/M3: account_balances is a cache of SUM(postings) that only these triggers write.
-- SECURITY DEFINER: the app role has no write privilege on account_balances (0002), the trigger does.
-- The sign rule is the CHECK account_balances_non_negative_check, evaluated on this UPDATE.
-- ===================================================================================
CREATE FUNCTION binjari_ledger_account_open() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO public.account_balances (account_id, currency, allow_negative, balance, version)
  VALUES (NEW.id, NEW.currency, NEW.allow_negative, 0, 0);
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_accounts_open AFTER INSERT ON ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION binjari_ledger_account_open();
--> statement-breakpoint
CREATE FUNCTION binjari_ledger_apply_posting() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE public.account_balances
     SET balance = balance + NEW.amount,
         version = version + 1
   WHERE account_id = NEW.account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger account % has no balance row', NEW.account_id
      USING ERRCODE = 'BJ003', TABLE = 'account_balances';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_postings_apply AFTER INSERT ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION binjari_ledger_apply_posting();
--> statement-breakpoint
CREATE FUNCTION binjari_account_balances_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Depth 1 = a statement run directly by a client; the ledger triggers above run at depth 2.
  IF pg_trigger_depth() < 2 OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'account_balances is maintained by ledger_postings triggers: direct % is not allowed', TG_OP
      USING ERRCODE = 'BJ003', TABLE = 'account_balances';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.account_id, NEW.currency, NEW.allow_negative)
       IS DISTINCT FROM (OLD.account_id, OLD.currency, OLD.allow_negative) THEN
    RAISE EXCEPTION 'account_balances identity columns are immutable'
      USING ERRCODE = 'BJ003', TABLE = 'account_balances';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER account_balances_guard BEFORE INSERT OR UPDATE OR DELETE ON account_balances
  FOR EACH ROW EXECUTE FUNCTION binjari_account_balances_guard();
CREATE TRIGGER account_balances_no_truncate BEFORE TRUNCATE ON account_balances
  FOR EACH STATEMENT EXECUTE FUNCTION binjari_reject_change();
--> statement-breakpoint

-- ===================================================================================
-- Money records that change state but must never lose history (M5, M6, M10).
-- ===================================================================================
CREATE FUNCTION binjari_holds_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'holds rows are never deleted' USING ERRCODE = 'BJ005', TABLE = 'holds';
  END IF;
  IF (NEW.id, NEW.buyer_account_id, NEW.currency, NEW.amount, NEW.purpose, NEW.reference_id, NEW.hold_tx_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.buyer_account_id, OLD.currency, OLD.amount, OLD.purpose, OLD.reference_id, OLD.hold_tx_id, OLD.created_at) THEN
    RAISE EXCEPTION 'hold %: identity and amount are immutable', OLD.id USING ERRCODE = 'BJ005', TABLE = 'holds';
  END IF;
  IF NEW.captured_amount < OLD.captured_amount OR NEW.released_amount < OLD.released_amount THEN
    RAISE EXCEPTION 'hold %: captured and released amounts never decrease', OLD.id USING ERRCODE = 'BJ005', TABLE = 'holds';
  END IF;
  IF OLD.status <> 'active' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'hold % is already % and cannot change', OLD.id, OLD.status USING ERRCODE = 'BJ005', TABLE = 'holds';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER holds_guard BEFORE UPDATE OR DELETE ON holds
  FOR EACH ROW EXECUTE FUNCTION binjari_holds_guard();
CREATE TRIGGER holds_no_truncate BEFORE TRUNCATE ON holds
  FOR EACH STATEMENT EXECUTE FUNCTION binjari_reject_change();
--> statement-breakpoint
CREATE FUNCTION binjari_earnings_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'earnings rows are never deleted' USING ERRCODE = 'BJ005', TABLE = 'earnings';
  END IF;
  IF (NEW.id, NEW.node_id, NEW.store_id, NEW.job_id, NEW.attempt_id, NEW.kind, NEW.currency, NEW.amount_ucr, NEW.tx_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.node_id, OLD.store_id, OLD.job_id, OLD.attempt_id, OLD.kind, OLD.currency, OLD.amount_ucr, OLD.tx_id, OLD.created_at) THEN
    RAISE EXCEPTION 'earning %: identity and amount are immutable', OLD.id USING ERRCODE = 'BJ005', TABLE = 'earnings';
  END IF;
  IF (OLD.mature_tx_id IS NOT NULL AND NEW.mature_tx_id IS DISTINCT FROM OLD.mature_tx_id)
     OR (OLD.clawback_tx_id IS NOT NULL AND NEW.clawback_tx_id IS DISTINCT FROM OLD.clawback_tx_id) THEN
    RAISE EXCEPTION 'earning %: ledger transaction links are set once', OLD.id USING ERRCODE = 'BJ005', TABLE = 'earnings';
  END IF;
  -- M10: a payout link is added once, only to a matured earning that becomes payout_recorded.
  IF NEW.payout_record_id IS DISTINCT FROM OLD.payout_record_id
     AND (OLD.payout_record_id IS NOT NULL OR OLD.status <> 'matured' OR NEW.status <> 'payout_recorded') THEN
    RAISE EXCEPTION 'earning %: only a matured earning can be linked to a payout record, once', OLD.id
      USING ERRCODE = 'BJ005', TABLE = 'earnings';
  END IF;
  IF OLD.status IN ('clawed_back', 'settled') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'earning % is % (final)', OLD.id, OLD.status USING ERRCODE = 'BJ005', TABLE = 'earnings';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER earnings_guard BEFORE UPDATE OR DELETE ON earnings
  FOR EACH ROW EXECUTE FUNCTION binjari_earnings_guard();
CREATE TRIGGER earnings_no_truncate BEFORE TRUNCATE ON earnings
  FOR EACH STATEMENT EXECUTE FUNCTION binjari_reject_change();
--> statement-breakpoint
CREATE FUNCTION binjari_payout_records_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payout records are never deleted' USING ERRCODE = 'BJ005', TABLE = 'payout_records';
  END IF;
  IF (NEW.id, NEW.store_id, NEW.currency, NEW.amount_ucr, NEW.method, NEW.recorded_by, NEW.recorded_at, NEW.record_tx_id)
     IS DISTINCT FROM
     (OLD.id, OLD.store_id, OLD.currency, OLD.amount_ucr, OLD.method, OLD.recorded_by, OLD.recorded_at, OLD.record_tx_id) THEN
    RAISE EXCEPTION 'payout record %: identity and amount are immutable', OLD.id USING ERRCODE = 'BJ005', TABLE = 'payout_records';
  END IF;
  IF OLD.status = 'settled' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'payout record % is settled (final)', OLD.id USING ERRCODE = 'BJ005', TABLE = 'payout_records';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER payout_records_guard BEFORE UPDATE OR DELETE ON payout_records
  FOR EACH ROW EXECUTE FUNCTION binjari_payout_records_guard();
CREATE TRIGGER payout_records_no_truncate BEFORE TRUNCATE ON payout_records
  FOR EACH STATEMENT EXECUTE FUNCTION binjari_reject_change();
--> statement-breakpoint

-- ===================================================================================
-- Fire every invariant trigger even under session_replication_role = replica.
-- ===================================================================================
ALTER TABLE ledger_accounts ENABLE ALWAYS TRIGGER ledger_accounts_append_only;
ALTER TABLE ledger_accounts ENABLE ALWAYS TRIGGER ledger_accounts_no_truncate;
ALTER TABLE ledger_accounts ENABLE ALWAYS TRIGGER ledger_accounts_open;
ALTER TABLE ledger_transactions ENABLE ALWAYS TRIGGER ledger_transactions_append_only;
ALTER TABLE ledger_transactions ENABLE ALWAYS TRIGGER ledger_transactions_no_truncate;
ALTER TABLE ledger_transactions ENABLE ALWAYS TRIGGER ledger_transactions_stamp;
ALTER TABLE ledger_transactions ENABLE ALWAYS TRIGGER ledger_tx_balanced;
ALTER TABLE ledger_postings ENABLE ALWAYS TRIGGER ledger_postings_append_only;
ALTER TABLE ledger_postings ENABLE ALWAYS TRIGGER ledger_postings_no_truncate;
ALTER TABLE ledger_postings ENABLE ALWAYS TRIGGER ledger_postings_same_xact;
ALTER TABLE ledger_postings ENABLE ALWAYS TRIGGER ledger_postings_balanced;
ALTER TABLE ledger_postings ENABLE ALWAYS TRIGGER ledger_postings_apply;
ALTER TABLE account_balances ENABLE ALWAYS TRIGGER account_balances_guard;
ALTER TABLE account_balances ENABLE ALWAYS TRIGGER account_balances_no_truncate;
ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_append_only;
ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_no_truncate;
ALTER TABLE price_versions ENABLE ALWAYS TRIGGER price_versions_append_only;
ALTER TABLE price_versions ENABLE ALWAYS TRIGGER price_versions_no_truncate;
ALTER TABLE price_entries ENABLE ALWAYS TRIGGER price_entries_append_only;
ALTER TABLE price_entries ENABLE ALWAYS TRIGGER price_entries_no_truncate;
ALTER TABLE fx_rates ENABLE ALWAYS TRIGGER fx_rates_append_only;
ALTER TABLE fx_rates ENABLE ALWAYS TRIGGER fx_rates_no_truncate;
ALTER TABLE holds ENABLE ALWAYS TRIGGER holds_guard;
ALTER TABLE holds ENABLE ALWAYS TRIGGER holds_no_truncate;
ALTER TABLE earnings ENABLE ALWAYS TRIGGER earnings_guard;
ALTER TABLE earnings ENABLE ALWAYS TRIGGER earnings_no_truncate;
ALTER TABLE payout_records ENABLE ALWAYS TRIGGER payout_records_guard;
ALTER TABLE payout_records ENABLE ALWAYS TRIGGER payout_records_no_truncate;
