import type {
  CandidateObservation,
  CanonicalIdentity,
  DiscoveryCandidate,
  DiscoveryProviderKind,
} from "@/server/discovery/types";
import { createHash } from "node:crypto";

// ─── In-memory observation store ─────────────────────────────────────────────
// Observations are immutable: once written they are never mutated.
// A new observation for the same canonicalKey is appended; callers always
// read the latest (by observedAt).

type ObservationBucket = {
  identity: CanonicalIdentity;
  observations: CandidateObservation[];
};

const store = new Map<string, ObservationBucket>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function observationId(canonicalKey: string, observedAt: string): string {
  const hash = createHash("sha256")
    .update(`${canonicalKey}::${observedAt}`)
    .digest("hex")
    .slice(0, 16);
  return `obs_${hash}`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Store a new observation. If the canonical key already exists, the observation
 * is appended to its bucket. Returns the observation with its generated ID.
 */
export function storeObservation(observation: Omit<CandidateObservation, "id">): CandidateObservation {
  const id = observationId(observation.identity.canonicalKey, observation.observedAt);
  const record: CandidateObservation = { ...observation, id };

  const existing = store.get(observation.identity.canonicalKey);
  if (existing) {
    existing.observations.push(record);
  } else {
    store.set(observation.identity.canonicalKey, {
      identity: observation.identity,
      observations: [record],
    });
  }

  return record;
}

/**
 * Store multiple observations atomically.
 */
export function storeObservations(observations: Omit<CandidateObservation, "id">[]): CandidateObservation[] {
  return observations.map(storeObservation);
}

/**
 * Get the latest observation for a canonical key, or null if none exist.
 */
export function getLatestObservation(canonicalKey: string): CandidateObservation | null {
  const bucket = store.get(canonicalKey);
  if (!bucket || bucket.observations.length === 0) return null;

  return bucket.observations.sort(
    (a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime(),
  )[0];
}

/**
 * Get all observations for a canonical key, sorted newest-first.
 */
export function getObservations(canonicalKey: string, limit = 10): CandidateObservation[] {
  const bucket = store.get(canonicalKey);
  if (!bucket) return [];

  return bucket.observations
    .sort((a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime())
    .slice(0, limit);
}

/**
 * Prune observations for a canonical key, keeping only the N most recent.
 * Returns the number of observations removed.
 */
export function pruneObservations(canonicalKey: string, keep: number): number {
  const bucket = store.get(canonicalKey);
  if (!bucket) return 0;

  const sorted = bucket.observations.sort(
    (a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime(),
  );

  if (sorted.length <= keep) return 0;

  const removed = sorted.length - keep;
  bucket.observations = sorted.slice(0, keep);
  return removed;
}

/**
 * Get all discovery candidates (latest observation per canonical key).
 * This is the primary output of the discovery service.
 */
export function listCandidates(): DiscoveryCandidate[] {
  const candidates: DiscoveryCandidate[] = [];

  for (const [, bucket] of store) {
    const latest = getLatestObservation(bucket.identity.canonicalKey);
    if (!latest) continue;

    candidates.push({
      canonicalKey: bucket.identity.canonicalKey,
      chainFamily: bucket.identity.chainFamily,
      chainId: bucket.identity.chainId,
      address: bucket.identity.address,
      symbol: bucket.identity.symbol,
      tokenName: bucket.identity.tokenName,
      market: latest.market,
      evidence: latest.evidence,
      lastObservedBy: latest.observedBy,
      lastObservedAt: latest.observedAt,
      observationCount: bucket.observations.length,
      riskScore: latest.riskScore,
      riskLevel: latest.riskLevel,
    });
  }

  return candidates;
}

/**
 * Get candidates filtered by provider kind.
 */
export function listCandidatesByProvider(kind: DiscoveryProviderKind): DiscoveryCandidate[] {
  return listCandidates().filter((c) => c.lastObservedBy === kind);
}

/**
 * Get candidates filtered by chain ID.
 */
export function listCandidatesByChain(chainId: string): DiscoveryCandidate[] {
  return listCandidates().filter((c) => c.chainId === chainId);
}

/**
 * Get total number of stored observations.
 */
export function getObservationCount(): number {
  let count = 0;
  for (const [, bucket] of store) {
    count += bucket.observations.length;
  }
  return count;
}

/**
 * Get the number of unique canonical identities tracked.
 */
export function getUniqueIdentityCount(): number {
  return store.size;
}

/**
 * Reset the store (for testing / fixture replay).
 */
export function resetStore(): void {
  store.clear();
}

/**
 * Dump all store contents (for serialisation / inspection).
 */
export function dumpStore(): Record<string, unknown>[] {
  const dumped: Record<string, unknown>[] = [];
  for (const [, bucket] of store) {
    for (const obs of bucket.observations) {
      dumped.push({
        id: obs.id,
        canonicalKey: obs.identity.canonicalKey,
        chainFamily: obs.identity.chainFamily,
        chainId: obs.identity.chainId,
        observedBy: obs.observedBy,
        observedAt: obs.observedAt,
        symbol: obs.identity.symbol,
        tokenName: obs.identity.tokenName,
        market: obs.market,
        evidenceCount: obs.evidence.length,
        riskScore: obs.riskScore,
      });
    }
  }
  return dumped;
}
