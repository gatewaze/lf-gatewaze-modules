# AAIF Content Intelligence Modules for Gatewaze

## Executive Summary

The AAIF Content Intelligence modules extend **Gatewaze** — a community management platform — with AI-powered content discovery, processing, and deep indexing capabilities. Built for the Linux Foundation's Agentic AI Foundation (AAIF), these modules add an autonomous content pipeline that continuously finds, analyzes, and indexes online content related to the agentic AI ecosystem.

The modules plug into Gatewaze's existing module system, adding database tables, admin UI pages, and AI agent configurations. A Gatewaze instance with these modules installed gains the ability to automatically build and maintain a searchable knowledge base of blog posts, YouTube videos, tutorials, conference talks, GitHub repositories, and podcasts — without manual curation.

A key differentiator is **deep video indexing**: rather than treating a video as a single searchable item, the pipeline breaks it into timestamped, topic-tagged segments. Users can search for a concept like "MCP server authentication" and be linked directly to the exact moment in a conference talk where that topic is discussed.

---

## How Gatewaze's Module System Works

Gatewaze is a modular community platform built on Supabase (PostgreSQL). Modules are self-contained packages that can add database schemas, admin UI pages, API routes, and configuration to a Gatewaze instance. They are auto-discovered from configured sources — local directories, Git repositories, or via the admin UI — and managed through enable/disable toggles. Enabling a module runs its database migrations against the Gatewaze Supabase instance and executes lifecycle hooks automatically.

The AAIF content intelligence capability is delivered as two modules:

| Module | Role |
|--------|------|
| **Content Pipeline** | Database infrastructure, admin UI, and service layer for the entire content pipeline |
| **Content Discovery** | AI agent definitions and orchestration configuration (depends on Content Pipeline) |

This modular approach means the content intelligence features are cleanly separated from the Gatewaze core. They can be versioned, enabled, or disabled independently, and other Gatewaze deployments could install them to gain the same capabilities for their own communities.

---

## What the Modules Do

### Automated Content Discovery
The discovery module continuously monitors configured sources — YouTube channels, RSS feeds, GitHub repositories, Reddit, Hacker News, and web search — for new content related to tracked agentic AI projects. When new content is found, it enters an automated processing pipeline without human intervention.

### Intelligent Processing
Each piece of content is automatically:
- **Classified** by type (article, video, podcast, repository, tutorial, conference talk)
- **Summarized** with a concise overview and an opinionated "hot take" on its significance
- **Tagged** against a controlled taxonomy of projects (MCP, Goose, LangChain, CrewAI, etc.) and topics (tool-calling, multi-agent systems, security, deployment, etc.)
- **Scored** for quality and relevance
- **Deduplicated** across platforms (e.g., the same talk appearing on YouTube and as a podcast)

### Deep Video & Audio Indexing
For video and audio content, the pipeline performs segment-level indexing:
- Transcripts are extracted (via captions or speech-to-text)
- An LLM breaks the content into logical chapters with start/end timestamps
- Each segment is individually tagged with relevant projects, topics, and people
- Segment-level vector embeddings enable semantic search at the chapter level
- Search results link directly to the relevant timestamp (e.g., `youtube.com/watch?v=xxx&t=184`)

### Searchable Knowledge Base
The processed content is served through:
- **Full-text search** across titles, summaries, and transcripts
- **Semantic search** via vector embeddings for natural language queries
- **Faceted filtering** by content type, source, project, topic, and date
- **Deep video search** that returns specific timestamped segments, not just whole videos

### Event Discovery & Calendar
The pipeline will also discover and scrape events — conferences, meetups, webinars, hackathons, and community calls — from online sources. These are processed into a community calendar of upcoming agentic AI events, giving AAIF members a single place to find what's happening across the ecosystem.

### Community Contributions
Community members can submit content URLs directly, and suggest new sources or projects to track. Suggestions are surfaced for review with voting and can be converted into monitored sources by admins.

### Admin Interface
The Content Pipeline module adds a full admin section to Gatewaze with:
- Pipeline dashboard with stats across all stages
- Submission and queue management
- Content browser with search and filtering
- Taxonomy editor for projects and topics
- Discovery source configuration and run history
- Community suggestion review and conversion

---

## Architecture

### Design Principles

