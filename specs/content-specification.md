# Gatewaze: Agentic AI Content Intelligence Platform — Technical Specification

## Project Overview

Gatewaze is an AI-powered content intelligence platform that discovers, indexes, summarizes, and serves a searchable database of online content related to open source agentic AI projects. It focuses initially on MCP (Model Context Protocol), Goose, and agents.md, expanding to the wider agentic AI landscape including projects from AAIF (Agentic AI Foundation) members.

The platform uses autonomous AI agents to continuously discover new content (blog posts, YouTube videos, tutorials, conference talks, GitHub repos, images), scrape and process it, generate summaries and "hot takes," and make it available through a public-facing website and API. A key differentiator is **deep video indexing** — storing timestamped segments with topic tags so users can jump directly to the moment in a video where a specific project or concept is discussed.

Gatewaze is being built for the Linux Foundation's AAIF project (aaif.io).

---

## Architecture Overview

### Stack

| Layer | Technology | Role |
|-------|-----------|------|
| Pipeline & State Machine | **Supabase** (PostgreSQL) | Operational database, agent triggers, scheduling, queue management, vector search |
| Agent Orchestration (Phase 1) | **Helix.ml** | Visual agent desktops with browser access for debugging during development |
| Agent Orchestration (Phase 2) | **Agno** | Production-grade Python agent framework with FastAPI runtime, teams, workflows |
| Content Delivery & Editorial | **Sanity.io** | Structured content CMS for the public-facing site, editorial review, MCP endpoint |
| Frontend | **TBD** (consuming Sanity via GROQ / Agent Context) | Public-facing Gatewaze website |

### Data Flow

```
[Content Sources] → [Discovery Agent] → content_submissions (Supabase)
                                              ↓
                                    [Triage Agent] → content_queue (Supabase)
                                              ↓
                                    [Processing Agent] → content_items + content_segments (Supabase)
                                              ↓
                                    [Sync to Sanity] → Sanity Content Lake (presentation)
                                              ↓
                                    [Gatewaze Frontend] ← Sanity GROQ / Agent Context MCP
```

---

## Agent Pipeline

The pipeline is split into three distinct agents, each with focused responsibilities. This separation is intentional — discovery is broad and exploratory, triage handles fan-out and deduplication, and processing is deep and content-type-specific. Combining them would create bloated context windows and make failures cascade.

### Agent 1: Triage Agent

**Trigger:** Supabase webhook/Edge Function on INSERT to `content_submissions`

**Responsibilities:**
- Receive a submitted URL or search query
- Classify it: single content item vs. index/feed/playlist/channel
- If single item: promote directly to `content_queue` with metadata
- If index/collection: expand into individual items (e.g., turn a YouTube playlist into 30 separate video entries, expand a blog index page into individual post URLs)
- Deduplicate against existing `content_items` (by URL and fuzzy title matching)
- Set `content_type` (article, video, image, repo, tutorial, talk, podcast, etc.)
- Set `source_type` (youtube, blog, github, twitter, conference, podcast, etc.)
- Assign priority based on source reputation and content freshness

**Output:** Rows in `content_queue` with status `pending`

### Agent 2: Processing Agent

**Trigger:** Supabase webhook/Edge Function on INSERT to `content_queue` (or polling for `status = 'pending'`)

**Responsibilities:**
- Pick up items from `content_queue`
- Content-type-specific scraping and extraction:
  - **YouTube videos:** Extract timestamped transcript (via yt-dlp --write-subs for captions, or Whisper for audio), video metadata (title, description, channel, publish date, duration, thumbnail)
  - **Articles/blog posts:** Scrape with Playwright/Puppeteer, extract main content (strip nav/ads/boilerplate), extract author, publish date, images
  - **GitHub repos:** Extract README, description, key files, star count, last commit date, contributors
  - **Images:** Describe content using vision model, extract metadata (EXIF, source context)
  - **Podcasts:** Download audio, transcribe with Whisper (timestamped), extract show notes
  - **Conference talks:** Combination of video + slide extraction if available
