import { lazy, Suspense, useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Page } from '@/components/shared/Page';
import { Tabs } from '@/components/ui';

const PodcastsList = lazy(() => import('./index'));
const GuestsList = lazy(() => import('./guests/index'));

const TABS = [
  { id: 'podcasts', label: 'Podcasts' },
  { id: 'guests',   label: 'Guest List' },
] as const;

type TabId = typeof TABS[number]['id'];

export default function PodcastsShell() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const tabId: TabId = useMemo(() => {
    if (pathname === '/podcasts/guests') return 'guests';
    return 'podcasts';
  }, [pathname]);

  const onChange = useCallback((id: string) => {
    if (id === 'podcasts') navigate('/podcasts');
    else navigate(`/podcasts/${id}`);
  }, [navigate]);

  return (
    <Page title="Podcasts">
      <div className="px-(--margin-x) py-6 space-y-4">
        <Tabs value={tabId} onChange={onChange} tabs={TABS as unknown as { id: string; label: string }[]} />

        <Suspense fallback={<div className="p-8 text-sm text-[var(--gray-11)]">Loading…</div>}>
          {tabId === 'podcasts' && <PodcastsList />}
          {tabId === 'guests'   && <GuestsList />}
        </Suspense>
      </div>
    </Page>
  );
}
