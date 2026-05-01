# RLS Audit — lf-gatewaze-modules

**Reference:** [spec-production-readiness-hardening](https://github.com/gatewaze/gatewaze-environments/blob/main/specs/spec-production-readiness-hardening.md)
**Date:** 2026-04-29
**Scope:** prod-hardening/phase-1 branch

## Summary

The lf-gatewaze-modules repo holds four content/identity modules
(`content-pipeline`, `podcasts`, `lfid-auth`, `membership`) and one
theme module (`lf-theme`). None of the tables in these modules carry
an `account_id` column today — the data is platform-wide content
discovery and member directory information, not per-tenant.

For tenancy_v2 (gatewaze core 00024 + events module 010 + premium
14/4), no migrations are needed in this repo for the phase-1 hardening
release. The audit below records the broad-permissive policies that
exist today so they can be tightened in a follow-up if the product
ever requires tenant scoping for any of these tables.

## Tables with `TO authenticated USING (true)` SELECT policies

These are not tenant leaks today (no tenant model applies), but they
do mean any logged-in user can read the entire table contents via
PostgREST. Acceptable for content discovery datasets; worth revisiting
if any of these tables grow PII.

### content-pipeline

- `content_project_taxonomy` (1:001)
- `content_topic_taxonomy` (1:001)
- `content_submissions` (1:001)
- `content_queue` (1:001)
- `content_items` (1:001)
- `content_segments` (1:001)
- `content_discovery_sources` (1:001)
- `content_discovery_runs` (1:001)
- `content_monitoring_suggestions` (3:003)
- `content_duplicates` (4:004)

### podcasts

- `podcasts` (1:001)
- `podcast_episodes` (1:001)
- `podcast_guests` (1:001)

### lfid-auth

- `lfid_mappings` (1:001)

### membership

- `member_organizations` (1:001) — anon+authenticated SELECT
- `members` (1:001) — anon+authenticated SELECT
- (third table) (1:001) — authenticated SELECT

## Recommendations (deferred)

1. If any of these tables is to receive PII (e.g. private member-only
   notes), add an `account_id` column and replicate the dual-track
   pattern from `gatewaze-modules/modules/events/migrations/010_tenancy_v2.sql`.
2. For tables that should be admin-only writable but readable by
   anonymous portal visitors, replace `auth_all` with explicit
   `anon SELECT (status = 'published')` policies.
3. None of this blocks the phase-1 hardening release. No migration is
   shipped from this repo as part of `prod-hardening/phase-1`.

## Branch state

`prod-hardening/phase-1` exists in this repo so cross-repo deploy
tooling sees a consistent branch name across the four hardening repos
(`gatewaze`, `gatewaze-modules`, `premium-gatewaze-modules`,
`lf-gatewaze-modules`, `gatewaze-environments`). The branch contains
only this audit document.