- Clean up technical term errors in transcripts (e.g., "MCPE" → "MCP", capitalize "Goose" correctly)
- Generate structured output for each content item:
  - **Title** (cleaned/normalized)
  - **Summary** (2-3 paragraph overview)
  - **Hot take** (1-2 sentence opinionated editorial perspective)
  - **Key topics** (from controlled taxonomy + freeform tags)
  - **Project tags** (which tracked projects are discussed: MCP, Goose, agents.md, A2A, etc.)
  - **Key people mentioned** (speakers, authors, developers referenced)
  - **Embedding vector** (for semantic search)
- **Deep video indexing** (see dedicated section below)
- Write completed data to `content_items` and `content_segments` in Supabase
- Sync finished content to Sanity for presentation
- Update `content_queue` status to `completed` or `failed` (with error details and retry count)

**Output:** Rows in `content_items` and `content_segments`, plus corresponding documents in Sanity

### Agent 3: Discovery Agent

**Trigger:** Scheduled via Supabase `pg_cron` or external scheduler calling a Supabase Edge Function

**Responsibilities:**
- Run periodic searches across configured sources:
  - Google Search API (for target keywords/projects)
  - YouTube Data API (new videos on tracked channels and search queries)
  - RSS feeds from AAIF member blogs and key tech blogs
  - GitHub (new/trending repos tagged with relevant topics, new releases on tracked repos)
  - Twitter/X API (if available) for key accounts in the agentic AI space
  - Hacker News API for relevant submissions
  - Reddit (r/MachineLearning, r/LocalLLaMA, r/LLMDevs, etc.)
- Find new content that matches tracked projects and topics
- Insert discoveries into `content_submissions` — feeding back into the same pipeline
- Track what's already been discovered to avoid duplicate submissions
- Log discovery runs in `discovery_runs` table for monitoring

**Output:** Rows in `content_submissions`, feeding the triage → processing pipeline

---

## Deep Video Indexing

This is a key differentiator for Gatewaze. Instead of just indexing a video as a single item, we break it down into timestamped segments so users can search and jump directly to the exact moment a topic is discussed.

### How It Works

**Step 1: Get timestamped transcripts**
- YouTube: Use `yt-dlp --write-subs` to pull `.vtt` or `.srt` caption files (auto-generated or creator-uploaded). These have per-line timestamps accurate to the second.
- Non-YouTube video (Vimeo, conference recordings, etc.): Run audio through OpenAI Whisper, which produces word-level timestamps.
- Podcasts: Same Whisper pipeline as non-YouTube video.

**Step 2: LLM segmentation**
- Feed the full timestamped transcript to the processing agent's LLM
- The LLM performs two tasks in a single pass:
  1. **Table of contents generation:** Break the video into logical chapters/segments with start/end timecodes and descriptive titles
  2. **Topic and project tagging:** For each segment, identify which tracked projects (MCP, Goose, agents.md, A2A, etc.) and topics (agent-workflows, tool-calling, security, benchmarks, etc.) are discussed
- The LLM also generates a 2-3 sentence summary for each segment
- Technical term cleanup happens in this pass (fixing caption errors for domain-specific terms)

**Step 3: Structured output**
The LLM outputs structured JSON per video:

```json
{
  "segments": [
    {
      "start_time": 184,
      "end_time": 342,
      "title": "How MCP replaces custom API integrations",
      "topics": ["mcp", "api-design", "standardization"],
      "projects": ["mcp"],
      "summary": "The speaker explains how MCP's server architecture eliminates the need for custom API integrations by providing a universal protocol. They compare it to USB-C standardization and walk through a concrete example of connecting a Postgres database.",
      "key_people": ["Anthropic team"],
      "transcript_text": "The cleaned transcript text for this segment..."
    },
    {
      "start_time": 342,
      "end_time": 519,
      "title": "Building a Goose recipe for automated testing",
      "topics": ["agent-workflows", "testing", "automation"],
      "projects": ["goose"],
      "summary": "Walkthrough of creating a custom Goose recipe that automates end-to-end testing using Playwright MCP. Demonstrates the recipe parameter system and how to chain multiple tools.",
      "key_people": ["Speaker Name"],
      "transcript_text": "The cleaned transcript text for this segment..."
    }
  ]
}
```

