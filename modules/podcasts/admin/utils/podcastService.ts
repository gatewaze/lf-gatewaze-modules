import { supabase } from '@/lib/supabase';

// ============================================================================
// Types
// ============================================================================

export interface Podcast {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  cover_image_url?: string | null;
  rss_feed_url?: string | null;
  website_url?: string | null;
  is_active: boolean;
  metadata?: Record<string, any>;
  created_at: string;
  updated_at: string;
  episode_count?: number;
  guest_count?: number;
}

export interface PodcastEpisode {
  id: string;
  podcast_id: string;
  title: string;
  slug?: string | null;
  description?: string | null;
  episode_number?: number | null;
  season?: number | null;
  status: 'draft' | 'scheduled' | 'recording' | 'editing' | 'published' | 'archived';
  record_date?: string | null;
  publish_date?: string | null;
  audio_url?: string | null;
  video_url?: string | null;
  thumbnail_url?: string | null;
  show_notes?: string | null;
  duration_seconds?: number | null;
  metadata?: Record<string, any>;
  created_at: string;
  updated_at: string;
  guest_count?: number;
}

export interface PodcastGuest {
  id: string;
  podcast_id?: string | null;
  name: string;
  email: string;
  company?: string | null;
  title?: string | null;
  bio?: string | null;
  linkedin_url?: string | null;
  twitter_url?: string | null;
  website_url?: string | null;
  topic_suggestions?: string | null;
  notes?: string | null;
  status: 'pending' | 'approved' | 'declined' | 'contacted' | 'archived';
  source: 'form' | 'manual' | 'import';
  person_id?: string | null;
  metadata?: Record<string, any>;
  created_at: string;
  updated_at: string;
  podcast_name?: string;
}

