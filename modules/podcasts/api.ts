/**
 * API routes for the podcasts module.
 *
 * Public endpoints for fetching podcast info and submitting guest applications.
 */

import type { Express, Request, Response } from 'express';
import type { ModuleContext } from '@gatewaze/shared';
import { createRequire } from 'module';
import { join } from 'path';

let _supabase: any = null;

function initSupabase(projectRoot: string) {
  if (_supabase) return _supabase;

  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');

  const require = createRequire(join(projectRoot, 'packages', 'api', 'package.json'));
  const { createClient } = require('@supabase/supabase-js');
  _supabase = createClient(url, key);
  return _supabase;
}

function cors(_req: Request, res: Response) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  return res.sendStatus(204);
}

export function registerRoutes(app: Express, context?: ModuleContext) {
  const projectRoot = context?.projectRoot || process.cwd();

  // CORS preflight
  app.options('/api/modules/podcasts/:slug', cors);
  app.options('/api/modules/podcasts/:slug/guest-apply', cors);
  app.use('/api/modules/podcasts', (_req: Request, res: Response, next: Function) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });

  // -----------------------------------------------------------------------
  // GET /api/modules/podcasts/:slug — fetch podcast info (public)
  // -----------------------------------------------------------------------
  app.get('/api/modules/podcasts/:slug', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { data, error } = await supabase
        .from('podcasts')
        .select('id, slug, name, description, cover_image_url, website_url')
        .eq('slug', req.params.slug)
        .eq('is_active', true)
        .single();

      if (error || !data) {
        return res.status(404).json({ error: 'Podcast not found' });
      }

      return res.json(data);
    } catch (err: any) {
      console.error('[podcasts] Error fetching podcast:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/modules/podcasts/:slug/guest-apply — submit guest application
  // -----------------------------------------------------------------------
  app.post('/api/modules/podcasts/:slug/guest-apply', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);

      // 1. Fetch the podcast
      const { data: podcast, error: podcastError } = await supabase
        .from('podcasts')
        .select('id, name, slug')
        .eq('slug', req.params.slug)
        .eq('is_active', true)
        .single();

      if (podcastError || !podcast) {
        return res.status(404).json({ error: 'Podcast not found' });
      }

      // 2. Validate required fields
      const { name, email, topic_suggestions } = req.body;
      if (!name || !email || !topic_suggestions) {
        return res.status(400).json({ error: 'Name, email, and topic suggestions are required' });
      }

      if (typeof email !== 'string' || !email.includes('@')) {
        return res.status(400).json({ error: 'Please provide a valid email address' });
      }

      const normalizedEmail = email.toLowerCase().trim();

      // 3. Check for duplicate guest application
      const { data: existing } = await supabase
        .from('podcast_guests')
        .select('id')
        .eq('podcast_id', podcast.id)
        .eq('email', normalizedEmail)
        .maybeSingle();

      if (existing) {
        return res.json({
          success: true,
          message: 'Thank you! We already have your application on file.',
        });
      }

      // 4. Create/find person via people-signup edge function
      let personId: string | null = null;
      const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

      try {
        const clientIp = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim()
          || req.headers['x-real-ip']?.toString()
          || req.ip
          || '';

        const signupRes = await fetch(`${supabaseUrl}/functions/v1/people-signup`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceRoleKey}`,
            'apikey': serviceRoleKey!,
            ...(clientIp ? { 'x-forwarded-for': clientIp } : {}),
          },
          body: JSON.stringify({
            email: normalizedEmail,
            source: `podcast_guest_apply:${podcast.slug}`,
            user_metadata: {
              name: req.body.name,
              company: req.body.company,
              title: req.body.title,
            },
          }),
        });

        const signupData = await signupRes.json();
        if (signupData.person_id) {
          personId = signupData.person_id;
        }
      } catch (signupErr) {
        console.error('[podcasts] Error calling people-signup:', signupErr);
      }

      // 5. Insert guest application
      const { data: guest, error: guestError } = await supabase
        .from('podcast_guests')
        .insert({
          podcast_id: podcast.id,
          name: req.body.name,
          email: normalizedEmail,
          company: req.body.company || null,
          title: req.body.title || null,
          bio: req.body.bio || null,
          linkedin_url: req.body.linkedin_url || null,
          twitter_url: req.body.twitter_url || null,
          website_url: req.body.website_url || null,
          topic_suggestions: req.body.topic_suggestions,
          source: 'form',
          status: 'pending',
          person_id: personId,
          metadata: {
            user_agent: req.headers['user-agent'] || null,
            referrer: req.headers['referer'] || null,
          },
        })
        .select('id')
        .single();

      if (guestError) {
        console.error('[podcasts] Error saving guest application:', guestError);
        return res.status(500).json({ error: 'Failed to save application' });
      }

      return res.json({
        success: true,
        guest_id: guest?.id,
        message: 'Thank you for your application! We will review it and get back to you.',
      });
    } catch (err: any) {
      console.error('[podcasts] Error processing guest application:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
}
