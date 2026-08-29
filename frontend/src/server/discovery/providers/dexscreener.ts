import type {
  CandidateMarketData,
  CandidateObservation,
  DiscoveryChainId,
  DiscoveryCursor,
  PollResult,
  ProviderEvidence,
  ProviderPollingConfig,
} from "@/server/discovery/types";
import type { DiscoveryProvider } from "@/server/discovery/provider";
import { updateCursorSuccess, updateCursorFailure, isCursorReady } from "@/server/discovery/cursor";
import { buildEvmCanonicalIdentity, DedupSet } from "@/server/discovery/dedup";
import { getScanNetwork } from "@/lib/scanNetworks";

// ─── DexScreener API types ───────────────────────────────────────────────────

type DexScreenerTokenProfile = {
  url: string;
  chainId: string;
  tokenAddress: string;
  icon?: string;
  header?: string;
  description?: string;
  links?: {
    website?: string;
    twitter?: string;
    telegram?: string;
    discord?: string;
  };
};

type DexScreenerPair = {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken?: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken?: {
    address: string;
    name: string;
    symbol: string;
  };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    header?: string;
    openGraph?: string;
    websites?: { label: string; url: string }[];
    socials?: { type: string; url: string }[];
  };
};

type DexScreenerSearchResponse = {
  schemaVersion?: string;
  pairs: DexScreenerPair[];
};

// ─── Provider label ──────────────────────────────────────────────────────────

const PROVIDER_KIND = "dexscreener_new_pairs" as const;

// ─── Rate-limit tracker ──────────────────────────────────────────────────────

const requestTimestamps: number[] = [];

function checkRateLimit(config: ProviderPollingConfig): boolean {
  const now = Date.now();
  const window = requestTimestamps.filter((ts) => now - ts < config.rateLimit.windowMs);
  requestTimestamps.length = 0;
  requestTimestamps.push(...window);
  if (requestTimestamps.length >= config.rateLimit.maxRequestsPerWindow) return false;
  const lastTs = requestTimestamps[requestTimestamps.length - 1];
  if (lastTs && now - lastTs < config.rateLimit.minIntervalMs) return false;
  return true;
}

function markRequestSent(): void {
  requestTimestamps.push(Date.now());
}

// ─── DexScreener API ─────────────────────────────────────────────────────────

async function fetchLatestTokenProfiles(): Promise<DexScreenerTokenProfile[]> {
  const response = await fetch("https://api.dexscreener.com/token-profiles/latest/v1", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error("DexScreener token profiles request failed with " + response.status);
  }
  return response.json() as Promise<DexScreenerTokenProfile[]>;
}

/**
 * Search DexScreener for all pairs matching a token address.
 * This is the correct endpoint for resolving a token address into its pairs.
 */