**Step 4: Store searchably**
- Each segment becomes a row in `content_segments` (Supabase) with its own embedding vector
- Semantic search via `pgvector` can match user queries to specific segments
- On the Sanity side, the content item includes an array of segment objects for display

**Step 5: Deep-link in search results**
- YouTube URLs support timestamp parameters: `https://youtube.com/watch?v=xxx&t=184`
- Search results display the specific segment match with its timecode, summary, and a direct link to that moment in the video
- Example search result:
  > **"MCP server authentication patterns"** — discussed at 3:04 in *"Building Agentic Workflows with MCP"* by [creator] — "The speaker explains how OAuth 2.1 flows work within MCP server connections..."

### Cost Estimate
- A typical 30-minute video transcript is ~4,000-5,000 tokens
- Segmentation prompt + output runs ~8,000-10,000 tokens total
- Cost: a few cents per video (using Claude Sonnet)
- At thousands of videos, this remains very affordable

---

## Supabase Database Schema

### Table: `content_submissions`
Raw inputs from users or the discovery agent.

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid (PK) | |
| `url` | text | Submitted URL (nullable if search query) |
| `search_query` | text | Search query (nullable if direct URL) |
| `submitted_by` | text | 'user', 'discovery_agent', or user identifier |
| `submission_type` | text | 'url', 'search_query' |
| `status` | text | 'pending', 'triaging', 'completed', 'failed', 'duplicate' |
| `error_message` | text | Error details if failed |
| `notes` | text | Optional context from submitter |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### Table: `content_queue`
Individual content items awaiting processing, expanded from submissions by the triage agent.

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid (PK) | |
| `submission_id` | uuid (FK → content_submissions) | Source submission |
| `url` | text (NOT NULL, UNIQUE) | Canonical URL of the content |
| `title` | text | Title if known from triage |
| `content_type` | text | 'article', 'video', 'image', 'repo', 'tutorial', 'talk', 'podcast', 'documentation' |
| `source_type` | text | 'youtube', 'blog', 'github', 'twitter', 'conference', 'podcast', 'rss', 'reddit', 'hackernews' |
| `status` | text | 'pending', 'processing', 'completed', 'failed' |
| `priority` | integer | 1 (highest) to 5 (lowest) |
| `retry_count` | integer (DEFAULT 0) | Number of processing attempts |
| `max_retries` | integer (DEFAULT 3) | |
| `error_message` | text | Last error if failed |
| `metadata` | jsonb | Any extra metadata from triage (channel name, playlist info, etc.) |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |
| `processing_started_at` | timestamptz | When an agent picked this up |

