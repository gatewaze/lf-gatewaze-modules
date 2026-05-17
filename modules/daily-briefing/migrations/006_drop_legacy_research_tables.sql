-- ============================================================================
-- Module: daily-briefing
-- Migration: 006_drop_legacy_research_tables
-- Description: Drop the legacy research-thread tables. After spec-ai-
--              module follow-up #2: the daily-briefing autopilot
--              persists threads/messages in @gatewaze-modules/ai's
--              ai_threads + ai_messages (keyed by
--              use_case='daily-briefing-research', host_kind=
--              'daily_briefing_day', host_id=<day.id>).
--
--              Operator confirmed no live data needs preservation —
--              the existing rows were dev/test only. The candidate
--              approval endpoint now reads ai_messages.structured.
--              candidates; the cron + kickoff write directly to
--              ai_messages.
--
-- Safe to drop because:
--   1. ResearchPanel.tsx has been deleted (replaced by AiChatWidget).
--   2. admin-routes.ts no longer references either table — the
--      legacy thread CRUD endpoints are gone; approveResearchCandidate
--      reads ai_messages; kickoffAutopilotForNewDay writes ai_messages.
--   3. workers/weekday-autopilot.ts uses the new tables.
--   4. The webhook topic registration in 004_webhook_topics_days.sql
--      drops the daily_briefing_items mutation event entries that
--      pointed at these tables (the FK cascade handles the rest).
-- ============================================================================

DROP TABLE IF EXISTS public.daily_briefing_research_messages CASCADE;
DROP TABLE IF EXISTS public.daily_briefing_research_threads CASCADE;
