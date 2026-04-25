-- ============================================================================
-- membership module — seed AAIF tier ranks
-- Higher rank = stronger promotion. Operators can edit any time; rule
-- metadata + item_state.match_tier_rank propagate via the trigger.
-- ============================================================================
INSERT INTO public.membership_tier_ranks (tier, rank, display_label, color, sort_order, description) VALUES
  ('platinum',  100, 'Platinum',  '#5B21B6', 10, 'Founding-level supporters; highest promotion priority.'),
  ('gold',       80, 'Gold',      '#CA8A04', 20, 'Strategic members; strongly promoted.'),
  ('silver',     60, 'Silver',    '#6B7280', 30, 'Active member organizations.'),
  ('associate',  40, 'Associate', '#0EA5E9', 40, 'Academic + non-profit affiliates.')
ON CONFLICT (tier) DO UPDATE
  SET rank = EXCLUDED.rank,
      display_label = EXCLUDED.display_label,
      color = EXCLUDED.color,
      sort_order = EXCLUDED.sort_order,
      description = EXCLUDED.description,
      updated_at = now();