### Table: `content_items`
Fully processed content items — the core of the Gatewaze database.

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid (PK) | |
| `queue_id` | uuid (FK → content_queue) | Source queue entry |
| `url` | text (NOT NULL, UNIQUE) | Canonical URL |
| `title` | text (NOT NULL) | Cleaned/normalized title |
| `content_type` | text (NOT NULL) | 'article', 'video', 'image', 'repo', 'tutorial', 'talk', 'podcast', 'documentation' |
| `source_type` | text (NOT NULL) | 'youtube', 'blog', 'github', 'twitter', 'conference', 'podcast', 'rss' |
| `author` | text | Creator/author name |
| `author_url` | text | Link to author profile/channel |
| `publish_date` | timestamptz | Original publication date |
| `summary` | text | 2-3 paragraph AI-generated summary |
| `hot_take` | text | 1-2 sentence opinionated editorial take |
| `topics` | text[] | Topic tags from controlled taxonomy |
| `projects` | text[] | Tracked project tags (e.g., 'mcp', 'goose', 'agents-md', 'a2a') |
| `key_people` | text[] | People mentioned/featured |
| `thumbnail_url` | text | Thumbnail/hero image URL |
| `duration_seconds` | integer | Duration for video/audio content |
| `raw_text` | text | Full extracted text content |
| `transcript` | text | Full transcript for video/audio |
| `has_segments` | boolean (DEFAULT false) | Whether deep video indexing was performed |
| `language` | text (DEFAULT 'en') | Content language |
| `metadata` | jsonb | Additional type-specific metadata (view count, star count, etc.) |
| `embedding` | vector(1536) | Embedding for semantic search (pgvector) |
| `sanity_document_id` | text | Corresponding Sanity document ID after sync |
| `quality_score` | numeric | Agent-assessed quality/relevance score (0-1) |
| `discovered_at` | timestamptz | When the content was first discovered |
| `processed_at` | timestamptz | When processing completed |
| `refreshed_at` | timestamptz | Last time content was re-checked/updated |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### Table: `content_segments`
Deep-indexed segments of video/audio content with timestamped topics.

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid (PK) | |
| `content_item_id` | uuid (FK → content_items, NOT NULL) | Parent content item |
| `segment_index` | integer (NOT NULL) | Order within the content item (0-based) |
| `start_time` | integer (NOT NULL) | Start time in seconds |
| `end_time` | integer (NOT NULL) | End time in seconds |
| `title` | text (NOT NULL) | Descriptive segment title/chapter name |
| `summary` | text | 2-3 sentence summary of this segment |
| `topics` | text[] | Topic tags for this segment |
| `projects` | text[] | Project tags for this segment |
| `key_people` | text[] | People featured in this segment |
| `transcript_text` | text | Raw transcript text for this segment |
| `embedding` | vector(1536) | Segment-level embedding for semantic search |
| `created_at` | timestamptz | |

### Table: `discovery_sources`
Configured sources that the discovery agent monitors periodically.

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid (PK) | |
| `name` | text (NOT NULL) | Human-readable source name |
| `source_type` | text (NOT NULL) | 'rss', 'youtube_channel', 'youtube_search', 'google_search', 'github_topic', 'github_repo', 'twitter_account', 'reddit_subreddit', 'hackernews', 'website' |
| `source_url` | text | URL/feed URL/channel URL |
| `search_query` | text | Search query for search-based sources |
| `check_frequency` | interval (NOT NULL) | How often to check (e.g., '1 hour', '6 hours', '1 day') |
| `last_checked_at` | timestamptz | Last successful check |
| `is_active` | boolean (DEFAULT true) | Whether this source is currently being monitored |
| `priority` | integer (DEFAULT 3) | Default priority for items from this source |
| `metadata` | jsonb | Source-specific config (API keys reference, filters, etc.) |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### Table: `discovery_runs`
Log of discovery agent executions for monitoring and debugging.

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid (PK) | |
| `source_id` | uuid (FK → discovery_sources) | Which source was checked |
| `status` | text | 'running', 'completed', 'failed' |
| `items_found` | integer (DEFAULT 0) | New items discovered |
| `items_submitted` | integer (DEFAULT 0) | Items actually submitted (after dedup) |
| `error_message` | text | Error details if failed |
| `started_at` | timestamptz | |
| `completed_at` | timestamptz | |

### Table: `project_taxonomy`
Controlled vocabulary of tracked projects and their aliases.

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid (PK) | |
| `slug` | text (UNIQUE, NOT NULL) | URL-safe identifier (e.g., 'mcp', 'goose', 'agents-md') |
| `name` | text (NOT NULL) | Display name (e.g., 'Model Context Protocol (MCP)') |
| `description` | text | Brief project description |
| `aliases` | text[] | Alternative names/abbreviations the agents should recognize |
| `website_url` | text | Official project URL |
| `github_url` | text | GitHub repository URL |
| `is_active` | boolean (DEFAULT true) | Whether actively tracking |
| `category` | text | 'protocol', 'framework', 'tool', 'standard', 'specification' |
| `created_at` | timestamptz | |

### Table: `topic_taxonomy`
Controlled vocabulary of content topics.

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid (PK) | |
| `slug` | text (UNIQUE, NOT NULL) | URL-safe identifier (e.g., 'agent-workflows', 'tool-calling') |
| `name` | text (NOT NULL) | Display name |
| `description` | text | What this topic covers |
| `parent_slug` | text (FK → topic_taxonomy.slug) | For hierarchical topics |
| `is_active` | boolean (DEFAULT true) | |
| `created_at` | timestamptz | |