1. **Separation of concerns** — The pipeline is split into three independent agent stages (discovery, triage, processing) so failures don't cascade and each stage can scale independently.
2. **Database as state machine** — All pipeline state, queues, and retry logic live in the database, not in agent orchestration code. This makes the agent runtime swappable.
3. **Portable agent logic** — Agent prompts and tool definitions are not tightly coupled to any orchestration framework. Agents are developed and debugged visually in Helix.ml, then migrated to a production runtime such as Agno once logic is proven.
4. **Modular and self-contained** — Everything needed to run the content pipeline is packaged in the two modules: database migrations, admin UI, service layer, and agent definitions.

### Technology Stack

| Layer | Technology | Role |
|-------|-----------|------|
| Community Platform | **Gatewaze** (backed by **Supabase**) | Module host, admin UI, user management, frontend, operational database (PostgreSQL), vector search (pgvector), scheduling, edge functions |
| Agent Development | **Helix.ml** | Visual agent IDE with browser access for building and debugging agents |
| Agent Runtime (Production) | **Agno** (or equivalent) | Production agent framework with scaling, monitoring, and workflow orchestration |
| AI Model | **Claude Sonnet 4** | Content analysis, summarization, topic tagging, segmentation |
| Content Delivery | **Sanity.io** | Structured CMS for public content, editorial workflows, MCP endpoint |

### System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CONTENT SOURCES                              │
│  YouTube  ·  RSS/Blogs  ·  GitHub  ·  Reddit  ·  Hacker News  ·     │
│  Google Search  ·  Conference sites  ·  Podcasts  ·  Twitter/X      │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│              AGENT PIPELINE (Helix.ml → Production Runtime)          │
│                                                                      │
│  ┌──────────────────┐                                                │
│  │  DISCOVERY AGENT │  Hourly scheduled scans of configured sources  │
│  │  (Claude Sonnet) │  Deduplicates against existing content         │
│  └────────┬─────────┘                                                │
│           │ new URLs                                                 │
│           ▼                                                          │
│  ┌──────────────────┐                                                │
│  │   TRIAGE AGENT   │  Classifies content type & source              │
│  │  (Claude Sonnet) │  Expands collections into individual items     │
│  │   Every 5 min    │  Deduplicates, assigns priority                │
│  └────────┬─────────┘                                                │
│           │ classified items                                         │
│           ▼                                                          │
│  ┌──────────────────┐                                                │
│  │ PROCESSING AGENT │  Extracts full content & metadata              │
│  │  (Claude Sonnet) │  Generates summaries, hot takes, tags          │
│  │   Every 5 min    │  Performs deep video/audio segmentation        │
│  │                  │  Detects cross-platform duplicates             │
│  └────────┬─────────┘                                                │
│           │                                                          │
└───────────┼──────────────────────────────────────────────────────────┘
            │ processed content
            ▼
