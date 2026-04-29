-- =============================================================================
-- Module: membership
-- Migration: 006_tighten_sync_runs_rls
--
-- Closes one of the broad authenticated-USING-(true) policies flagged
-- in the lf-modules RLS_AUDIT.md (Session 6). membership_sync_runs is
-- operational data (sync error messages, raw counts, source URLs) —
-- it shouldn't be readable by every authenticated user, only admins.
--
-- The other broad policies in this repo (member_organizations,
-- membership_tier_ranks) keep their anon SELECT because the data is
-- intentionally public (directory listings on the brand portal).
--
-- Depends on the gatewaze core is_admin() helper (00006).
-- =============================================================================

DROP POLICY IF EXISTS msr_admin ON public.membership_sync_runs;

CREATE POLICY membership_sync_runs_admin_select
  ON public.membership_sync_runs FOR SELECT TO authenticated
  USING (public.is_admin());
