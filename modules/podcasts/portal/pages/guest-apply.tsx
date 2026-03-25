// @ts-nocheck — portal deps are resolved at build time via webpack alias
'use client'

import { useState, useEffect } from 'react'

interface PodcastInfo {
  id: string
  slug: string
  name: string
  description: string | null
  cover_image_url: string | null
  website_url: string | null
}

interface FormData {
  name: string
  email: string
  company: string
  title: string
  bio: string
  linkedin_url: string
  twitter_url: string
  website_url: string
  topic_suggestions: string
  notes: string
}

const initialForm: FormData = {
  name: '',
  email: '',
  company: '',
  title: '',
  bio: '',
  linkedin_url: '',
  twitter_url: '',
  website_url: '',
  topic_suggestions: '',
  notes: '',
}

export default function GuestApplyPage({ params, apiUrl }: { params: { slug: string }; apiUrl?: string }) {
  const [podcast, setPodcast] = useState<PodcastInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [successMessage, setSuccessMessage] = useState('')
  const [form, setForm] = useState<FormData>(initialForm)
  const [errors, setErrors] = useState<Partial<Record<keyof FormData, string>>>({})

  useEffect(() => {
    async function loadPodcast() {
      try {
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
        const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
        if (!url || !key) return

        const { createClient } = await import('@supabase/supabase-js')
        const supabase = createClient(url, key)

        const { data, error } = await supabase
          .from('podcasts')
          .select('id, slug, name, description, cover_image_url, website_url')
          .eq('slug', params.slug)
          .eq('is_active', true)
          .single()

        if (!error && data) setPodcast(data)
      } catch (err) {
        console.error('[podcasts-portal] Failed to load podcast:', err)
      } finally {
        setLoading(false)
      }
    }

    loadPodcast()
  }, [params.slug])

  const validate = (): boolean => {
    const newErrors: Partial<Record<keyof FormData, string>> = {}

    if (!form.name.trim()) newErrors.name = 'Name is required'
    if (!form.email.trim()) newErrors.email = 'Email is required'
    else if (!form.email.includes('@')) newErrors.email = 'Please enter a valid email address'
    if (!form.topic_suggestions.trim()) newErrors.topic_suggestions = 'Please suggest at least one topic'

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!podcast || !validate()) return

    try {
      setSubmitting(true)

      const baseApiUrl = apiUrl || process.env.NEXT_PUBLIC_API_URL || ''

      const res = await fetch(`${baseApiUrl}/api/modules/podcasts/${podcast.slug}/guest-apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })

      const result = await res.json()
      if (result.success) {
        setSubmitted(true)
        setSuccessMessage(result.message || 'Thank you for your application!')
      } else {
        alert(result.error || 'Submission failed. Please try again.')
      }
    } catch {
      alert('Submission failed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const updateField = (field: keyof FormData, value: string) => {
    setForm(prev => ({ ...prev, [field]: value }))
    if (errors[field]) setErrors(prev => { const n = { ...prev }; delete n[field]; return n })
  }

  if (loading) {
    return (
      <main className="relative z-10">
        <div className="max-w-2xl mx-auto px-6 py-12">
          <div className="animate-pulse space-y-4">
            <div className="h-8 bg-white/10 rounded w-1/3" />
            <div className="h-4 bg-white/10 rounded w-2/3" />
            <div className="space-y-3 mt-8">
              {[1, 2, 3].map(i => <div key={i} className="h-12 bg-white/5 rounded" />)}
            </div>
          </div>
        </div>
      </main>
    )
  }

  if (!podcast) {
    return (
      <main className="relative z-10">
        <div className="max-w-2xl mx-auto px-6 py-12 text-center">
          <h1 className="text-2xl font-bold text-white">Podcast not found</h1>
          <p className="text-white/60 mt-2">This podcast may have been removed or is no longer active.</p>
        </div>
      </main>
    )
  }

  if (submitted) {
    return (
      <main className="relative z-10">
        <div className="max-w-2xl mx-auto px-6 py-12 text-center">
          <div className="bg-white/5 rounded-xl border border-white/10 p-8">
            <div className="text-4xl mb-4">&#10003;</div>
            <p className="text-lg text-white">{successMessage}</p>
          </div>
        </div>
      </main>
    )
  }

  const inputClass = "w-full rounded-lg bg-white/10 border border-white/20 px-4 py-2.5 text-white placeholder:text-white/30 focus:outline-none focus:border-white/40 focus:ring-1 focus:ring-white/20"

  return (
    <main className="relative z-10">
      <div className="max-w-2xl mx-auto px-6 py-12">
        <div className="bg-white/5 rounded-xl border border-white/10 p-6 sm:p-8">
          {/* Podcast Header */}
          <div className="flex items-center gap-4 mb-6">
            {podcast.cover_image_url && (
              <img src={podcast.cover_image_url} alt="" className="w-16 h-16 rounded-lg object-cover" />
            )}
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold text-white">{podcast.name}</h1>
              <p className="text-white/60 text-sm">Guest Application</p>
            </div>
          </div>

          {podcast.description && (
            <p className="text-white/60 mb-6">{podcast.description}</p>
          )}

          <form onSubmit={handleSubmit} className="space-y-5" noValidate>
            {/* Name */}
            <div>
              <label className="block text-sm font-medium text-white/80 mb-1.5">
                Name <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => updateField('name', e.target.value)}
                placeholder="Your full name"
                className={inputClass}
              />
              {errors.name && <p className="text-red-400 text-sm mt-1">{errors.name}</p>}
            </div>

            {/* Email */}
            <div>
              <label className="block text-sm font-medium text-white/80 mb-1.5">
                Email <span className="text-red-400">*</span>
              </label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => updateField('email', e.target.value)}
                placeholder="you@example.com"
                className={inputClass}
              />
              {errors.email && <p className="text-red-400 text-sm mt-1">{errors.email}</p>}
            </div>

            {/* Company & Title */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-white/80 mb-1.5">Company</label>
                <input
                  type="text"
                  value={form.company}
                  onChange={(e) => updateField('company', e.target.value)}
                  placeholder="Your company"
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-white/80 mb-1.5">Title / Role</label>
                <input
                  type="text"
                  value={form.title}
                  onChange={(e) => updateField('title', e.target.value)}
                  placeholder="Your title"
                  className={inputClass}
                />
              </div>
            </div>

            {/* Bio */}
            <div>
              <label className="block text-sm font-medium text-white/80 mb-1.5">Bio</label>
              <textarea
                value={form.bio}
                onChange={(e) => updateField('bio', e.target.value)}
                placeholder="A brief bio about yourself"
                rows={3}
                className={`${inputClass} resize-y`}
              />
            </div>

            {/* Social Links */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-white/80 mb-1.5">LinkedIn URL</label>
                <input
                  type="url"
                  value={form.linkedin_url}
                  onChange={(e) => updateField('linkedin_url', e.target.value)}
                  placeholder="https://linkedin.com/in/..."
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-white/80 mb-1.5">Twitter / X URL</label>
                <input
                  type="url"
                  value={form.twitter_url}
                  onChange={(e) => updateField('twitter_url', e.target.value)}
                  placeholder="https://x.com/..."
                  className={inputClass}
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-white/80 mb-1.5">Website URL</label>
              <input
                type="url"
                value={form.website_url}
                onChange={(e) => updateField('website_url', e.target.value)}
                placeholder="https://yourwebsite.com"
                className={inputClass}
              />
            </div>

            {/* Topic Suggestions */}
            <div>
              <label className="block text-sm font-medium text-white/80 mb-1.5">
                Topic Suggestions <span className="text-red-400">*</span>
              </label>
              <textarea
                value={form.topic_suggestions}
                onChange={(e) => updateField('topic_suggestions', e.target.value)}
                placeholder="What topics would you like to discuss? What expertise can you share?"
                rows={4}
                className={`${inputClass} resize-y`}
              />
              {errors.topic_suggestions && <p className="text-red-400 text-sm mt-1">{errors.topic_suggestions}</p>}
            </div>

            {/* Additional Notes */}
            <div>
              <label className="block text-sm font-medium text-white/80 mb-1.5">Additional Notes</label>
              <textarea
                value={form.notes}
                onChange={(e) => updateField('notes', e.target.value)}
                placeholder="Anything else you'd like us to know?"
                rows={3}
                className={`${inputClass} resize-y`}
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-3 px-6 rounded-lg bg-white text-black font-medium hover:bg-white/90 disabled:bg-white/50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? 'Submitting...' : 'Submit Application'}
            </button>
          </form>
        </div>
      </div>
    </main>
  )
}
