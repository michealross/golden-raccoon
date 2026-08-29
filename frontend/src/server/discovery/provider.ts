import type {
  CandidateObservation,
  DiscoveryChainId,
  DiscoveryCursor,
  DiscoveryProviderKind,
  PollResult,
  ProviderPollingConfig,
} from "@/server/discovery/types";
import { normalizeScanNetworkId } from "@/lib/scanNetworks";

// ─── Default polling configs ─────────────────────────────────────────────────

export const defaultPollingConfigs: Record<DiscoveryProviderKind, ProviderPollingConfig> = {
  dexscreener_new_pairs: {
    rateLimit: {
      maxRequestsPerWindow: 60,
      windowMs: 60_000,
      minIntervalMs: 1_000,
    },
    backoff: {
      initialMs: 2_000,
      multiplier: 2.0,
      maxMs: 120_000,
    },
    freshness: {
      maxCursorAgeMs: 300_000,
      pollIntervalMs: 30_000,
    },
  },
  stellar_market: {
    rateLimit: {
      maxRequestsPerWindow: 100,
      windowMs: 60_000,
      minIntervalMs: 600,
    },
    backoff: {
      initialMs: 2_000,
      multiplier: 2.0,
      maxMs: 120_000,
    },
    freshness: {
      maxCursorAgeMs: 600_000,
      pollIntervalMs: 60_000,
    },
  },
};

// ─── Provider interface ──────────────────────────────────────────────────────

export type DiscoveryProvider = {
  /** A unique, stable label for this provider instance. */
  readonly label: string;
  /** The provider kind. */
  readonly kind: DiscoveryProviderKind;
  /** The chain this provider instance polls. */
  readonly chainId: DiscoveryChainId;
  /** Whether this provider can be polled (e.g. env vars present, network reachable). */
  isAvailable(): boolean;
  /**
   * Execute one polling cycle.
   * @param cursor - The current durable cursor (may be null for first poll).
   * @param config - The resolved polling config for this provider.
   * @returns PollResult with new observations and updated cursor.
   */
  poll(cursor: DiscoveryCursor | null, config: ProviderPollingConfig): Promise<PollResult>;
};

// ─── Provider registry ──────────────────────────────────────────────────────

export type ProviderRegistration = {
  provider: DiscoveryProvider;
  config: ProviderPollingConfig;
};

export function normalizeDiscoveryChain(networkId: string): DiscoveryChainId {
  const normalized = normalizeScanNetworkId(networkId);
  return normalized as DiscoveryChainId;
}

export function isDiscoveryChain(value: string): value is DiscoveryChainId {
  const normalized = normalizeScanNetworkId(value);
  const supported: DiscoveryChainId[] = [
    "ethereum", "base", "bsc", "arbitrum", "polygon", "optimism",
    "avalanche", "linea", "scroll", "zksync", "opbnb", "mantle",
    "blast", "fantom", "gnosis", "celo", "moonbeam", "moonriver",
    "berachain", "sonic", "unichain", "worldchain", "monad", "plasma",
    "goat", "stellar-pubnet", "stellar-testnet",
  ];
  return supported.includes(normalized as DiscoveryChainId);
}

export function getStellarDiscoveryChains(): DiscoveryChainId[] {
  return ["stellar-pubnet", "stellar-testnet"];
}

export function isStellarDiscoveryChain(chainId: DiscoveryChainId): boolean {
  return chainId === "stellar-pubnet" || chainId === "stellar-testnet";
}

export function getEvmDiscoveryChains(): DiscoveryChainId[] {
  return [
    "ethereum", "base", "bsc", "arbitrum", "polygon", "optimism",
    "avalanche", "linea", "scroll", "zksync", "opbnb", "mantle",
    "blast", "fantom", "gnosis", "celo", "moonbeam", "moonriver",
    "berachain", "sonic", "unichain", "worldchain", "monad", "plasma",
    "goat",
  ];
}

export function getChainsForProvider(kind: DiscoveryProviderKind): DiscoveryChainId[] {
  switch (kind) {
    case "dexscreener_new_pairs":
      return getEvmDiscoveryChains();
    case "stellar_market":
      return getStellarDiscoveryChains();
    default:
      return [];
  }
}
