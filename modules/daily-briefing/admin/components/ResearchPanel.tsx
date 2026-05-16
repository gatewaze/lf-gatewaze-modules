/**
 * Research autopilot chat panel — rendered inline inside a day section.
 *
 * Layout: scrollable transcript on top, single-row composer on the
 * bottom. Each assistant turn that surfaced candidates renders a
 * stacked list of cards with "Add to day" / "Open source" affordances.
 *
 * State model:
 *   - Mounting calls getResearchThread() to hydrate the thread + its
 *     messages from the server.
 *   - Sending a message blocks the composer for the full round-trip
 *     (~30–90s). We render a transient "researching…" assistant bubble
 *     so the operator has feedback during the wait.
 *   - The auto-research workflow runs in the background after the day
 *     is created (cron + server-side); the chat panel only needs to
 *     render whatever the server has stored.
 */

import { useEffect, useRef, useState } from 'react';
import {
  PaperAirplaneIcon,
  ArrowPathIcon,
  PlusCircleIcon,
  ExclamationCircleIcon,
  TrashIcon,
  SparklesIcon,
  ArrowTopRightOnSquareIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';

import { Button } from '@/components/ui';

import {
  getResearchThread,
  postResearchMessage,
  approveResearchCandidate,
  deleteResearchThread,
  type ResearchCandidate,
  type ResearchMessage,
  type ResearchThread,
} from '../utils/dailyBriefingService';

interface Props {
  dayId: string;
  briefDate: string;
  /** Called after an "Add to day" succeeds so the parent can re-render. */
  onCandidateApproved: () => void;
  /** Hides the panel. Wired to the parent DaySection's `setResearchOpen(false)`. */
  onClose: () => void;
}

export default function ResearchPanel({
  dayId,
  briefDate,
  onCandidateApproved,
  onClose,
}: Props) {
  const [thread, setThread] = useState<ResearchThread | null>(null);
  const [messages, setMessages] = useState<ResearchMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [approvingKey, setApprovingKey] = useState<string | null>(null);
  const [rejectingKey, setRejectingKey] = useState<string | null>(null);
  // Keys (`${message.id}:${candidateIndex}`) of candidates the operator
  // has rejected in this session. Greys out the card so the operator
  // can see at a glance what's already been dismissed. Local-only —
  // chat history is the server-side source of truth, this is just a UI
  // breadcrumb for the current session.
  const [rejectedKeys, setRejectedKeys] = useState<Set<string>>(() => new Set());
  const [resetting, setResetting] = useState(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void hydrate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayId]);

  // Poll while a background research run is in flight (auto-kickoff on
  // day creation, weekday cron). Once the runner persists the assistant
  // turn it flips status to 'ready' and we stop polling.
  useEffect(() => {
    if (thread?.status !== 'running') return;
    const tick = async () => {
      try {
        const result = await getResearchThread(dayId);
        setThread(result.thread);
        setMessages(result.messages);
      } catch (err) {
        console.error('[daily-briefing] poll research thread failed', err);
      }
    };
    const interval = setInterval(() => void tick(), 4_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayId, thread?.status]);

  useEffect(() => {
    // Auto-scroll to bottom on new messages so the latest assistant
    // turn is visible without manual scroll.
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [messages.length, sending]);

  async function hydrate() {
    setLoading(true);
    try {
      const result = await getResearchThread(dayId);
      setThread(result.thread);
      setMessages(result.messages);
    } catch (err) {
      console.error('[daily-briefing] hydrate research thread failed', err);
      toast.error('Failed to load research thread');
    } finally {
      setLoading(false);
    }
  }

  /**
   * Returns true on success, false if the autopilot call failed. The
   * reject flow uses this to decide whether to mark the candidate as
   * greyed-out — we only flip the UI if the replacement actually ran.
   */
  async function handleSend(message?: string): Promise<boolean> {
    const text = (message ?? input).trim();
    if (!text && messages.length > 0) return false;
    setSending(true);
    try {
      const result = await postResearchMessage(dayId, text || undefined);
      setThread(result.thread);
      // The server already persisted both the user turn (if any) and
      // the assistant turn. Reload the full list so ordering is
      // canonical instead of optimistically appending.
      const full = await getResearchThread(dayId);
      setMessages(full.messages);
      setInput('');
      return true;
    } catch (err) {
      console.error('[daily-briefing] send research message failed', err);
      toast.error(err instanceof Error ? err.message : 'Send failed');
      // Re-pull thread so a 'failed' status surfaces in the UI.
      await hydrate();
      return false;
    } finally {
      setSending(false);
    }
  }

  async function handleApprove(message: ResearchMessage, candidateIndex: number) {
    const key = `${message.id}:${candidateIndex}`;
    setApprovingKey(key);
    try {
      await approveResearchCandidate(dayId, message.id, candidateIndex);
      toast.success('Added to day');
      onCandidateApproved();
    } catch (err) {
      console.error('[daily-briefing] approve candidate failed', err);
      toast.error(err instanceof Error ? err.message : 'Add failed');
    } finally {
      setApprovingKey(null);
    }
  }

  /**
   * Reject a candidate and ask the model for a single replacement. The
   * model already sees prior candidates via the message history; we also
   * include an explicit "do not propose any of these" list built from
   * every candidate ever surfaced in this thread to make the constraint
   * hard (some models drop loose constraints under load). We send this
   * as a regular user turn so it joins the same loop the composer uses.
   */
  async function handleReject(message: ResearchMessage, candidateIndex: number) {
    const candidate = message.candidates?.[candidateIndex];
    if (!candidate) return;
    const allShownTitles = new Set<string>();
    for (const m of messages) {
      if (!m.candidates) continue;
      for (const c of m.candidates) allShownTitles.add(c.title);
    }
    const avoidList = Array.from(allShownTitles)
      .map((t) => `- ${t}`)
      .join('\n');
    const promptParts = [
      `Reject the candidate titled "${candidate.title}".`,
      'Find a single replacement that strengthens the daily lineup. Apply the same 24-hour gate and editorial bar as the original pass.',
      'Do not propose any of these candidates already shown in this thread (rejected or accepted):',
      avoidList,
    ];
    const key = `${message.id}:${candidateIndex}`;
    setRejectingKey(key);
    try {
      const ok = await handleSend(promptParts.join('\n'));
      if (ok) {
        setRejectedKeys((prev) => {
          const next = new Set(prev);
          next.add(key);
          return next;
        });
      }
    } finally {
      setRejectingKey(null);
    }
  }

  async function handleReset() {
    if (!window.confirm('Reset the research thread? All chat history is lost.')) return;
    setResetting(true);
    try {
      await deleteResearchThread(dayId);
      setMessages([]);
      setThread(null);
      toast.success('Thread reset');
    } catch (err) {
      console.error('[daily-briefing] reset thread failed', err);
      toast.error('Reset failed');
    } finally {
      setResetting(false);
    }
  }

  if (loading) {
    return (
      <div className="text-sm text-neutral-500 px-3 py-4 flex items-center gap-2">
        <ArrowPathIcon className="size-4 animate-spin" />
        Loading research thread…
      </div>
    );
  }

  const hasMessages = messages.length > 0;
  const backgroundRunning = thread?.status === 'running';
  const isRunningStatus = backgroundRunning || sending;

  return (
    <div className="rounded-md border bg-neutral-50/60">
      <header className="flex items-center justify-between px-3 py-2 border-b bg-white rounded-t-md">
        <div className="flex items-center gap-2 text-sm font-medium">
          <SparklesIcon className="size-4 text-amber-600" />
          Research autopilot
          <span className="text-xs text-neutral-500 font-normal">
            for {briefDate}
          </span>
          {thread?.status === 'failed' && (
            <span
              className="text-xs text-red-700 inline-flex items-center gap-1"
              title={thread.last_error ?? undefined}
            >
              <ExclamationCircleIcon className="size-4" />
              last run failed
            </span>
          )}
          {backgroundRunning && (
            <span className="text-xs text-amber-700 inline-flex items-center gap-1">
              <ArrowPathIcon className="size-4 animate-spin" />
              researching…
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {!hasMessages && !sending && !backgroundRunning && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => handleSend()}
              title="Run the standard kickoff prompt"
            >
              <SparklesIcon className="size-4 mr-1" />
              Run autopilot
            </Button>
          )}
          {hasMessages && (
            <Button
              size="sm"
              variant="ghost"
              onClick={handleReset}
              disabled={resetting || sending}
              title="Reset thread (clear all messages)"
            >
              <TrashIcon className="size-4 text-red-600" />
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={onClose}
            title="Close research"
          >
            <XMarkIcon className="size-4" />
          </Button>
        </div>
      </header>

      <div
        ref={transcriptRef}
        className="px-3 py-3 space-y-3 max-h-[480px] overflow-y-auto"
      >
        {!hasMessages && !sending && !backgroundRunning && (
          <div className="text-sm text-neutral-500 text-center py-6">
            No research yet. Click <strong>Run autopilot</strong> to start a search,
            or send a custom prompt below.
          </div>
        )}
        {!hasMessages && backgroundRunning && (
          <div className="text-sm text-neutral-500 text-center py-6 inline-flex items-center gap-2 justify-center w-full">
            <ArrowPathIcon className="size-4 animate-spin" />
            Autopilot is researching the past 24 hours… this usually takes 30–90 seconds.
          </div>
        )}

        {messages.map((m) =>
          m.role === 'user' ? (
            <UserMessage key={m.id} message={m} />
          ) : (
            <AssistantMessage
              key={m.id}
              message={m}
              approvingKey={approvingKey}
              onApprove={(idx) => handleApprove(m, idx)}
              rejectingKey={rejectingKey}
              onReject={(idx) => void handleReject(m, idx)}
              rejectedKeys={rejectedKeys}
            />
          ),
        )}

        {sending && <AssistantTyping />}
      </div>

      <footer className="px-3 py-2 border-t bg-white rounded-b-md">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSend();
          }}
        >
          <input
            type="text"
            placeholder={
              isRunningStatus
                ? 'Researching…'
                : 'Refine the picks (e.g. "drop the AWS one")'
            }
            className="form-input flex-1 text-sm"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={sending || backgroundRunning}
          />
          <Button
            type="submit"
            size="sm"
            disabled={sending || backgroundRunning || !input.trim()}
          >
            <PaperAirplaneIcon className="size-4 mr-1" />
            Send
          </Button>
        </form>
      </footer>
    </div>
  );
}

function UserMessage({ message }: { message: ResearchMessage }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-blue-600 text-white px-3 py-2 text-sm whitespace-pre-wrap">
        {message.content}
      </div>
    </div>
  );
}

function AssistantTyping() {
  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-white border px-3 py-2 text-sm text-neutral-600 inline-flex items-center gap-2">
        <ArrowPathIcon className="size-4 animate-spin" />
        Researching the past 24 hours of agentic AI news…
      </div>
    </div>
  );
}

