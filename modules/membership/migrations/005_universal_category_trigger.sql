-- ============================================================================
-- membership module — drop the event-specific category trigger.
-- The universal trigger (cm_category_sync_universal) installed by
-- content-platform now drives content_category for any registered content type
-- via content_category_adapters. The events module registers itself there.
--
-- See spec-unified-content-management.md §3.2.
-- ============================================================================

DROP TRIGGER IF EXISTS events_member_category_sync_trg ON public.content_keyword_item_state;
DROP FUNCTION IF EXISTS public.events_member_category_sync();