export interface PodcastEpisodeGuest {
  id: string;
  episode_id: string;
  guest_id: string;
  role: 'guest' | 'host' | 'co-host' | 'moderator';
  is_confirmed: boolean;
  notified_at?: string | null;
  confirmed_at?: string | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface EpisodeGuestWithDetails extends PodcastEpisodeGuest {
  guest_name: string;
  guest_email: string;
  guest_company?: string | null;
  guest_title?: string | null;
  guest_bio?: string | null;
  guest_linkedin_url?: string | null;
  episode_title: string;
  episode_record_date?: string | null;
  episode_status: string;
  podcast_name: string;
  podcast_id: string;
}

export interface PodcastStats {
  total_podcasts: number;
  total_episodes: number;
  published_episodes: number;
  total_guests: number;
  pending_guests: number;
  approved_guests: number;
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
// Podcast Stats
// ============================================================================

export class PodcastStatsService {
  static async getStats(): Promise<ServiceResponse<PodcastStats>> {
    try {
      const { data, error } = await supabase.rpc('podcast_stats');
      if (error) throw error;
      return { success: true, data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}

// ============================================================================
// Podcasts
// ============================================================================

export class PodcastsService {
  static async getAll(filters?: {
    search?: string;
    is_active?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<ServiceResponse<Podcast[]>> {
    try {
      let query = supabase
        .from('podcasts')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false });

      if (filters?.search) query = query.ilike('name', `%${filters.search}%`);
      if (filters?.is_active !== undefined) query = query.eq('is_active', filters.is_active);
      if (filters?.limit) query = query.limit(filters.limit);
      if (filters?.offset) query = query.range(filters.offset, filters.offset + (filters.limit || 20) - 1);

      const { data, error, count } = await query;
      if (error) throw error;

      // Fetch episode and guest counts
      const podcasts = data || [];
      if (podcasts.length > 0) {
        const podcastIds = podcasts.map(p => p.id);

        const [episodeCounts, guestCounts] = await Promise.all([
          supabase
            .from('podcast_episodes')
            .select('podcast_id')
            .in('podcast_id', podcastIds),
          supabase
            .from('podcast_guests')
            .select('podcast_id')
            .in('podcast_id', podcastIds),
        ]);

        const epMap = new Map<string, number>();
        for (const ep of episodeCounts.data || []) {
          epMap.set(ep.podcast_id, (epMap.get(ep.podcast_id) || 0) + 1);
        }

        const gMap = new Map<string, number>();
        for (const g of guestCounts.data || []) {
          if (g.podcast_id) gMap.set(g.podcast_id, (gMap.get(g.podcast_id) || 0) + 1);
        }

        for (const p of podcasts) {
          p.episode_count = epMap.get(p.id) || 0;
          p.guest_count = gMap.get(p.id) || 0;
        }
      }

      return { success: true, data: podcasts, total: count ?? 0 };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async getById(id: string): Promise<ServiceResponse<Podcast>> {
    try {
      const { data, error } = await supabase
        .from('podcasts')
        .select('*')
        .eq('id', id)
        .single();

      if (error) throw error;
      return { success: true, data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async create(podcast: Partial<Podcast>): Promise<ServiceResponse<Podcast>> {
    try {
      const slug = podcast.slug || generateSlug(podcast.name || '');
      const { data, error } = await supabase
        .from('podcasts')
        .insert({ ...podcast, slug })
        .select()
        .single();

      if (error) throw error;
      return { success: true, data, message: 'Podcast created' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async update(id: string, updates: Partial<Podcast>): Promise<ServiceResponse<Podcast>> {
    try {
      const { data, error } = await supabase
        .from('podcasts')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return { success: true, data, message: 'Podcast updated' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async delete(id: string): Promise<ServiceResponse> {
    try {
      const { error } = await supabase
        .from('podcasts')
        .delete()
        .eq('id', id);

      if (error) throw error;
      return { success: true, message: 'Podcast deleted' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}

// ============================================================================
// Episodes
// ============================================================================

export class EpisodesService {
  static async getByPodcast(podcastId: string, filters?: {
    status?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<ServiceResponse<PodcastEpisode[]>> {
    try {
      let query = supabase
        .from('podcast_episodes')
        .select('*', { count: 'exact' })
        .eq('podcast_id', podcastId)
        .order('episode_number', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false });

      if (filters?.status) query = query.eq('status', filters.status);
      if (filters?.search) query = query.ilike('title', `%${filters.search}%`);
      if (filters?.limit) query = query.limit(filters.limit);
      if (filters?.offset) query = query.range(filters.offset, filters.offset + (filters.limit || 50) - 1);

      const { data, error, count } = await query;
      if (error) throw error;

      // Fetch guest counts per episode
      const episodes = data || [];
      if (episodes.length > 0) {
        const episodeIds = episodes.map(e => e.id);
        const { data: assignments } = await supabase
          .from('podcast_episode_guests')
          .select('episode_id')
          .in('episode_id', episodeIds);

        const countMap = new Map<string, number>();
        for (const a of assignments || []) {
          countMap.set(a.episode_id, (countMap.get(a.episode_id) || 0) + 1);
        }
        for (const ep of episodes) {
          ep.guest_count = countMap.get(ep.id) || 0;
        }
      }

      return { success: true, data: episodes, total: count ?? 0 };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async getById(id: string): Promise<ServiceResponse<PodcastEpisode>> {
    try {
      const { data, error } = await supabase
        .from('podcast_episodes')
        .select('*')
        .eq('id', id)
        .single();

      if (error) throw error;
      return { success: true, data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async create(episode: Partial<PodcastEpisode>): Promise<ServiceResponse<PodcastEpisode>> {
    try {
      const slug = episode.slug || generateSlug(episode.title || '');
      const { data, error } = await supabase
        .from('podcast_episodes')
        .insert({ ...episode, slug })
        .select()
        .single();

      if (error) throw error;
      return { success: true, data, message: 'Episode created' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async update(id: string, updates: Partial<PodcastEpisode>): Promise<ServiceResponse<PodcastEpisode>> {
    try {
      const { data, error } = await supabase
        .from('podcast_episodes')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return { success: true, data, message: 'Episode updated' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async delete(id: string): Promise<ServiceResponse> {
    try {
      const { error } = await supabase
        .from('podcast_episodes')
        .delete()
        .eq('id', id);

      if (error) throw error;
      return { success: true, message: 'Episode deleted' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}

// ============================================================================
// Guests
// ============================================================================

export class GuestsService {
  static async getAll(filters?: {
    podcast_id?: string;
    status?: string;
    source?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<ServiceResponse<PodcastGuest[]>> {
    try {
      let query = supabase
        .from('podcast_guests')
        .select('*, podcast:podcasts(name)', { count: 'exact' })
        .order('created_at', { ascending: false });

      if (filters?.podcast_id) query = query.eq('podcast_id', filters.podcast_id);
      if (filters?.status) query = query.eq('status', filters.status);
      if (filters?.source) query = query.eq('source', filters.source);
      if (filters?.search) query = query.or(`name.ilike.%${filters.search}%,email.ilike.%${filters.search}%`);
      if (filters?.limit) query = query.limit(filters.limit);
      if (filters?.offset) query = query.range(filters.offset, filters.offset + (filters.limit || 20) - 1);

      const { data, error, count } = await query;
      if (error) throw error;

      const guests = (data || []).map((g: any) => ({
        ...g,
        podcast_name: g.podcast?.name || null,
        podcast: undefined,
      }));

      return { success: true, data: guests, total: count ?? 0 };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async getById(id: string): Promise<ServiceResponse<PodcastGuest>> {
    try {
      const { data, error } = await supabase
        .from('podcast_guests')
        .select('*')
        .eq('id', id)
        .single();

      if (error) throw error;
      return { success: true, data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async create(guest: Partial<PodcastGuest>): Promise<ServiceResponse<PodcastGuest>> {
    try {
      const { data, error } = await supabase
        .from('podcast_guests')
        .insert({ ...guest, source: guest.source || 'manual' })
        .select()
        .single();

      if (error) throw error;
      return { success: true, data, message: 'Guest added' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async update(id: string, updates: Partial<PodcastGuest>): Promise<ServiceResponse<PodcastGuest>> {
    try {
      const { data, error } = await supabase
        .from('podcast_guests')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return { success: true, data, message: 'Guest updated' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async updateStatus(id: string, status: string): Promise<ServiceResponse> {
    try {
      const { error } = await supabase
        .from('podcast_guests')
        .update({ status })
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
        .from('podcast_guests')
        .delete()
        .eq('id', id);

      if (error) throw error;
      return { success: true, message: 'Guest deleted' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}

// ============================================================================
// Episode Guests (assignments)
// ============================================================================

export class EpisodeGuestsService {
  static async getByEpisode(episodeId: string): Promise<ServiceResponse<EpisodeGuestWithDetails[]>> {
    try {
      const { data, error } = await supabase
        .from('podcast_episode_guests_with_details')
        .select('*')
        .eq('episode_id', episodeId)
        .order('created_at', { ascending: true });

      if (error) throw error;
      return { success: true, data: data || [] };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async assign(
    episodeId: string,
    guestId: string,
    role: string = 'guest',
  ): Promise<ServiceResponse<PodcastEpisodeGuest>> {
    try {
      const { data, error } = await supabase
        .from('podcast_episode_guests')
        .insert({ episode_id: episodeId, guest_id: guestId, role })
        .select()
        .single();

      if (error) throw error;
      return { success: true, data, message: 'Guest assigned to episode' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async unassign(id: string): Promise<ServiceResponse> {
    try {
      const { error } = await supabase
        .from('podcast_episode_guests')
        .delete()
        .eq('id', id);

      if (error) throw error;
      return { success: true, message: 'Guest removed from episode' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async updateRole(id: string, role: string): Promise<ServiceResponse> {
    try {
      const { error } = await supabase
        .from('podcast_episode_guests')
        .update({ role })
        .eq('id', id);

      if (error) throw error;
      return { success: true, message: 'Role updated' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async markConfirmed(id: string): Promise<ServiceResponse> {
    try {
      const { error } = await supabase
        .from('podcast_episode_guests')
        .update({ is_confirmed: true, confirmed_at: new Date().toISOString() })
        .eq('id', id);

      if (error) throw error;
      return { success: true, message: 'Guest confirmed' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  static async sendRecordDateNotification(episodeId: string): Promise<ServiceResponse> {
    try {
      // Fetch episode details
      const { data: episode, error: epError } = await supabase
        .from('podcast_episodes')
        .select('*, podcast:podcasts(name)')
        .eq('id', episodeId)
        .single();

      if (epError || !episode) throw epError || new Error('Episode not found');
      if (!episode.record_date) throw new Error('No record date set for this episode');

      // Fetch assigned guests
      const { data: assignments, error: assignError } = await supabase
        .from('podcast_episode_guests_with_details')
        .select('*')
        .eq('episode_id', episodeId);

      if (assignError) throw assignError;
      if (!assignments || assignments.length === 0) throw new Error('No guests assigned to this episode');

      const recordDate = new Date(episode.record_date).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

      const podcastName = (episode as any).podcast?.name || 'the podcast';

      // Send email to each guest
      let notifiedCount = 0;
      for (const guest of assignments) {
        if (!guest.guest_email) continue;

        try {
          await supabase.functions.invoke('send-email', {
            body: {
              to: guest.guest_email,
              subject: `Recording Date Confirmed: ${episode.title}`,
              html: `
                <p>Hi ${guest.guest_name},</p>
                <p>We're excited to confirm the recording date for your upcoming appearance on <strong>${podcastName}</strong>.</p>
                <p><strong>Episode:</strong> ${episode.title}</p>
                <p><strong>Recording Date:</strong> ${recordDate}</p>
                <p><strong>Your Role:</strong> ${guest.role}</p>
                ${guest.notes ? `<p><strong>Notes:</strong> ${guest.notes}</p>` : ''}
                <p>Please let us know if you have any questions or need to reschedule.</p>
                <p>Looking forward to recording with you!</p>
              `,
            },
          });
          notifiedCount++;
        } catch (emailErr) {
          console.error(`[podcasts] Failed to send email to ${guest.guest_email}:`, emailErr);
        }
      }

      // Update notified_at for all assigned guests
      const assignmentIds = assignments.map(a => a.id);
      await supabase
        .from('podcast_episode_guests')
        .update({ notified_at: new Date().toISOString() })
        .in('id', assignmentIds);

      return {
        success: true,
        message: `Notification sent to ${notifiedCount} of ${assignments.length} guests`,
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}
