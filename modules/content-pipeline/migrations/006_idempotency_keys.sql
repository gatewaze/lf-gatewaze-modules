-- ============================================================================
-- Migration: 006_idempotency_keys.sql
-- Module: content-pipeline
-- Description: Add idempotency_key columns to content_submissions and
--              content_discovery_runs so the Prefect worker and the
--              content-discovery trigger API can safely retry without
--              creating duplicates.
--
-- See: spec A.4.5 (Idempotency & Retry Safety) in
--      gatewaze-environments/specs/spec-content-discovery-pipeline.md
-- ============================================================================

-- ------------------------------------------------------------
-- content_submissions.idempotency_key
-- Used by the discovery stage to dedupe re-submissions of the
-- same (source_id, discovered_url) across retries.
-- ------------------------------------------------------------
ALTER TABLE public.content_submissions
  ADD COLUMN IF NOT EXISTS idempotency_key text;

-- Partial unique index: only enforce uniqueness when the key is populated,
-- so existing rows (legacy inserts without a key) remain valid.
CREATE UNIQUE INDEX IF NOT EXISTS content_submissions_idempotency_key_uq
  ON public.content_submissions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN public.content_submissions.idempotency_key IS
  'Deterministic hash of (source_id, discovered_url) set by the Prefect discovery agent. Prevents duplicate submissions when the flow retries mid-batch.';

-- ------------------------------------------------------------
-- content_discovery_runs.idempotency_key
-- Used by the admin trigger API to dedupe double-clicks and by
-- the Prefect scheduler to dedupe cron retries.
-- ------------------------------------------------------------
ALTER TABLE public.content_discovery_runs
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS content_discovery_runs_idempotency_key_uq
  ON public.content_discovery_runs (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN public.content_discovery_runs.idempotency_key IS
  'Deterministic hash: "manual:<user_id>:<source_id>:<minute_bucket>" for admin triggers, "sched:<source_type>:<iso_bucket>" for scheduled runs.';
