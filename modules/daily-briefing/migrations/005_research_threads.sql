-- ============================================================================
-- Module: daily-briefing
-- Migration: 005_research_threads
-- Description: Persistent chat thread state for the AI research autopilot.
--
--              When an operator opens a day, the chat panel shows a stored
--              thread of LLM turns + candidate stories the model proposed.
--              The cron-driven "weekday auto-research" job creates the
--              thread + its first turn ahead of time so the panel is
--              already populated when the operator arrives.
--
-- Tables:
--   daily_briefing_research_threads — one per day. status tracks the
--     async runner so the UI can render "researching" without polling.
--   daily_briefing_research_messages — append-only. Each row is one
--     conversational turn (user / assistant / system / tool_summary).
--     `candidates` is the structured-output JSON the model emitted at
--     that turn, or NULL for plain chat turns.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.daily_briefing_research_threads (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day_id         uuid NOT NULL REFERENCES public.daily_briefing_days(id) ON DELETE CASCADE,

  status         text NOT NULL DEFAULT 'idle'
                 CHECK (status IN ('idle','running','ready','failed')),
  last_error     text,
  -- Diagnostic: token spend per thread, refreshed by the runner on each turn.
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- One active thread per day. If the operator wants to start over they
  -- can DELETE this row (cascades to messages) and re-run the autopilot.
  CONSTRAINT daily_briefing_research_threads_day_unique UNIQUE (day_id)
);

COMMENT ON TABLE public.daily_briefing_research_threads IS
  'AI research autopilot thread state, one per daily-briefing day. Populated by the weekday cron + refined via the admin chat UI.';

CREATE INDEX IF NOT EXISTS daily_briefing_research_threads_day_idx
  ON public.daily_briefing_research_threads (day_id);

DROP TRIGGER IF EXISTS daily_briefing_research_threads_updated_at ON public.daily_briefing_research_threads;
CREATE TRIGGER daily_briefing_research_threads_updated_at
  BEFORE UPDATE ON public.daily_briefing_research_threads
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.daily_briefing_research_threads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "daily_briefing_research_threads_select_authenticated"
  ON public.daily_briefing_research_threads;
CREATE POLICY "daily_briefing_research_threads_select_authenticated"
  ON public.daily_briefing_research_threads FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "daily_briefing_research_threads_insert_admin"
  ON public.daily_briefing_research_threads;
CREATE POLICY "daily_briefing_research_threads_insert_admin"
  ON public.daily_briefing_research_threads FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "daily_briefing_research_threads_update_admin"
  ON public.daily_briefing_research_threads;
CREATE POLICY "daily_briefing_research_threads_update_admin"
  ON public.daily_briefing_research_threads FOR UPDATE TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS "daily_briefing_research_threads_delete_admin"
  ON public.daily_briefing_research_threads;
CREATE POLICY "daily_briefing_research_threads_delete_admin"
  ON public.daily_briefing_research_threads FOR DELETE TO authenticated
  USING (public.is_admin());

-- ── Messages ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.daily_briefing_research_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id   uuid NOT NULL REFERENCES public.daily_briefing_research_threads(id) ON DELETE CASCADE,

  role        text NOT NULL
              CHECK (role IN ('system','user','assistant','tool_summary')),
  -- `content` is the human-readable text — assistant prose, user
  -- instruction, or a one-line "fetched N URLs" summary for tool turns.
  content     text NOT NULL DEFAULT '',
  -- Structured candidate output from the assistant's final tool call:
  --   [{ "title": "...", "summary": "...", "source_label": "...",
  --      "source_href": "...", "why": "..." }, ...]
  -- NULL on plain chat turns. JSONB so we can index later if needed.
  candidates  jsonb,

  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.daily_briefing_research_messages IS
  'Append-only conversation turns for the daily-briefing research autopilot. Assistant turns include a `candidates` JSON sidecar the admin UI renders as click-to-approve cards.';

CREATE INDEX IF NOT EXISTS daily_briefing_research_messages_thread_created_idx
  ON public.daily_briefing_research_messages (thread_id, created_at);

ALTER TABLE public.daily_briefing_research_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "daily_briefing_research_messages_select_authenticated"
  ON public.daily_briefing_research_messages;
CREATE POLICY "daily_briefing_research_messages_select_authenticated"
  ON public.daily_briefing_research_messages FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "daily_briefing_research_messages_insert_admin"
  ON public.daily_briefing_research_messages;
CREATE POLICY "daily_briefing_research_messages_insert_admin"
  ON public.daily_briefing_research_messages FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "daily_briefing_research_messages_delete_admin"
  ON public.daily_briefing_research_messages;
CREATE POLICY "daily_briefing_research_messages_delete_admin"
  ON public.daily_briefing_research_messages FOR DELETE TO authenticated
  USING (public.is_admin());
