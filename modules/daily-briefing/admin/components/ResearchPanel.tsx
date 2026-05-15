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
}

export default function ResearchPanel({
  dayId,
  briefDate,
  onCandidateApproved,
}: Props) {
  const [thread, setThread] = useState<ResearchThread | null>(null);
  const [messages, setMessages] = useState<ResearchMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [approvingKey, setApprovingKey] = useState<string | null>(null);
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

  async function handleSend(message?: string) {
    const text = (message ?? input).trim();
    if (!text && messages.length > 0) return;
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
    } catch (err) {
      console.error('[daily-briefing] send research message failed', err);
      toast.error(err instanceof Error ? err.message : 'Send failed');
      // Re-pull thread so a 'failed' status surfaces in the UI.
      await hydrate();
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
}: {
  message: ResearchMessage;
  approvingKey: string | null;
  onApprove: (candidateIndex: number) => void;
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
            {candidates.map((c, idx) => (
              <CandidateCard
                key={`${message.id}:${idx}`}
                candidate={c}
                approving={approvingKey === `${message.id}:${idx}`}
                onApprove={() => onApprove(idx)}
              />
            ))}
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
}: {
  candidate: ResearchCandidate;
  approving: boolean;
  onApprove: () => void;
}) {
  return (
    <div className="rounded-md border bg-white p-3 text-sm space-y-1.5">
      <div className="font-medium">{candidate.title}</div>
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
        <Button size="sm" onClick={onApprove} disabled={approving}>
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
  );
}
