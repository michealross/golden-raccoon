export const goldenFixtureSuite = [
  "blue_chip_clean_token",
  "verified_stablecoin",
  "honeypot",
  "cannot_sell",
  "low_liquidity",
  "fake_official_social",
  "phishing_claim",
  "symbol_collision",
  "provider_unavailable",
  "conflicting_sources",
  // Discovery fixtures
  "dexscreener_new_pair",
  "stellar_new_asset",
  "dedup_collapse_duplicates",
  "polling_resume_after_restart",
  "provider_outage_backoff",
  "stale_cursor_freshness",
] as const;

export type GoldenFixtureName = (typeof goldenFixtureSuite)[number];

export const goldenScoreSnapshots: Record<GoldenFixtureName, { min: number; max: number; criticalNeverDowngrade?: boolean }> = {
  blue_chip_clean_token: { min: 0, max: 35 },
  verified_stablecoin: { min: 0, max: 25 },
  honeypot: { min: 75, max: 100, criticalNeverDowngrade: true },
  cannot_sell: { min: 75, max: 100, criticalNeverDowngrade: true },
  low_liquidity: { min: 50, max: 90 },
  fake_official_social: { min: 50, max: 100 },
  phishing_claim: { min: 75, max: 100, criticalNeverDowngrade: true },
  symbol_collision: { min: 40, max: 85 },
  provider_unavailable: { min: 40, max: 80 },
  conflicting_sources: { min: 50, max: 95 },
  // Discovery fixtures — these are boundary tests, not score assertions
  dexscreener_new_pair: { min: 0, max: 100 },
  stellar_new_asset: { min: 0, max: 100 },
  dedup_collapse_duplicates: { min: 0, max: 100 },
  polling_resume_after_restart: { min: 0, max: 100 },
  provider_outage_backoff: { min: 0, max: 100 },
  stale_cursor_freshness: { min: 0, max: 100 },
};

export function assertGoldenScore(name: GoldenFixtureName, score: number) {
  const snapshot = goldenScoreSnapshots[name];

  return score >= snapshot.min && score <= snapshot.max;
}
