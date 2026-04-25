import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Table, THead, TBody, Tr, Th, Td } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import {
  membershipService,
  type MemberOrganization,
  type MembershipTier,
  type SyncRun,
} from '../utils/membershipService';

const inputClass =
  'w-full px-3 py-1.5 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]';

export default function MembersPage() {
  const [members, setMembers] = useState<MemberOrganization[]>([]);
  const [tiers, setTiers] = useState<MembershipTier[]>([]);
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterTier, setFilterTier] = useState('');
  const [filterActive, setFilterActive] = useState<'true' | 'false' | ''>('true');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [m, t, r] = await Promise.all([
        membershipService.listMembers({
          tier: filterTier || undefined,
          is_active: filterActive === '' ? undefined : filterActive === 'true',
        }),
        membershipService.listTiers(),
        membershipService.listSyncRuns(),
      ]);
      setMembers(m);
      setTiers(t);
      setRuns(r.slice(0, 5));
    } finally {
      setLoading(false);
    }
  }, [filterTier, filterActive]);

  useEffect(() => { load(); }, [load]);

  const runSync = useCallback(async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await membershipService.runSync();
      setSyncMsg(`Synced — seen ${r.seen}, inserted ${r.inserted}, updated ${r.updated}, deactivated ${r.deactivated}, logos ${r.logos}.`);
      load();
    } catch (e: any) {
      setSyncMsg(`Sync failed: ${e.message ?? e}`);
    } finally {
      setSyncing(false);
    }
  }, [load]);

  const tierBadge = (m: MemberOrganization) => {
    const t = tiers.find(x => x.tier === m.tier);
    const color = (t?.color || '#6B7280').replace('#', '');
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded font-medium"
        style={{ backgroundColor: `#${color}20`, color: `#${color}` }}
      >
        {t?.display_label ?? m.tier}
      </span>
    );
  };

  return (
    <Page title="Members">
      <div className="p-6">
        <div className="flex items-start justify-between mb-6 gap-4">
          <div>
            <h1 className="text-2xl font-semibold mb-1">Member organizations</h1>
            <p className="text-sm text-[var(--gray-11)]">
              Members are auto-synced as keyword rules. Content mentioning a member is tagged <code>category=members</code> and ranked by tier.
            </p>
          </div>
          <Button onClick={runSync} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync from AAIF'}
          </Button>
        </div>

        {syncMsg && (
          <Card className="p-3 mb-4 text-sm">
            {syncMsg}
          </Card>
        )}

        {/* Tier overview */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          {tiers.map(t => {
            const count = members.filter(m => m.tier === t.tier && m.is_active).length;
            return (
              <Card key={t.tier} className="p-4">
                <div className="flex items-center justify-between mb-1">
                  <span style={{ color: t.color ?? undefined }} className="font-medium">{t.display_label}</span>
                  <Badge variant="soft" color="gray">rank {t.rank}</Badge>
                </div>
                <div className="text-2xl font-semibold">{count}</div>
                <div className="text-xs text-[var(--gray-11)] mt-1">{t.description}</div>
              </Card>
            );
          })}
        </div>

        {/* Recent sync runs */}
        {runs.length > 0 && (
          <Card className="p-4 mb-6">
            <h3 className="font-medium mb-2 text-sm">Recent sync runs</h3>
            <div className="space-y-1 text-sm">
              {runs.map(r => (
                <div key={r.id} className="flex items-center gap-3 py-1 border-b border-[var(--gray-a3)] last:border-0">
                  <Badge variant="soft" color={r.status === 'complete' ? 'green' : r.status === 'failed' ? 'red' : 'amber'}>{r.status}</Badge>
                  <span className="text-xs text-[var(--gray-10)]">{new Date(r.created_at).toLocaleString()}</span>
                  <span className="text-xs">seen {r.members_seen} · ins {r.members_inserted} · upd {r.members_updated} · deact {r.members_deactivated} · logos {r.logos_downloaded}</span>
                  {r.error_message && <span className="text-xs text-[var(--red-11)]">{r.error_message}</span>}
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Filters */}
        <div className="flex gap-2 mb-4">
          <select className={inputClass} value={filterTier} onChange={e => setFilterTier(e.target.value)} style={{ maxWidth: 200 }}>
            <option value="">All tiers</option>
            {tiers.map(t => <option key={t.tier} value={t.tier}>{t.display_label}</option>)}
          </select>
          <select className={inputClass} value={filterActive} onChange={e => setFilterActive(e.target.value as any)} style={{ maxWidth: 200 }}>
            <option value="true">Active only</option>
            <option value="false">Inactive only</option>
            <option value="">All</option>
          </select>
        </div>

        {/* Members table */}
        <Card>
          {loading ? <div className="p-8 text-center text-sm text-[var(--gray-11)]">Loading…</div> : (
            <Table>
              <THead>
                <Tr>
                  <Th>Logo</Th>
                  <Th>Name</Th>
                  <Th>Tier</Th>
                  <Th>Rank</Th>
                  <Th>Website</Th>
                  <Th>Status</Th>
                  <Th>Last synced</Th>
                </Tr>
              </THead>
              <TBody>
                {members.map(m => (
                  <Tr key={m.id}>
                    <Td>
                      {m.logo_url ? (
                        <img src={m.logo_url} alt={m.name} className="h-8 w-auto object-contain" />
                      ) : (
                        <span className="text-xs text-[var(--gray-10)]">—</span>
                      )}
                    </Td>
                    <Td><span className="font-medium">{m.name}</span></Td>
                    <Td>{tierBadge(m)}</Td>
                    <Td className="text-sm">{m.tier_rank}</Td>
                    <Td>
                      {m.website_url && (
                        <a href={m.website_url} target="_blank" rel="noopener noreferrer" className="text-xs text-[var(--accent-11)] hover:underline">
                          {new URL(m.website_url).hostname}
                        </a>
                      )}
                    </Td>
                    <Td>
                      <Badge variant="soft" color={m.is_active ? 'green' : 'gray'}>
                        {m.is_active ? 'active' : 'inactive'}
                      </Badge>
                    </Td>
                    <Td className="text-xs text-[var(--gray-11)]">
                      {m.last_synced_at ? new Date(m.last_synced_at).toLocaleDateString() : '—'}
                    </Td>
                  </Tr>
                ))}
                {members.length === 0 && (
                  <Tr><Td colSpan={7} className="text-center text-sm text-[var(--gray-11)] py-8">
                    No members. Click "Sync from AAIF" above.
                  </Td></Tr>
                )}
              </TBody>
            </Table>
          )}
        </Card>
      </div>
    </Page>
  );
}