### Indexes

```sql
-- Performance indexes
CREATE INDEX idx_content_items_content_type ON content_items(content_type);
CREATE INDEX idx_content_items_source_type ON content_items(source_type);
CREATE INDEX idx_content_items_projects ON content_items USING GIN(projects);
CREATE INDEX idx_content_items_topics ON content_items USING GIN(topics);
CREATE INDEX idx_content_items_publish_date ON content_items(publish_date DESC);
CREATE INDEX idx_content_items_quality_score ON content_items(quality_score DESC);

CREATE INDEX idx_content_segments_content_item ON content_segments(content_item_id);
CREATE INDEX idx_content_segments_projects ON content_segments USING GIN(projects);
CREATE INDEX idx_content_segments_topics ON content_segments USING GIN(topics);

CREATE INDEX idx_content_queue_status ON content_queue(status);
CREATE INDEX idx_content_queue_priority ON content_queue(priority, created_at);

CREATE INDEX idx_content_submissions_status ON content_submissions(status);

-- Vector similarity search indexes (pgvector)
CREATE INDEX idx_content_items_embedding ON content_items USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_content_segments_embedding ON content_segments USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

### Supabase Extensions Required

```sql
-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";       -- pgvector for embeddings
CREATE EXTENSION IF NOT EXISTS "pg_cron";       -- Scheduled jobs for discovery agent
CREATE EXTENSION IF NOT EXISTS "pg_net";        -- HTTP requests from database (for webhooks)
```

---

## Supabase Triggers and Edge Functions

### Trigger: New Submission → Triage Agent

When a row is inserted into `content_submissions`, fire a Supabase Edge Function (or database webhook) that invokes the Triage Agent.

```
ON INSERT content_submissions WHERE status = 'pending'
→ Call Triage Agent Edge Function
→ Agent classifies, expands, deduplicates
→ Writes to content_queue
→ Updates content_submissions.status
```

### Trigger: New Queue Item → Processing Agent

When a row is inserted into `content_queue`, fire a Supabase Edge Function that invokes the Processing Agent.

```
ON INSERT content_queue WHERE status = 'pending'
→ Call Processing Agent Edge Function
→ Agent scrapes, summarizes, generates segments
→ Writes to content_items + content_segments
→ Syncs to Sanity
→ Updates content_queue.status
```

### Scheduled: Discovery Agent

Use `pg_cron` to periodically check discovery sources.

```sql
-- Run discovery every hour for high-frequency sources
SELECT cron.schedule('discovery-hourly', '0 * * * *',
  $$ SELECT net.http_post(
    url := 'https://your-project.supabase.co/functions/v1/discovery-agent',
    body := '{"frequency": "1 hour"}'::jsonb
  ) $$
);

-- Run discovery every 6 hours for medium-frequency sources
SELECT cron.schedule('discovery-6h', '0 */6 * * *',
  $$ SELECT net.http_post(
    url := 'https://your-project.supabase.co/functions/v1/discovery-agent',
    body := '{"frequency": "6 hours"}'::jsonb
  ) $$
);

