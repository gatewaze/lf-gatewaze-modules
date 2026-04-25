import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Card } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { membershipService, type MemberOrganization, type MembershipTier } from '../utils/membershipService';

export default function MemberDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [member, setMember] = useState<MemberOrganization | null>(null);
  const [tiers, setTiers] = useState<MembershipTier[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [list, t] = await Promise.all([
        membershipService.listMembers(),
        membershipService.listTiers(),
      ]);
      setMember(list.find(m => m.id === id) ?? null);
      setTiers(t);
    })();
  }, [id]);

  if (!member) return <Page title="Member"><div className="p-6">Loading…</div></Page>;

  const save = async (patch: Partial<MemberOrganization>) => {
    setSaving(true); setErr(null);
    try {
      const updated = await membershipService.updateMember(member.id, patch);
      setMember(updated);
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Page title={member.name}>
      <div className="p-6 max-w-3xl space-y-4">
        <Button variant="ghost" onClick={() => navigate(-1)}>← Back</Button>

        {err && <Card className="p-3 bg-[var(--red-a3)] text-[var(--red-11)]">{err}</Card>}

        <Card className="p-6 space-y-4">
          <div className="flex gap-4 items-start">
            {member.logo_url && <img src={member.logo_url} alt={member.name} className="h-16 w-auto object-contain" />}
            <div>
              <h1 className="text-xl font-semibold">{member.name}</h1>
              <a href={member.website_url ?? '#'} target="_blank" rel="noopener noreferrer" className="text-sm text-[var(--accent-11)]">
                {member.website_url}
              </a>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Tier</label>
            <select
              className="px-3 py-1.5 border border-[var(--gray-a6)] rounded-md text-sm"
              value={member.tier}
              onChange={(e) => save({ tier: e.target.value })}
              disabled={saving}
            >
              {tiers.map(t => <option key={t.tier} value={t.tier}>{t.display_label} (rank {t.rank})</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Status</label>
            <Button onClick={() => save({ is_active: !member.is_active })} disabled={saving}>
              {member.is_active ? 'Deactivate' : 'Activate'}
            </Button>
          </div>

          <div className="text-xs text-[var(--gray-11)] grid grid-cols-2 gap-2">
            <div>Slug: <code>{member.slug}</code></div>
            <div>tier_rank: {member.tier_rank}</div>
            <div>Last synced: {member.last_synced_at ? new Date(member.last_synced_at).toLocaleString() : '—'}</div>
            <div>Logo synced: {member.logo_synced_at ? new Date(member.logo_synced_at).toLocaleString() : '—'}</div>
          </div>
        </Card>
      </div>
    </Page>
  );
}