async function searchPairsByToken(tokenAddress: string): Promise<DexScreenerPair[]> {
  const url = new URL("https://api.dexscreener.com/latest/dex/search");
  url.searchParams.set("q", tokenAddress);

  const response = await fetch(url.toString(), {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error("DexScreener search request failed with " + response.status);
  }
  const data = (await response.json()) as DexScreenerSearchResponse;
  return data.pairs ?? [];
}

// ─── Normalisation ───────────────────────────────────────────────────────────

function normalizeDexScreenerChain(chainId: string): DiscoveryChainId | null {
  const network = getScanNetwork(chainId);
  if (!network) return null;
  return network.id as DiscoveryChainId;
}

function buildMarketData(pair: DexScreenerPair, profile?: DexScreenerTokenProfile): CandidateMarketData {
  const liquidityUsd = pair.liquidity?.usd;
  const volume24hUsd = pair.volume?.h24;
  const fdvUsd = pair.fdv ?? pair.marketCap;
  const pairAgeDays = pair.pairCreatedAt
    ? Math.floor((Date.now() - pair.pairCreatedAt) / 86_400_000)
    : undefined;
  const hasOfficialLink = Boolean(
    pair.info?.websites?.some((w) => w.label?.toLowerCase().includes("website")) ??
      profile?.links?.website,
  );
  const hasTwitterProfile = Boolean(
    pair.info?.socials?.some((s) => s.type?.toLowerCase().includes("twitter")) ??
      profile?.links?.twitter,
  );

  const fdvLiquidityRatio =
    typeof liquidityUsd === "number" && liquidityUsd > 0 && typeof fdvUsd === "number" && fdvUsd > 0
      ? fdvUsd / liquidityUsd
      : undefined;

  return {
    pairAgeDays,
    liquidityUsd: typeof liquidityUsd === "number" ? liquidityUsd : undefined,
    volume24hUsd: typeof volume24hUsd === "number" ? volume24hUsd : undefined,
    fdvUsd: typeof fdvUsd === "number" ? fdvUsd : undefined,
    fdvLiquidityRatio,
    volatilityPercent24h: pair.priceChange?.h24 !== undefined ? Math.abs(pair.priceChange.h24) : undefined,
    hasOfficialLink,
    hasTwitterProfile,
    isVerified: undefined,
    poolCount: undefined,
  };
}

function buildEvidence(
  pairs: DexScreenerPair[],
  profile?: DexScreenerTokenProfile,
  latencyMs?: number,
): ProviderEvidence[] {
  const evidence: ProviderEvidence[] = [];

  // Primary evidence: first pair found
  const primaryPair = pairs[0];
  if (primaryPair) {
    evidence.push({
      providerKind: PROVIDER_KIND,
      sourceLabel: "DexScreener API",
      sourceUrl: primaryPair.url,
      externalId: primaryPair.pairAddress,
      fetchedAt: new Date().toISOString(),
      latencyMs,
      rawPayloadPreview: {
        chainId: primaryPair.chainId,
        dexId: primaryPair.dexId,
        pairAddress: primaryPair.pairAddress,
        priceUsd: primaryPair.priceUsd,
        liquidityUsd: primaryPair.liquidity?.usd,
        volume24h: primaryPair.volume?.h24,
        pairCount: pairs.length,
      },
    });
  }

  // Secondary evidence: token profile
  if (profile) {
    evidence.push({
      providerKind: PROVIDER_KIND,
      sourceLabel: "DexScreener Token Profile",
      sourceUrl: profile.url,
      externalId: profile.tokenAddress,
      fetchedAt: new Date().toISOString(),
      rawPayloadPreview: {
        chainId: profile.chainId,
        tokenAddress: profile.tokenAddress,
        hasLinks: Boolean(profile.links),
      },
    });
  }

  return evidence;
}

// ─── Provider implementation ─────────────────────────────────────────────────

export function createDexScreenerProvider(chainId: DiscoveryChainId): DiscoveryProvider {
  return {
    label: "DexScreener New Pairs (" + chainId + ")",
    kind: PROVIDER_KIND,
    chainId,

    isAvailable(): boolean {
      return true;
    },

    async poll(
      cursor: DiscoveryCursor | null,
      config: ProviderPollingConfig,
    ): Promise<PollResult> {
      const startedAt = performance.now();
      const dedup = new DedupSet();
      const observations: CandidateObservation[] = [];

      try {
        if (!isCursorReady(cursor)) {
          return {
            chainId,
            providerKind: PROVIDER_KIND,
            observations: [],
            cursor: cursor ?? {
              providerKind: PROVIDER_KIND,
              chainId,
              cursor: "",
              updatedAt: new Date().toISOString(),
              consecutiveFailures: 0,
              nextAllowedPollMs: 0,
            },
            ok: true,
            elapsedMs: Math.round(performance.now() - startedAt),
          };
        }

        // Fetch latest token profiles
        if (!checkRateLimit(config)) {
          return {
            chainId,
            providerKind: PROVIDER_KIND,
            observations: [],
            cursor: cursor ?? {
              providerKind: PROVIDER_KIND,
              chainId,
              cursor: "",
              updatedAt: new Date().toISOString(),
              consecutiveFailures: 0,
              nextAllowedPollMs: Date.now() + 1_000,
            },
            ok: true,
            elapsedMs: Math.round(performance.now() - startedAt),
          };
        }

        markRequestSent();
        const profiles = await fetchLatestTokenProfiles();

        // Filter to only our chain
        const chainProfiles = profiles.filter(
          (p) => normalizeDexScreenerChain(p.chainId) === chainId,
        );

        // Search pairs for each token profile using the correct search endpoint
        for (const profile of chainProfiles.slice(0, 10)) {
          if (!checkRateLimit(config)) break;

          try {
            markRequestSent();
            const searchStartedAt = performance.now();
            const pairs = await searchPairsByToken(profile.tokenAddress);
            if (pairs.length === 0) continue;

            // Use the best (highest liquidity) pair for the chain we care about
            const chainPairs = pairs.filter(
              (p) => normalizeDexScreenerChain(p.chainId) === chainId,
            );
            if (chainPairs.length === 0) continue;

            const bestPair = chainPairs.sort(
              (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
            )[0];
            if (!bestPair.baseToken) continue;

            // Build canonical identity
            const resolvedChainId = normalizeDexScreenerChain(bestPair.chainId);
            if (!resolvedChainId || resolvedChainId !== chainId) continue;

            const identity = buildEvmCanonicalIdentity(
              resolvedChainId,
              bestPair.baseToken.address,
              bestPair.baseToken.symbol,
              bestPair.baseToken.name,
            );

            // Deduplication check
            if (dedup.checkAndMark(identity.canonicalKey)) continue;

            const market = buildMarketData(bestPair, profile);
            const evidence = buildEvidence(
              chainPairs,
              profile,
              Math.round(performance.now() - searchStartedAt),
            );
            const observedAt = new Date().toISOString();

            observations.push({
              id: "",
              identity,
              observedBy: PROVIDER_KIND,
              observedAt,
              market,
              evidence,
            });
          } catch {
            // Skip tokens that fail individually
          }
        }

        // Update cursor to the latest profile timestamp
        const newCursor = updateCursorSuccess(
          PROVIDER_KIND,
          chainId,
          profiles.length > 0 ? profiles[0].tokenAddress : cursor?.cursor ?? "",
        );

        return {
          chainId,
          providerKind: PROVIDER_KIND,
          observations,
          cursor: newCursor,
          ok: true,
          elapsedMs: Math.round(performance.now() - startedAt),
        };
      } catch (error) {
        const newCursor = updateCursorFailure(PROVIDER_KIND, chainId, config.backoff);
        return {
          chainId,
          providerKind: PROVIDER_KIND,
          observations: [],
          cursor: newCursor,
          ok: false,
          error: error instanceof Error ? error.message : "DexScreener poll failed",
          elapsedMs: Math.round(performance.now() - startedAt),
        };
      }
    },
  };
}