-- Run discovery daily for low-frequency sources
SELECT cron.schedule('discovery-daily', '0 6 * * *',
  $$ SELECT net.http_post(
    url := 'https://your-project.supabase.co/functions/v1/discovery-agent',
    body := '{"frequency": "1 day"}'::jsonb
  ) $$
);
```

### Scheduled: Content Refresh

Periodically re-check existing content items for updates (view counts, new comments, deleted content, etc.).

```sql
-- Refresh content weekly (check for stale/deleted content, update metrics)
SELECT cron.schedule('content-refresh', '0 3 * * 0',
  $$ SELECT net.http_post(
    url := 'https://your-project.supabase.co/functions/v1/content-refresh',
    body := '{}'::jsonb
  ) $$
);
```

---

## Sanity Integration

### Role

Sanity serves as the **presentation and delivery layer** — not the pipeline backbone. It receives finished, processed content from the Supabase pipeline and serves it to the public-facing Gatewaze website and external consumers.

### Sanity Content Model

The Sanity schema should mirror the key fields from `content_items` and `content_segments`, structured for frontend consumption:

**Document type: `contentItem`**
- `title` (string, required)
- `slug` (slug, auto-generated from title)
- `url` (url, required) — canonical source URL
- `contentType` (string, options: article, video, image, repo, tutorial, talk, podcast, documentation)
- `sourceType` (string, options: youtube, blog, github, twitter, conference, podcast, rss)
- `author` (string)
- `authorUrl` (url)
- `publishDate` (datetime)
- `summary` (text) — AI-generated summary
- `hotTake` (text) — editorial hot take
- `topics` (array of references → topic documents)
- `projects` (array of references → project documents)
- `keyPeople` (array of strings)
- `thumbnailUrl` (url) or `thumbnail` (image)
- `durationSeconds` (number) — for video/audio
- `hasSegments` (boolean)
- `segments` (array of objects):
  - `startTime` (number)
  - `endTime` (number)
  - `title` (string)
  - `summary` (text)
  - `topics` (array of strings)
  - `projects` (array of strings)
- `qualityScore` (number)
- `language` (string)
- `metadata` (object) — flexible additional data
- `supabaseId` (string, hidden) — for sync tracking

**Document type: `project`**
- `name` (string)
- `slug` (slug)
- `description` (text)
- `websiteUrl` (url)
- `githubUrl` (url)
- `category` (string)

**Document type: `topic`**
- `name` (string)
- `slug` (slug)
- `description` (text)
- `parent` (reference → topic)

### Sync Strategy

After the processing agent writes to `content_items` in Supabase, a sync step writes the content to Sanity:

1. Use the Sanity Client SDK (`@sanity/client`) in the processing agent or a dedicated sync Edge Function
2. Create or update the Sanity document using the Supabase `content_items.id` as a deterministic Sanity document ID (e.g., `contentItem-{supabase_uuid}`)
3. Store the Sanity document ID back in `content_items.sanity_document_id`
4. The sync is idempotent — running it again for the same content item updates rather than duplicates

### Sanity AI Features (Post-Ingestion)

Sanity's built-in AI features are used for **editorial operations after content is in the system**, not for the processing pipeline:

- **Content Agent:** Audit the database for gaps ("Which MCP projects have we not covered in 30 days?"), bulk-update metadata, find stale content
- **AI Assist:** Field-level AI for editorial refinements — alternative summaries, SEO metadata, translations
- **Agent Context (MCP):** External agents can query the Gatewaze content database via Sanity's MCP endpoint — this is a key value-add for the AAIF community

---

## Agent Orchestration

### Phase 1: Helix.ml (Development)

During development, agents run on Helix.ml which provides:
- Full GPU-accelerated desktop per agent with browser, terminal, filesystem
- Visual debugging — watch agents navigate sites, see where scraping fails
- Built-in web scraping, RAG backends, and MCP server support
- `helix.yaml` configuration for agent definitions

**Design principles for portability:**
- Keep agent logic (system prompts, tool definitions) as standalone files not deeply coupled to Helix's format
- Use Supabase as the state machine, not Helix — all pipeline state lives in the database tables
- Abstract browser interaction behind Playwright/Puppeteer so scraping code works headlessly too
- Each agent invocation should be a discrete session with a focused system prompt and relevant tools

### Phase 2: Agno (Production)

When agent logic is stable, migrate to Agno for production:
- Each agent becomes an Agno `Agent` class with tools and prompts
- Pipeline orchestration via Agno `Workflow` (deterministic, step-based execution)
- Stateless FastAPI backend that scales horizontally
- AgentOS monitoring UI for visibility
- Built-in MCP tool support for Supabase and other integrations
- Session management and memory for long-running discovery tasks

**Migration path:**
- Take proven system prompts and tool definitions from Helix
- Wrap in Agno's `Agent` class
- Connect via Agno `Workflow`
- Point Supabase triggers at Agno's FastAPI endpoints instead of Helix runners

---

## Content Sources (Initial Discovery Sources)

### Seed sources for `discovery_sources` table:

**YouTube Channels** (check_frequency: '6 hours')
- Key agentic AI creators and channels covering MCP, Goose, agents.md
- AAIF member organization channels
- Conference channels (AI Engineer Summit, etc.)

**RSS Feeds / Blogs** (check_frequency: '1 hour' to '1 day')
- Anthropic blog (MCP updates)
- Block blog (Goose updates)
- AAIF member blogs and tutorials
- Key tech blogs: The GitHub Blog, Dev.to (tagged agentic-ai, mcp, goose)
- AI-focused newsletters with public archives

**GitHub** (check_frequency: '6 hours')
- Trending repos tagged: mcp, agentic-ai, ai-agents, goose
- New releases on tracked repos (modelcontextprotocol/*, block/goose, etc.)
- awesome-mcp-servers, awesome-agents, awesome-ai-agents list changes

**Search** (check_frequency: '1 day')
- Google: "MCP model context protocol" + recent filter
- Google: "goose AI agent" + recent filter
- Google: "agents.md" + recent filter
- Google: "agentic AI tutorial" + recent filter

**Reddit** (check_frequency: '6 hours')
- r/MachineLearning, r/LocalLLaMA, r/LLMDevs — filtered for relevant keywords

**Hacker News** (check_frequency: '1 hour')
- Algolia HN API filtered for MCP, agentic AI, Goose keywords

---

## Frontend Search Experience

### Standard Search
- Full-text search across content_items (title, summary, raw_text, topics, projects)
- Semantic search via pgvector embeddings for natural language queries
- Faceted filtering by: content_type, source_type, projects, topics, date range
- Sort by: relevance, publish_date, quality_score

### Deep Video Search (Differentiator)
- Semantic search also runs against `content_segments` embeddings
- When a segment matches, display:
  - Video thumbnail with timecode overlay
  - Segment title and summary
  - Direct deep-link to that moment: `youtube.com/watch?v=xxx&t={start_time}`
  - Project and topic tags for the segment
  - Context: which video it's from, who created it, full video duration
- Users can browse a video's complete table of contents with all segments
- Filter segments by project or topic across all videos

### Content Item Page
- Full summary and hot take
- For video/audio: embedded player + interactive chapter markers (clickable segments)
- Project and topic tag links
- Related content (based on embedding similarity)
- Source link and metadata (author, publish date, duration, etc.)

---

## Add Content Feature

The public-facing Gatewaze site includes an "Add Content" feature:

1. User submits a URL (or optionally a search query/topic suggestion)
2. Frontend writes to `content_submissions` via Supabase client or API
3. Pipeline automatically processes it through triage → processing
4. User can optionally track status of their submission
5. Moderation: content is processed but may require editorial review in Sanity before being publicly visible (using Sanity's draft/publish workflow)

---

## Project Taxonomy (Initial)

### Projects (for `project_taxonomy`)

| Slug | Name | Category | Aliases |
|------|------|----------|---------|
| mcp | Model Context Protocol (MCP) | protocol | ['model context protocol', 'MCP protocol'] |
| goose | Goose | tool | ['goose agent', 'goose AI', 'block goose'] |
| agents-md | agents.md | specification | ['agents.md', 'agentsmd', 'agents md'] |
| a2a | Agent-to-Agent Protocol (A2A) | protocol | ['agent2agent', 'agent to agent', 'A2A protocol'] |
| langchain | LangChain | framework | ['lang chain'] |
| langgraph | LangGraph | framework | ['lang graph'] |
| crewai | CrewAI | framework | ['crew ai', 'crew AI'] |
| autogen | AutoGen | framework | ['auto gen', 'microsoft autogen'] |
| agno | Agno | framework | ['agno agi', 'phidata'] |
| llamaindex | LlamaIndex | framework | ['llama index'] |
| openai-agents-sdk | OpenAI Agents SDK | framework | ['openai agents', 'responses api'] |
| claude-code | Claude Code | tool | ['claude code'] |
| cursor | Cursor | tool | ['cursor ai', 'cursor editor'] |

### Topics (for `topic_taxonomy`)

| Slug | Name | Parent |
|------|------|--------|
| agent-workflows | Agent Workflows | null |
| tool-calling | Tool Calling & Function Use | null |
| multi-agent | Multi-Agent Systems | null |
| rag | Retrieval-Augmented Generation | null |
| memory | Agent Memory | null |
| planning | Planning & Reasoning | null |
| security | Agent Security | null |
| observability | Observability & Monitoring | null |
| evaluation | Agent Evaluation & Benchmarks | null |
| deployment | Production Deployment | null |
| browser-automation | Browser Automation | tool-calling |
| code-generation | Code Generation | agent-workflows |
| voice-agents | Voice & Multimodal Agents | agent-workflows |
| human-in-the-loop | Human-in-the-Loop | agent-workflows |
| prompt-engineering | Prompt Engineering | null |
| open-source | Open Source | null |

---

## Implementation Order

### Phase 1: Foundation
1. Set up Supabase project with all tables, indexes, extensions (pgvector, pg_cron, pg_net)
2. Seed `project_taxonomy` and `topic_taxonomy` tables
3. Set up Sanity project with content model (contentItem, project, topic schemas)
4. Build the Supabase → Sanity sync utility

### Phase 2: Processing Agent (Most Complex)
5. Build the processing agent with content-type-specific handlers:
   - YouTube video handler (yt-dlp + transcript extraction + deep indexing)
   - Article/blog handler (Playwright scraping + content extraction)
   - GitHub repo handler
6. Test extensively in Helix with visual debugging
7. Verify end-to-end: content_queue → content_items + content_segments → Sanity

### Phase 3: Triage Agent
8. Build the triage agent (URL classification, expansion, deduplication)
9. Wire up Supabase trigger: content_submissions → triage agent → content_queue
10. Test with various input types (single URLs, playlist URLs, blog index pages)

### Phase 4: Discovery Agent
11. Build the discovery agent with source-specific handlers
12. Seed `discovery_sources` table with initial sources
13. Set up pg_cron schedules
14. Test discovery → submission → triage → processing full pipeline

### Phase 5: Frontend
15. Build Gatewaze frontend consuming Sanity
16. Implement search (full-text + semantic via Supabase)
17. Build deep video search experience with timecoded results
18. Build content item pages with interactive video chapters
19. Build "Add Content" submission form

### Phase 6: Production Hardening
20. Migrate agents from Helix to Agno
21. Set up monitoring and alerting on agent failures
22. Implement content refresh scheduling
23. Editorial review workflow in Sanity Studio
24. Rate limiting and abuse prevention on "Add Content"

---

## Key Design Decisions Summary

1. **Three agents, not one or two** — Triage, Processing, and Discovery have fundamentally different characteristics and failure modes. Separating them prevents context bloat and cascading failures.

2. **Supabase for pipeline, Sanity for presentation** — Supabase is the operational database handling state machines, triggers, scheduling, and vector search. Sanity is the structured content delivery layer for the public site and MCP endpoint.

3. **Helix for development, Agno for production** — Visual debugging during development is invaluable for scraping agents. Once logic is stable, Agno provides the production runtime with scaling, monitoring, and workflow orchestration.

4. **Deep video indexing is a first-class feature** — Not an afterthought. The `content_segments` table and segment-level embeddings make timestamped topic search a core capability.

5. **Agent logic must be portable** — System prompts, tool definitions, and pipeline logic should not be tightly coupled to any orchestration framework, enabling the Helix → Agno migration.

6. **Supabase owns pipeline state** — All status tracking, retry logic, and queue management lives in the database, not in the agent orchestrator. This makes the orchestrator swappable.

7. **Sanity's AI features are for editorial ops, not ingestion** — Content Agent, AI Assist, and Agent Context add value post-ingestion for auditing, gap analysis, and serving content to external agents via MCP.