function AssistantMessage({
  message,
  approvingKey,
  onApprove,
  rejectingKey,
  onReject,
  rejectedKeys,
}: {
  message: ResearchMessage;
  approvingKey: string | null;
  onApprove: (candidateIndex: number) => void;
  rejectingKey: string | null;
  onReject: (candidateIndex: number) => void;
  rejectedKeys: Set<string>;
}) {
  const candidates = Array.isArray(message.candidates) ? message.candidates : [];
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] space-y-2 w-full">
        {message.content && (
          <div className="rounded-2xl rounded-bl-sm bg-white border px-3 py-2 text-sm text-neutral-800 whitespace-pre-wrap">
            {message.content}
          </div>
        )}
        {candidates.length > 0 && (
          <div className="space-y-2">
            {candidates.map((c, idx) => {
              const k = `${message.id}:${idx}`;
              return (
                <CandidateCard
                  key={k}
                  candidate={c}
                  approving={approvingKey === k}
                  onApprove={() => onApprove(idx)}
                  rejecting={rejectingKey === k}
                  onReject={() => onReject(idx)}
                  rejected={rejectedKeys.has(k)}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function CandidateCard({
  candidate,
  approving,
  onApprove,
  rejecting,
  onReject,
  rejected,
}: {
  candidate: ResearchCandidate;
  approving: boolean;
  onApprove: () => void;
  rejecting: boolean;
  onReject: () => void;
  rejected: boolean;
}) {
  const busy = approving || rejecting;
  return (
    <div
      className={`rounded-md border p-3 text-sm space-y-1.5 transition-opacity ${
        rejected ? 'bg-neutral-50 opacity-50' : 'bg-white'
      }`}
      aria-disabled={rejected}
    >
      <div className="flex items-center gap-2">
        <div className={`font-medium ${rejected ? 'line-through' : ''}`}>
          {candidate.title}
        </div>
        {rejected && (
          <span className="text-xs uppercase tracking-wide text-red-700 bg-red-50 border border-red-200 rounded px-1.5 py-0.5">
            Rejected
          </span>
        )}
      </div>
      <div className="text-neutral-700">{candidate.summary}</div>
      {candidate.why && (
        <div className="text-xs text-neutral-500 italic">
          Why: {candidate.why}
        </div>
      )}
      <div className="flex items-center justify-between pt-1">
        <a
          href={candidate.source_href}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1"
        >
          {candidate.source_label}
          <ArrowTopRightOnSquareIcon className="size-3" />
        </a>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onReject}
            disabled={busy || rejected}
            title={
              rejected
                ? 'Already rejected'
                : 'Reject this candidate and ask autopilot for a replacement'
            }
          >
            {rejecting ? (
              <>
                <ArrowPathIcon className="size-4 animate-spin mr-1" />
                Finding replacement…
              </>
            ) : (
              <>
                <XMarkIcon className="size-4 mr-1 text-red-600" />
                Reject
              </>
            )}
          </Button>
          <Button size="sm" onClick={onApprove} disabled={busy || rejected}>
            {approving ? (
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
          </Button>
        </div>
      </div>
    </div>
  );
}
