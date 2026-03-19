-- ============================================================================
-- Module: content-pipeline
-- Migration: 002_seed_taxonomy
-- Description: Seed project and topic taxonomy with initial data
-- ============================================================================

-- ============================================================================
-- Seed Projects
-- ============================================================================
INSERT INTO public.content_project_taxonomy (slug, name, description, aliases, website_url, github_url, category) VALUES
  ('mcp', 'Model Context Protocol (MCP)', 'Universal protocol for connecting AI models to external tools and data sources', ARRAY['model context protocol', 'MCP protocol'], 'https://modelcontextprotocol.io', 'https://github.com/modelcontextprotocol', 'protocol'),
  ('goose', 'Goose', 'Open source AI developer agent by Block', ARRAY['goose agent', 'goose AI', 'block goose'], 'https://block.github.io/goose/', 'https://github.com/block/goose', 'tool'),
  ('agents-md', 'agents.md', 'Specification for declaring AI agent capabilities', ARRAY['agents.md', 'agentsmd', 'agents md'], NULL, NULL, 'specification'),
  ('a2a', 'Agent-to-Agent Protocol (A2A)', 'Protocol for inter-agent communication', ARRAY['agent2agent', 'agent to agent', 'A2A protocol'], NULL, NULL, 'protocol'),
  ('langchain', 'LangChain', 'Framework for developing applications powered by language models', ARRAY['lang chain'], 'https://langchain.com', 'https://github.com/langchain-ai/langchain', 'framework'),
  ('langgraph', 'LangGraph', 'Framework for building stateful multi-agent applications', ARRAY['lang graph'], 'https://langchain.com/langgraph', 'https://github.com/langchain-ai/langgraph', 'framework'),
  ('crewai', 'CrewAI', 'Framework for orchestrating role-playing AI agents', ARRAY['crew ai', 'crew AI'], 'https://crewai.com', 'https://github.com/crewAIInc/crewAI', 'framework'),
  ('autogen', 'AutoGen', 'Framework for building multi-agent conversational systems', ARRAY['auto gen', 'microsoft autogen'], NULL, 'https://github.com/microsoft/autogen', 'framework'),
  ('agno', 'Agno', 'Full-stack framework for building AI agents', ARRAY['agno agi', 'phidata'], 'https://agno.com', 'https://github.com/agno-agi/agno', 'framework'),
  ('llamaindex', 'LlamaIndex', 'Data framework for LLM applications', ARRAY['llama index'], 'https://llamaindex.ai', 'https://github.com/run-llama/llama_index', 'framework'),
  ('openai-agents-sdk', 'OpenAI Agents SDK', 'SDK for building agentic AI applications with OpenAI', ARRAY['openai agents', 'responses api'], 'https://openai.com', 'https://github.com/openai/openai-agents-python', 'framework'),
  ('claude-code', 'Claude Code', 'Anthropic''s agentic coding tool', ARRAY['claude code'], 'https://claude.ai', NULL, 'tool'),
  ('cursor', 'Cursor', 'AI-first code editor', ARRAY['cursor ai', 'cursor editor'], 'https://cursor.com', NULL, 'tool')
ON CONFLICT (slug) DO NOTHING;

-- ============================================================================
-- Seed Topics
-- ============================================================================
INSERT INTO public.content_topic_taxonomy (slug, name, description, parent_slug) VALUES
  ('agent-workflows', 'Agent Workflows', 'Design and implementation of AI agent workflows', NULL),
  ('tool-calling', 'Tool Calling & Function Use', 'How agents interact with external tools and APIs', NULL),
  ('multi-agent', 'Multi-Agent Systems', 'Architectures and patterns for multi-agent collaboration', NULL),
  ('rag', 'Retrieval-Augmented Generation', 'Combining retrieval systems with generative AI', NULL),
  ('memory', 'Agent Memory', 'Persistent and working memory systems for AI agents', NULL),
  ('planning', 'Planning & Reasoning', 'Agent planning, reasoning, and decision-making capabilities', NULL),
  ('security', 'Agent Security', 'Security considerations and best practices for AI agents', NULL),
  ('observability', 'Observability & Monitoring', 'Monitoring, logging, and debugging AI agent systems', NULL),
  ('evaluation', 'Agent Evaluation & Benchmarks', 'Testing, evaluating, and benchmarking AI agents', NULL),
  ('deployment', 'Production Deployment', 'Deploying and scaling AI agents in production', NULL),
  ('browser-automation', 'Browser Automation', 'Using AI agents for web browser automation', 'tool-calling'),
  ('code-generation', 'Code Generation', 'AI-powered code generation and development', 'agent-workflows'),
  ('voice-agents', 'Voice & Multimodal Agents', 'Voice-enabled and multimodal AI agents', 'agent-workflows'),
  ('human-in-the-loop', 'Human-in-the-Loop', 'Patterns for human oversight and intervention in agent workflows', 'agent-workflows'),
  ('prompt-engineering', 'Prompt Engineering', 'Techniques for crafting effective prompts for AI agents', NULL),
  ('open-source', 'Open Source', 'Open source projects and community contributions', NULL)
ON CONFLICT (slug) DO NOTHING;
