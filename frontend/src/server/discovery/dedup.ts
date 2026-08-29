import type {
  CanonicalIdentity,
  DiscoveryChainId,
} from "@/server/discovery/types";

// ─── Canonical key builders ──────────────────────────────────────────────────

/**
 * Build a canonical deduplication key for an EVM asset.
 * Normalises the address to lowercase for consistent matching.
 */
export function canonicalEvmKey(chainId: DiscoveryChainId, address: string): string {
  return `evm:${chainId}:${address.trim().toLowerCase()}`;
}

/**
 * Build a canonical deduplication key for a Stellar asset.
 * Normalises the asset key to uppercase.
 */
export function canonicalStellarKey(chainId: DiscoveryChainId, assetKey: string): string {
  return `stellar:${chainId}:${assetKey.trim().toUpperCase()}`;
}

/**
 * Build a canonical deduplication key from a pair of chain ID and addresses.
 * For EVM chains, uses the token address. For Stellar, uses the asset key.
 */
export function buildCanonicalKey(identity: {
  chainFamily: "evm" | "stellar";
  chainId: DiscoveryChainId;
  address?: string;
  assetKey?: string;
}): string {
  if (identity.chainFamily === "stellar") {
    return canonicalStellarKey(identity.chainId, identity.assetKey ?? identity.address ?? "unknown");
  }
  return canonicalEvmKey(identity.chainId, identity.address ?? "unknown");
}

// ─── Identity builders ───────────────────────────────────────────────────────

export function buildEvmCanonicalIdentity(
  chainId: DiscoveryChainId,
  address: string,
  symbol?: string,
  tokenName?: string,
): CanonicalIdentity {
  const normalizedAddress = address.trim().toLowerCase();
  return {
    canonicalKey: canonicalEvmKey(chainId, normalizedAddress),
    chainFamily: "evm",
    chainId,
    address: normalizedAddress,
    assetKey: normalizedAddress,
    symbol,
    tokenName,
  };
}

export function buildStellarCanonicalIdentity(
  chainId: DiscoveryChainId,
  assetKey: string,
  symbol?: string,
  tokenName?: string,
): CanonicalIdentity {
  const normalizedKey = assetKey.trim().toUpperCase();
  return {
    canonicalKey: canonicalStellarKey(chainId, normalizedKey),
    chainFamily: "stellar",
    chainId,
    address: normalizedKey,
    assetKey: normalizedKey,
    symbol,
    tokenName,
  };
}

// ─── Deduplication state ─────────────────────────────────────────────────────

/**
 * In-memory set of seen canonical keys.
 * Used within a single polling cycle to avoid emitting duplicate observations
 * for the same canonical identity.
 */
export class DedupSet {
  private seen = new Set<string>();

  /** Returns `true` if the key was already seen (duplicate), `false` if first sighting. */
  isDuplicate(canonicalKey: string): boolean {
    return this.seen.has(canonicalKey);
  }

  /** Mark a key as seen. */
  markSeen(canonicalKey: string): void {
    this.seen.add(canonicalKey);
  }

  /** Check and mark in one call. Returns `true` if duplicate, `false` if first. */
  checkAndMark(canonicalKey: string): boolean {
    if (this.seen.has(canonicalKey)) return true;
    this.seen.add(canonicalKey);
    return false;
  }

  /** Number of unique keys tracked. */
  get size(): number {
    return this.seen.size;
  }

  /** Reset the set (for new polling cycles). */
  reset(): void {
    this.seen.clear();
  }
}

// ─── Collision helpers ───────────────────────────────────────────────────────

export type CollisionRecord = {
  canonicalKey: string;
  existingSymbol?: string;
  incomingSymbol?: string;
  chainId: DiscoveryChainId;
  detail: string;
};

/**
 * Detect symbol collisions between canonical identities.
 * Two different keys with different symbols but similar addresses indicate
 * a potential collision worth logging.
 */
export function detectSymbolCollisions(
  existing: CanonicalIdentity,
  incoming: CanonicalIdentity,
): CollisionRecord | null {
  if (existing.canonicalKey === incoming.canonicalKey) return null;
  if (existing.chainId !== incoming.chainId) return null;
  if (!existing.symbol || !incoming.symbol) return null;
  if (existing.symbol === incoming.symbol) return null;

  return {
    canonicalKey: existing.canonicalKey,
    existingSymbol: existing.symbol,
    incomingSymbol: incoming.symbol,
    chainId: existing.chainId,
    detail: `Symbol collision: ${existing.canonicalKey} seen as "${existing.symbol}" and "${incoming.symbol}"`,
  };
}
