/**
 * Daily-briefing-specific render for assistant turns inside AiChatWidget.
 *
 * The autopilot's structured-output tool (`submit_candidates`) attaches
 * `{ narrative, candidates: [{title, summary, source_label, source_href,
 * why}, ...] }` to ai_messages.structured. This component renders each
 * candidate as a card with Add/Reject buttons; clicking Add POSTs to
 * /api/modules/daily-briefing/admin/days/:dayId/research/approve, which
 * creates a daily_briefing_items row from the candidate.
 *
 * Plain narrative text (assistant turns without a structured payload)
 * is rendered by assistant-ui's default bubble — we only return JSX
 * when there are candidates to show.
 */

import { useState } from 'react';
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  PlusCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';

import { supabase } from '@/lib/supabase';

export interface Candidate {
  title: string;
  summary: string;
  source_label: string;
  source_href: string;
  why: string;
}

interface AssistantMessageLike {
  id: string;
  content: string;
  structured: Record<string, unknown> | null;
}

interface Props {
  dayId: string;
  message: AssistantMessageLike;
  /** Called after a candidate is added (so the parent can re-render). */
  onApproved: () => void;
}

export default function CandidateCards({ dayId, message, onApproved }: Props) {
  const candidates = extractCandidates(message);
  const [approvingIdx, setApprovingIdx] = useState<number | null>(null);
  const [rejected, setRejected] = useState<Set<number>>(() => new Set());

  async function handleApprove(index: number) {
    setApprovingIdx(index);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const apiUrl =
        (import.meta as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
      const response = await fetch(
        `${apiUrl}/api/modules/daily-briefing/admin/days/${dayId}/research/approve`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            message_id: message.id,
            candidate_index: index,
          }),
        },
      );
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const body = (await response.json()) as { error?: string; message?: string };
          if (body.message) detail = body.message;
          else if (body.error) detail = body.error;
        } catch {
          /* ignore */
        }
        throw new Error(detail);
      }
      toast.success('Added to day');
      onApproved();
    } catch (err) {
      console.error('[daily-briefing] approve candidate failed', err);
      toast.error(err instanceof Error ? err.message : 'Add failed');
    } finally {
      setApprovingIdx(null);
    }
  }

  function handleReject(index: number) {
    setRejected((prev) => {
      const next = new Set(prev);
      next.add(index);
      return next;
    });
  }

  if (candidates.length === 0) return null;
  return (
    <div className="space-y-2 w-full">
      {message.content && (
        <div className="rounded-2xl rounded-bl-sm bg-white border px-3 py-2 text-sm text-neutral-800 whitespace-pre-wrap">
          {message.content}
        </div>
      )}
      <div className="space-y-2">
        {candidates.map((c, idx) => {
          const isRejected = rejected.has(idx);
          const isApproving = approvingIdx === idx;
          return (
            <div
              key={`${message.id}:${idx}`}
              className={`rounded-md border bg-white p-3 text-sm space-y-1.5 ${
                isRejected ? 'opacity-50' : ''
              }`}
            >
              <div className={`font-medium ${isRejected ? 'line-through' : ''}`}>
                {c.title}
              </div>
              <div className="text-neutral-700">{c.summary}</div>
              {c.why && (
                <div className="text-xs text-neutral-500 italic">Why: {c.why}</div>
              )}
              <div className="flex items-center justify-between pt-1">
                <a
                  href={c.source_href}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1"
                >
                  {c.source_label}
                  <ArrowTopRightOnSquareIcon className="size-3" />
                </a>
                <div className="inline-flex gap-1">
                  {!isRejected && (
                    <button
                      type="button"
                      onClick={() => handleReject(idx)}
                      disabled={isApproving}
                      className="inline-flex items-center px-2 py-1 rounded text-xs text-neutral-500 hover:bg-neutral-100"
                      title="Dismiss (does not regenerate)"
                    >
                      <XMarkIcon className="size-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleApprove(idx)}
                    disabled={isApproving || isRejected}
                    className="inline-flex items-center px-2 py-1 rounded text-xs bg-blue-600 text-white disabled:opacity-50"
                  >
                    {isApproving ? (
                      <>
                        <ArrowPathIcon className="size-4 animate-spin mr-1" />
                        Adding…
                      </>
                    ) : (
                      <>
                        <PlusCircleIcon className="size-4 mr-1" />
                        Add to day
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function extractCandidates(message: AssistantMessageLike): Candidate[] {
  const raw = message.structured;
  if (!raw || typeof raw !== 'object') return [];
  const list = (raw as { candidates?: unknown }).candidates;
  if (!Array.isArray(list)) return [];
  const out: Candidate[] = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const row = c as Record<string, unknown>;
    if (
      typeof row.title === 'string' &&
      typeof row.summary === 'string' &&
      typeof row.source_label === 'string' &&
      typeof row.source_href === 'string'
    ) {
      out.push({
        title: row.title,
        summary: row.summary,
        source_label: row.source_label,
        source_href: row.source_href,
        why: typeof row.why === 'string' ? row.why : '',
      });
    }
  }
  return out;
}
