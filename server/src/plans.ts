// Plan tiers for the share service (free / Pro / Team).
//
// Real billing/subscription is intentionally out of scope for this self-hosted
// service: a tier is resolved from the GitHub login via an allow-list (env vars)
// plus the persisted `tier` column on the account. Operators who run jsona with
// payments later can swap `resolveTier` for a real entitlement lookup without
// touching the quota-enforcement code in server.ts.
//
// Quota dimensions (kept in sync with docs/pricing in 开发计划.md §7):
//   - maxBytes:   max shareable document size (source string length)
//   - maxShares:  total live shares allowed per account (0 = unlimited)
//   - ttlDays:    how long a share link stays valid
//   - password:   whether share links can be protected with a password

export type Tier = 'free' | 'pro' | 'team';

export interface PlanQuota {
  tier: Tier;
  label: string;
  maxBytes: number;
  maxShares: number;
  ttlDays: number;
  password: boolean;
}

const KB = 1024;
const MB = 1024 * KB;

export const PLANS: Record<Tier, PlanQuota> = {
  free: {
    tier: 'free',
    label: 'Free',
    maxBytes: 1 * MB,
    maxShares: 10,
    ttlDays: 7,
    password: false,
  },
  pro: {
    tier: 'pro',
    label: 'Pro',
    maxBytes: 10 * MB,
    maxShares: 0, // unlimited
    ttlDays: 30,
    password: false,
  },
  team: {
    tier: 'team',
    label: 'Team',
    maxBytes: 50 * MB,
    maxShares: 0, // unlimited
    ttlDays: 90,
    password: true,
  },
};

// Anonymous (non-logged-in) shares are capped at the free tier.
export const ANON_QUOTA = PLANS.free;
// Hard ceiling never exceeded regardless of plan (abuse guard).
export const ABSOLUTE_MAX_BYTES = 50 * MB;

// Login -> tier allow-lists (comma-separated GitHub logins, lower-cased).
const PRO_LOGINS = (process.env.PRO_LOGINS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const TEAM_LOGINS = (process.env.TEAM_LOGINS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export function tierFromAllowList(login: string): Tier | null {
  const l = login.toLowerCase();
  if (TEAM_LOGINS.includes(l)) return 'team';
  if (PRO_LOGINS.includes(l)) return 'pro';
  return null;
}

export function isUnlimited(quota: PlanQuota): boolean {
  return quota.maxShares === 0;
}

export function formatBytes(n: number): string {
  if (n >= MB) return `${(n / MB).toFixed(n % MB === 0 ? 0 : 1)} MB`;
  if (n >= KB) return `${(n / KB).toFixed(0)} KB`;
  return `${n} B`;
}
