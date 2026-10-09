-- Down for 0003_review_fixes: restores the 0001/0002 definitions and drops what 0003 added.
DROP TRIGGER payout_records_insert_guard ON payout_records;
DROP TRIGGER earnings_insert_guard ON earnings;
DROP TRIGGER holds_insert_guard ON holds;
DROP FUNCTION binjari_money_record_insert_guard();

CREATE OR REPLACE FUNCTION binjari_ledger_posting_same_xact() RETURNS trigger
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

DROP INDEX holds_active_account_idx;
DROP INDEX job_attempts_offered_sweep_idx;
DROP INDEX jobs_queue_model_idx;

ALTER TABLE earnings DROP CONSTRAINT earnings_payout_record_store_fk;
ALTER TABLE earnings DROP CONSTRAINT earnings_attempt_job_node_fk;
ALTER TABLE earnings DROP CONSTRAINT earnings_node_store_fk;
ALTER TABLE payout_records DROP CONSTRAINT payout_records_id_store_key;
ALTER TABLE job_attempts DROP CONSTRAINT job_attempts_id_job_node_key;
ALTER TABLE nodes DROP CONSTRAINT nodes_id_store_key;
