import { supabase } from '@/lib/supabase';

// ============================================================================
// Types
// ============================================================================

export interface ContentSubmission {
  id: string;
  url?: string | null;
  search_query?: string | null;
  submitted_by: string;
  submission_type: 'url' | 'search_query';
  status: 'pending' | 'triaging' | 'completed' | 'failed' | 'duplicate';
  error_message?: string | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContentQueueItem {
  id: string;
  submission_id?: string | null;
  url: string;
  title?: string | null;
  content_type?: string | null;
  source_type?: string | null;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  priority: number;
  retry_count: number;
  max_retries: number;
  error_message?: string | null;
  metadata?: Record<string, any>;
  created_at: string;
  updated_at: string;
  processing_started_at?: string | null;
}

export interface ContentItem {
  id: string;
  queue_id?: string | null;
  url: string;
  title: string;
  content_type: string;
  source_type: string;
  author?: string | null;
  author_url?: string | null;
  publish_date?: string | null;
  summary?: string | null;
  hot_take?: string | null;
  topics: string[];
  projects: string[];
  key_people: string[];
  thumbnail_url?: string | null;
  duration_seconds?: number | null;
  raw_text?: string | null;
  transcript?: string | null;
  has_segments: boolean;
  language: string;
  metadata?: Record<string, any>;
  sanity_document_id?: string | null;
  quality_score?: number | null;
  discovered_at?: string | null;
  processed_at?: string | null;
  refreshed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContentSegment {
  id: string;
  content_item_id: string;
  segment_index: number;
  start_time: number;
  end_time: number;
  title: string;
  summary?: string | null;
  topics: string[];
  projects: string[];
  key_people: string[];
  transcript_text?: string | null;
  created_at: string;
}

export interface ProjectTaxonomy {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  aliases: string[];
  website_url?: string | null;
  github_url?: string | null;
  is_active: boolean;
  category?: string | null;
  created_at: string;
}

export interface TopicTaxonomy {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  parent_slug?: string | null;
  is_active: boolean;
  created_at: string;
}

export interface DiscoverySource {
  id: string;
  name: string;
  source_type: string;
  source_url?: string | null;
  search_query?: string | null;
  check_frequency: string;
  last_checked_at?: string | null;
  is_active: boolean;
  priority: number;
  metadata?: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface DiscoveryRun {
  id: string;
  source_id?: string | null;
  status: 'running' | 'completed' | 'failed';
  items_found: number;
  items_submitted: number;
  error_message?: string | null;
  started_at: string;
  completed_at?: string | null;
  source?: DiscoverySource;
}

export interface MonitoringSuggestion {
  id: string;
  suggestion_type: string;
  title: string;
  description?: string | null;
  search_query?: string | null;
  url?: string | null;
  submitted_by: string;
  submitted_by_id?: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'converted';
  admin_notes?: string | null;
  converted_source_id?: string | null;
  converted_project_id?: string | null;
  vote_count: number;
  created_at: string;
  updated_at: string;
  reviewed_at?: string | null;
}

export interface PipelineStats {
  total_items: number;
  total_videos: number;
  total_articles: number;
  total_segments: number;
  pending_submissions: number;
  pending_queue: number;
  processing_queue: number;
  failed_queue: number;
  active_sources: number;
  items_last_24h: number;
  discovery_runs_last_24h: number;
  tracked_projects: number;
  tracked_topics: number;
  pending_suggestions: number;
}

export interface ServiceResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  total?: number;
}

// ============================================================================
// Helpers
// ============================================================================

export function generateSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ============================================================================
// Pipeline Stats
// ============================================================================

export class PipelineStatsService {
  static async getStats(): Promise<ServiceResponse<PipelineStats>> {
    try {
      const { data, error } = await supabase.rpc('content_pipeline_stats');
      if (error) throw error;
      return { success: true, data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}

// ============================================================================
// Content Submissions
// ============================================================================

export class SubmissionsService {
  static async getAll(filters?: {
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<ServiceResponse<ContentSubmission[]>> {
    try {
      let query = supabase
        .from('content_submissions')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false });

      if (filters?.status) query = query.eq('status', filters.status);
      if (filters?.limit) query = query.limit(filters.limit);
      if (filters?.offset) query = query.range(filters.offset, filters.offset + (filters.limit || 20) - 1);

      const { data, error, count } = await query;
      if (error) throw error;
      return { success: true, data: data || [], total: count ?? 0 };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async create(submission: Partial<ContentSubmission>): Promise<ServiceResponse<ContentSubmission>> {
    try {
      const { data, error } = await supabase
        .from('content_submissions')
        .insert(submission)
        .select()
        .single();

      if (error) throw error;
      return { success: true, data, message: 'Submission created' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async updateStatus(id: string, status: string, errorMessage?: string): Promise<ServiceResponse> {
    try {
      const updates: any = { status };
      if (errorMessage) updates.error_message = errorMessage;

      const { error } = await supabase
        .from('content_submissions')
        .update(updates)
        .eq('id', id);

      if (error) throw error;
      return { success: true, message: 'Status updated' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async delete(id: string): Promise<ServiceResponse> {
    try {
      const { error } = await supabase
        .from('content_submissions')
        .delete()
        .eq('id', id);

      if (error) throw error;
      return { success: true, message: 'Submission deleted' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}

// ============================================================================
// Content Queue
// ============================================================================

export class QueueService {
  static async getAll(filters?: {
    status?: string;
    content_type?: string;
    priority?: number;
    limit?: number;
    offset?: number;
  }): Promise<ServiceResponse<ContentQueueItem[]>> {
    try {
      let query = supabase
        .from('content_queue')
        .select('*', { count: 'exact' })
        .order('priority', { ascending: true })
        .order('created_at', { ascending: true });

      if (filters?.status) query = query.eq('status', filters.status);
      if (filters?.content_type) query = query.eq('content_type', filters.content_type);
      if (filters?.priority) query = query.eq('priority', filters.priority);
      if (filters?.limit) query = query.limit(filters.limit);
      if (filters?.offset) query = query.range(filters.offset, filters.offset + (filters.limit || 20) - 1);

      const { data, error, count } = await query;
      if (error) throw error;
      return { success: true, data: data || [], total: count ?? 0 };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async updateStatus(id: string, status: string, errorMessage?: string): Promise<ServiceResponse> {
    try {
      const updates: any = { status };
      if (errorMessage) updates.error_message = errorMessage;
      if (status === 'processing') updates.processing_started_at = new Date().toISOString();

      const { error } = await supabase
        .from('content_queue')
        .update(updates)
        .eq('id', id);

      if (error) throw error;
      return { success: true, message: 'Queue item updated' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async retry(id: string): Promise<ServiceResponse> {
    try {
      const { error } = await supabase
        .from('content_queue')
        .update({
          status: 'pending',
          error_message: null,
          processing_started_at: null,
        })
        .eq('id', id);

      if (error) throw error;
      return { success: true, message: 'Item queued for retry' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async delete(id: string): Promise<ServiceResponse> {
    try {
      const { error } = await supabase
        .from('content_queue')
        .delete()
        .eq('id', id);

      if (error) throw error;
      return { success: true, message: 'Queue item deleted' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}

// ============================================================================
// Content Items
// ============================================================================

export class ContentItemsService {
  static async getAll(filters?: {
    content_type?: string;
    source_type?: string;
    project?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<ServiceResponse<ContentItem[]>> {
    try {
      let query = supabase
        .from('content_items')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false });

      if (filters?.content_type) query = query.eq('content_type', filters.content_type);
      if (filters?.source_type) query = query.eq('source_type', filters.source_type);
      if (filters?.project) query = query.contains('projects', [filters.project]);
      if (filters?.search) query = query.or(`title.ilike.%${filters.search}%,summary.ilike.%${filters.search}%`);
      if (filters?.limit) query = query.limit(filters.limit);
      if (filters?.offset) query = query.range(filters.offset, filters.offset + (filters.limit || 20) - 1);

      const { data, error, count } = await query;
      if (error) throw error;
      return { success: true, data: data || [], total: count ?? 0 };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async getById(id: string): Promise<ServiceResponse<ContentItem>> {
    try {
      const { data, error } = await supabase
        .from('content_items')
        .select('*')
        .eq('id', id)
        .single();

      if (error) throw error;
      return { success: true, data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async getSegments(contentItemId: string): Promise<ServiceResponse<ContentSegment[]>> {
    try {
      const { data, error } = await supabase
        .from('content_segments')
        .select('*')
        .eq('content_item_id', contentItemId)
        .order('segment_index', { ascending: true });

      if (error) throw error;
      return { success: true, data: data || [] };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async delete(id: string): Promise<ServiceResponse> {
    try {
      const { error } = await supabase
        .from('content_items')
        .delete()
        .eq('id', id);

      if (error) throw error;
      return { success: true, message: 'Content item deleted' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}

// ============================================================================
// Project Taxonomy
// ============================================================================

export class ProjectsService {
  static async getAll(): Promise<ServiceResponse<ProjectTaxonomy[]>> {
    try {
      const { data, error } = await supabase
        .from('content_project_taxonomy')
        .select('*')
        .order('name');

      if (error) throw error;
      return { success: true, data: data || [] };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async create(project: Partial<ProjectTaxonomy>): Promise<ServiceResponse<ProjectTaxonomy>> {
    try {
      const slug = project.slug || generateSlug(project.name || '');
      const { data, error } = await supabase
        .from('content_project_taxonomy')
        .insert({ ...project, slug })
        .select()
        .single();

      if (error) throw error;
      return { success: true, data, message: 'Project created' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async update(id: string, updates: Partial<ProjectTaxonomy>): Promise<ServiceResponse<ProjectTaxonomy>> {
    try {
      const { data, error } = await supabase
        .from('content_project_taxonomy')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return { success: true, data, message: 'Project updated' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async delete(id: string): Promise<ServiceResponse> {
    try {
      const { error } = await supabase
        .from('content_project_taxonomy')
        .delete()
        .eq('id', id);

      if (error) throw error;
      return { success: true, message: 'Project deleted' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}

// ============================================================================
// Topic Taxonomy
// ============================================================================

export class TopicsService {
  static async getAll(): Promise<ServiceResponse<TopicTaxonomy[]>> {
    try {
      const { data, error } = await supabase
        .from('content_topic_taxonomy')
        .select('*')
        .order('name');

      if (error) throw error;
      return { success: true, data: data || [] };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async create(topic: Partial<TopicTaxonomy>): Promise<ServiceResponse<TopicTaxonomy>> {
    try {
      const slug = topic.slug || generateSlug(topic.name || '');
      const { data, error } = await supabase
        .from('content_topic_taxonomy')
        .insert({ ...topic, slug })
        .select()
        .single();

      if (error) throw error;
      return { success: true, data, message: 'Topic created' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async update(id: string, updates: Partial<TopicTaxonomy>): Promise<ServiceResponse<TopicTaxonomy>> {
    try {
      const { data, error } = await supabase
        .from('content_topic_taxonomy')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return { success: true, data, message: 'Topic updated' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async delete(id: string): Promise<ServiceResponse> {
    try {
      const { error } = await supabase
        .from('content_topic_taxonomy')
        .delete()
        .eq('id', id);

      if (error) throw error;
      return { success: true, message: 'Topic deleted' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}

// ============================================================================
// Discovery Sources
// ============================================================================

export class DiscoverySourcesService {
  static async getAll(): Promise<ServiceResponse<DiscoverySource[]>> {
    try {
      const { data, error } = await supabase
        .from('content_discovery_sources')
        .select('*')
        .order('name');

      if (error) throw error;
      return { success: true, data: data || [] };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async create(source: Partial<DiscoverySource>): Promise<ServiceResponse<DiscoverySource>> {
    try {
      const { data, error } = await supabase
        .from('content_discovery_sources')
        .insert(source)
        .select()
        .single();

      if (error) throw error;
      return { success: true, data, message: 'Discovery source created' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async update(id: string, updates: Partial<DiscoverySource>): Promise<ServiceResponse<DiscoverySource>> {
    try {
      const { data, error } = await supabase
        .from('content_discovery_sources')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return { success: true, data, message: 'Discovery source updated' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async delete(id: string): Promise<ServiceResponse> {
    try {
      const { error } = await supabase
        .from('content_discovery_sources')
        .delete()
        .eq('id', id);

      if (error) throw error;
      return { success: true, message: 'Discovery source deleted' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async getRecentRuns(sourceId?: string, limit: number = 20): Promise<ServiceResponse<DiscoveryRun[]>> {
    try {
      let query = supabase
        .from('content_discovery_runs')
        .select('*, source:content_discovery_sources(*)')
        .order('started_at', { ascending: false })
        .limit(limit);

      if (sourceId) query = query.eq('source_id', sourceId);

      const { data, error } = await query;
      if (error) throw error;
      return { success: true, data: data || [] };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}

// ============================================================================
// Monitoring Suggestions
// ============================================================================

export class MonitoringSuggestionsService {
  static async getAll(filters?: {
    status?: string;
    suggestion_type?: string;
    limit?: number;
    offset?: number;
  }): Promise<ServiceResponse<MonitoringSuggestion[]>> {
    try {
      let query = supabase
        .from('content_monitoring_suggestions')
        .select('*', { count: 'exact' })
        .order('vote_count', { ascending: false })
        .order('created_at', { ascending: false });

      if (filters?.status) query = query.eq('status', filters.status);
      if (filters?.suggestion_type) query = query.eq('suggestion_type', filters.suggestion_type);
      if (filters?.limit) query = query.limit(filters.limit);
      if (filters?.offset) query = query.range(filters.offset, filters.offset + (filters.limit || 20) - 1);

      const { data, error, count } = await query;
      if (error) throw error;
      return { success: true, data: data || [], total: count ?? 0 };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async create(suggestion: Partial<MonitoringSuggestion>): Promise<ServiceResponse<MonitoringSuggestion>> {
    try {
      const { data, error } = await supabase
        .from('content_monitoring_suggestions')
        .insert(suggestion)
        .select()
        .single();

      if (error) throw error;
      return { success: true, data, message: 'Suggestion submitted' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async updateStatus(
    id: string,
    status: string,
    adminNotes?: string,
  ): Promise<ServiceResponse> {
    try {
      const updates: any = {
        status,
        reviewed_at: new Date().toISOString(),
      };
      if (adminNotes !== undefined) updates.admin_notes = adminNotes;

      const { error } = await supabase
        .from('content_monitoring_suggestions')
        .update(updates)
        .eq('id', id);

      if (error) throw error;
      return { success: true, message: 'Suggestion updated' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async convertToSource(id: string, suggestion: MonitoringSuggestion): Promise<ServiceResponse> {
    try {
      // Map suggestion_type to discovery source_type
      const sourceTypeMap: Record<string, string> = {
        search_query: 'google_search',
        youtube_channel: 'youtube_channel',
        rss_feed: 'rss',
        github_topic: 'github_topic',
        github_repo: 'github_repo',
        website: 'website',
        reddit_subreddit: 'reddit_subreddit',
      };

      const sourceType = sourceTypeMap[suggestion.suggestion_type];
      if (!sourceType) {
        return { success: false, error: `Cannot convert suggestion type "${suggestion.suggestion_type}" to a discovery source` };
      }

      // Create the discovery source
      const { data: source, error: sourceError } = await supabase
        .from('content_discovery_sources')
        .insert({
          name: suggestion.title,
          source_type: sourceType,
          source_url: suggestion.url || null,
          search_query: suggestion.search_query || null,
          check_frequency: '6 hours',
          priority: 3,
          is_active: true,
        })
        .select()
        .single();

      if (sourceError) throw sourceError;

      // Mark suggestion as converted
      await supabase
        .from('content_monitoring_suggestions')
        .update({
          status: 'converted',
          converted_source_id: source.id,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', id);

      return { success: true, message: 'Suggestion converted to discovery source' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async convertToProject(id: string, suggestion: MonitoringSuggestion): Promise<ServiceResponse> {
    try {
      const slug = generateSlug(suggestion.title);

      const { data: project, error: projectError } = await supabase
        .from('content_project_taxonomy')
        .insert({
          slug,
          name: suggestion.title,
          description: suggestion.description,
          is_active: true,
        })
        .select()
        .single();

      if (projectError) throw projectError;

      await supabase
        .from('content_monitoring_suggestions')
        .update({
          status: 'converted',
          converted_project_id: project.id,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', id);

      return { success: true, message: 'Suggestion converted to tracked project' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async upvote(id: string): Promise<ServiceResponse> {
    try {
      const { error } = await supabase.rpc('content_upvote_suggestion', { suggestion_id: id });
      if (error) throw error;
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async delete(id: string): Promise<ServiceResponse> {
    try {
      const { error } = await supabase
        .from('content_monitoring_suggestions')
        .delete()
        .eq('id', id);

      if (error) throw error;
      return { success: true, message: 'Suggestion deleted' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}