┌──────────────────────────────────────────────────────────────────────┐
│              GATEWAZE (Community Management Platform)                │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                    CONTENT PIPELINE MODULE                     │  │
│  │        (tables managed within Gatewaze's Supabase instance)    │  │
│  │                                                                │  │
│  │  ┌───────────────┐  ┌────────────────┐  ┌──────────────────┐   │  │
│  │  │ content_items │  │content_segments│  │content_duplicates│   │  │
│  │  │ (processed    │  │ (timestamped   │  │ (cross-platform  │   │  │
│  │  │  content)     │  │  chapters)     │  │  relationships)  │   │  │
│  │  └───────────────┘  └────────────────┘  └──────────────────┘   │  │
│  │                                                                │  │
│  │  pgvector embeddings  ·  Full-text search  ·  RLS security     │  │
│  │  Pipeline state tables  ·  Taxonomy  ·  Discovery config       │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                     ADMIN UI PAGES                             │  │
│  │  Dashboard · Submissions · Queue · Content · Taxonomy ·        │  │
│  │  Discovery Sources · Suggestions                               │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ sync
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        SANITY.IO (CMS)                               │
│                                                                      │
│  Structured content for public site  ·  Editorial review workflow    │
│  AI-assisted content auditing  ·  MCP endpoint for external agents   │
└──────────────────────────────────────────────────────────────────────┘
```

### Agent Pipeline

The three-agent architecture is an intentional design choice. Each agent has fundamentally different characteristics:

**Discovery Agent** — Broad and exploratory. Scans many sources, makes quick relevance judgements, and submits URLs. Runs hourly. Low failure impact (a missed source is retried next cycle).

**Triage Agent** — Classification and fan-out. Takes a single URL or collection (e.g., a YouTube playlist) and expands it into individual queue items with correct type classification and priority. Performs URL-level and cross-platform deduplication. Runs every 5 minutes.

**Processing Agent** — Deep and content-type-specific. Browses each URL, extracts full content, generates AI analysis (summaries, tags, quality scores), and performs video segmentation. The most computationally intensive stage. Runs every 5 minutes, processing up to 5 items per batch.

Combining these into a single agent would create bloated context windows, make failures cascade across unrelated operations, and prevent independent scaling of each stage.

### Data Model

The database is organized around a progression from raw input to fully processed output:

```
content_submissions  →  content_queue  →  content_items  →  content_segments
    (raw URLs)         (classified &      (fully processed    (timestamped
                        prioritized)       with AI analysis)   video chapters)
```

Supporting tables provide:
- **Taxonomy** — Controlled vocabularies of tracked projects (13 initially) and topics (16 initially) with aliases and hierarchical relationships
- **Discovery configuration** — Source definitions with check frequencies, enabling/disabling, and run history logging
- **Duplicate tracking** — Cross-platform content relationships with confidence scores and match methods
- **Community suggestions** — User-submitted monitoring ideas with voting and conversion workflows

Vector embeddings (1536-dimensional, via pgvector) are stored at both the content item and segment level, enabling semantic search that goes beyond keyword matching.

### Content Delivery

Processed content syncs from Supabase to Sanity.io for public presentation:

- **Sanity Studio** provides an editorial interface for reviewing, refining, and publishing content
- **GROQ queries** power the frontend with flexible, real-time content delivery
- **Sanity's MCP endpoint** allows external AI agents to query the knowledge base — a direct value-add for AAIF member projects building agentic tools
- **AI Assist** enables editorial teams to refine summaries, generate SEO metadata, and identify content gaps

---

## Content Coverage

### Tracked Projects (Initial)
MCP (Model Context Protocol), Goose, agents.md, A2A (Agent-to-Agent Protocol), LangChain, LangGraph, CrewAI, AutoGen, Agno, LlamaIndex, OpenAI Agents SDK, Claude Code, Cursor

### Tracked Topics (Initial)
Agent Workflows, Tool Calling, Multi-Agent Systems, RAG, Agent Memory, Planning & Reasoning, Security, Observability, Evaluation & Benchmarks, Deployment, Browser Automation, Code Generation, Voice & Multimodal Agents, Human-in-the-Loop, Prompt Engineering, Open Source

### Content Sources
YouTube channels, RSS feeds/blogs, GitHub (trending repos, releases), Google Search, Reddit (r/MachineLearning, r/LocalLLaMA, r/LLMDevs), Hacker News, conference sites, podcast platforms

### Content Types
Articles, videos, podcasts, GitHub repositories, tutorials, conference talks, documentation, images, events

---

## Production Roadmap

| Phase | Focus | Status |
|-------|-------|--------|
| 1. Foundation | Database schema, taxonomies, Sanity content model, sync utility | Built |
| 2. Processing Agent | Content-type-specific handlers, deep video indexing, quality scoring | Built |
| 3. Triage Agent | URL classification, collection expansion, deduplication | Built |
| 4. Discovery Agent | Source scanning, scheduled discovery, full pipeline integration | Built |
| 5. Frontend | Public website, search (full-text + semantic), deep video search, content submission | Planned |
| 6. Events & Calendar | Event discovery from online sources, community calendar of agentic AI events | Planned |
| 7. Production Hardening | Migrate agents from Helix to a production runtime (e.g., Agno), monitoring/alerting, editorial workflows, rate limiting | Planned |

The complete backend pipeline is built — from automated discovery through to processed, searchable content. Agents are currently developed and tested in Helix.ml, which provides visual debugging and browser-based agent interaction. Once agent logic is stable, the plan is to migrate to a production-grade agent runtime such as Agno for scaling, monitoring, and workflow orchestration. The next milestones are the public-facing frontend and this production runtime migration.
