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
import { buildStellarCanonicalIdentity, DedupSet } from "@/server/discovery/dedup";
import { createStellarDataServer, createStellarRpcServer } from "@/server/stellar/client";
import { parseStellarAssetInput, canonicalClassicAssetKey } from "@/server/stellar/assetIdentity";
import { normalizeStellarNetworkId } from "@/lib/stellar/config";

// ─── Provider label ──────────────────────────────────────────────────────────

const PROVIDER_KIND = "stellar_market" as const;

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

// ─── Stellar Horizon types ───────────────────────────────────────────────────

type HorizonAssetRecord = {
  asset_type: "credit_alphanum4" | "credit_alphanum12" | "native";
  asset_code?: string;
  asset_issuer?: string;
  num_accounts?: number;
  num_claims?: number;
  num_liquidity_pools?: number;
  liquidity_pools_amount?: string;
  amount?: string;
  accounts?: {
    authorized?: number;
    authorized_to_maintain_liabilities?: number;
    unauthorized?: number;
  };
  claimable_balances_amount?: string;
  flags?: {
    auth_required?: boolean;
    auth_revocable?: boolean;
    auth_immutable?: boolean;
    auth_clawback_enabled?: boolean;
  };
  contract_id?: string;
  last_modified_ledger?: number;
};

type HorizonLiquidityPoolRecord = {
  id: string;
  total_shares: string;
  total_amounts: string[];
  reserves: Array<{
    asset: string;
    amount: string;
  }>;
  fee_bp: number;
  last_modified_ledger?: number;
  paging_token: string;
};

type HorizonPage<T> = {
  _embedded: {
    records: T[];
  };
  _links?: {
    next?: { href?: string };
    self?: { href?: string };
  };
};

// ─── Stellar network mapping ─────────────────────────────────────────────────

function stellarChainToNetworkId(chainId: DiscoveryChainId): string | null {
  const mapping: Record<string, string> = {
    "stellar-pubnet": "pubnet",
    "stellar-testnet": "testnet",
  };
  return mapping[chainId] ?? null;
}

// ─── Horizon queries ─────────────────────────────────────────────────────────

async function fetchRecentAssets(
  networkId: string,
  cursor: string | null,
): Promise<{ records: HorizonAssetRecord[]; nextCursor: string }> {
  const { server } = createStellarDataServer(networkId);

  let callBuilder = server.assets().limit(50).order("desc");
  if (cursor) {
    callBuilder = callBuilder.cursor(cursor) as typeof callBuilder;
  }

  const page = await callBuilder.call() as unknown as HorizonPage<HorizonAssetRecord>;
  const records = page._embedded?.records ?? [];
  const nextCursor =
    records.length > 0
      ? records[records.length - 1]?.last_modified_ledger?.toString() ?? ""
      : cursor ?? "";

  return { records, nextCursor };
}

async function fetchLiquidityPools(
  networkId: string,
  cursor: string | null,
): Promise<{ records: HorizonLiquidityPoolRecord[]; nextCursor: string }> {
  const { server } = createStellarDataServer(networkId);

  let callBuilder = server.liquidityPools().limit(50).order("desc");
  if (cursor) {
    callBuilder = callBuilder.cursor(cursor) as typeof callBuilder;
  }

  const page = await callBuilder.call() as unknown as HorizonPage<HorizonLiquidityPoolRecord>;
  const records = page._embedded?.records ?? [];
  const nextCursor =
    records.length > 0
      ? records[records.length - 1]?.paging_token ?? ""
      : cursor ?? "";

  return { records, nextCursor };
}

// ─── Normalisation ───────────────────────────────────────────────────────────

function buildMarketDataFromAsset(asset: HorizonAssetRecord): CandidateMarketData {
  const liquidityAmount = Number(asset.liquidity_pools_amount ?? 0);
  const poolCount = asset.num_liquidity_pools ?? 0;

  return {
    pairAgeDays: asset.last_modified_ledger ? undefined : undefined, // Ledger age isn't directly time-based
    liquidityUsd: liquidityAmount > 0 ? liquidityAmount : undefined,
    volume24hUsd: undefined, // Horizon doesn't provide 24h volume
    fdvUsd: undefined,
    fdvLiquidityRatio: undefined,
    volatilityPercent24h: undefined,
    hasOfficialLink: undefined, // Horizon doesn't provide link data
    hasTwitterProfile: undefined,
    isVerified: asset.contract_id ? true : undefined,
    poolCount: poolCount > 0 ? poolCount : undefined,
  };
}

function buildMarketDataFromPool(pool: HorizonLiquidityPoolRecord): CandidateMarketData {
  // Parse the reserve assets to get the token information
  const reserveAssets = pool.reserves.map((r) => r.asset);
  const nativeReserve = reserveAssets.find((a) => a === "native");
  const otherReserve = reserveAssets.find((a) => a !== "native");

  return {
    pairAgeDays: undefined,
    liquidityUsd: pool.total_shares ? Number(pool.total_shares) : undefined,
    volume24hUsd: undefined,
    fdvUsd: undefined,
    fdvLiquidityRatio: undefined,
    volatilityPercent24h: undefined,
    hasOfficialLink: undefined,
    hasTwitterProfile: undefined,
    isVerified: undefined,
    poolCount: 1,
  };
}

function buildEvidenceFromAsset(
  asset: HorizonAssetRecord,
  networkId: string,
  latencyMs?: number,
): ProviderEvidence[] {
  const assetCode = asset.asset_code ?? "XLM";
  const assetIssuer = asset.asset_issuer ?? "";
  const externalId = assetIssuer ? `${assetCode}:${assetIssuer}` : "native";

  return [
    {
      providerKind: PROVIDER_KIND,
      sourceLabel: `Stellar Horizon Assets (${networkId})`,
      sourceUrl: assetIssuer
        ? `https://stellar.expert/explorer/${networkId === "pubnet" ? "public" : "testnet"}/asset/${assetCode}-${assetIssuer}`
        : undefined,
      externalId,
      fetchedAt: new Date().toISOString(),
      latencyMs,
      rawPayloadPreview: {
        assetType: asset.asset_type,
        assetCode,
        poolCount: asset.num_liquidity_pools,
        authorizedAccounts: asset.accounts?.authorized,
        hasContractId: Boolean(asset.contract_id),
      },
    },
  ];
}

function buildEvidenceFromPool(
  pool: HorizonLiquidityPoolRecord,
  networkId: string,
  latencyMs?: number,
): ProviderEvidence[] {
  return [
    {
      providerKind: PROVIDER_KIND,
      sourceLabel: `Stellar Horizon Liquidity Pools (${networkId})`,
      sourceUrl: `https://stellar.expert/explorer/${networkId === "pubnet" ? "public" : "testnet"}/liquidity-pool/${pool.id}`,
      externalId: pool.id,
      fetchedAt: new Date().toISOString(),
      latencyMs,
      rawPayloadPreview: {
        poolId: pool.id,
        reserves: pool.reserves.map((r) => ({ asset: r.asset, amount: r.amount })),
        totalShares: pool.total_shares,
        feeBp: pool.fee_bp,
      },
    },
  ];
}

// ─── Provider implementation ─────────────────────────────────────────────────

export function createStellarMarketProvider(chainId: DiscoveryChainId): DiscoveryProvider {
  return {
    label: `Stellar Market/Liquidity (${chainId})`,
    kind: PROVIDER_KIND,
    chainId,

    isAvailable(): boolean {
      return normalizeStellarNetworkId(chainId) !== null;
    },

    async poll(
      cursor: DiscoveryCursor | null,
      config: ProviderPollingConfig,
    ): Promise<PollResult> {
      const startedAt = performance.now();
      const dedup = new DedupSet();
      const observations: CandidateObservation[] = [];
      const networkId = stellarChainToNetworkId(chainId);

      if (!networkId || !normalizeStellarNetworkId(chainId)) {
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
          ok: false,
          error: `Unsupported Stellar chain: ${chainId}`,
          elapsedMs: Math.round(performance.now() - startedAt),
        };
      }

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

        // Check rate limit
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

        // Fetch recent assets from Horizon
        markRequestSent();
        const assetStartedAt = performance.now();
        const { records: assets, nextCursor: assetCursor } = await fetchRecentAssets(
          networkId,
          cursor?.cursor ?? null,
        );

        for (const asset of assets) {
          const assetKey = asset.asset_code && asset.asset_issuer
            ? canonicalClassicAssetKey(asset.asset_code, asset.asset_issuer)
            : "native";
          const symbol = asset.asset_code ?? "XLM";
          const tokenName = `${asset.asset_code ?? "Stellar Lumens"}`;

          const identity = buildStellarCanonicalIdentity(chainId, assetKey, symbol, tokenName);

          if (dedup.checkAndMark(identity.canonicalKey)) continue;

          const market = buildMarketDataFromAsset(asset);
          const evidence = buildEvidenceFromAsset(asset, networkId, Math.round(performance.now() - assetStartedAt));
          const observedAt = new Date().toISOString();

          observations.push({
            id: "",
            identity,
            observedBy: PROVIDER_KIND,
            observedAt,
            market,
            evidence,
          });
        }

        // Also fetch liquidity pools for additional market data
        if (checkRateLimit(config)) {
          markRequestSent();
          const poolStartedAt = performance.now();
          const { records: pools } = await fetchLiquidityPools(networkId, cursor?.cursor ?? null);

          for (const pool of pools) {
            // For pools, we try to find non-native reserves
            const nonNativeReserve = pool.reserves.find((r) => r.asset !== "native");
            if (!nonNativeReserve) continue;

            const assetParts = nonNativeReserve.asset.split(":");
            if (assetParts.length < 2) continue;

            const code = assetParts[0];
            const issuer = assetParts[1];
            const assetKey = canonicalClassicAssetKey(code, issuer);

            const identity = buildStellarCanonicalIdentity(chainId, assetKey, code);

            if (dedup.checkAndMark(identity.canonicalKey)) continue;

            const market = buildMarketDataFromPool(pool);
            const evidence = buildEvidenceFromPool(pool, networkId, Math.round(performance.now() - poolStartedAt));
            const observedAt = new Date().toISOString();

            observations.push({
              id: "",
              identity,
              observedBy: PROVIDER_KIND,
              observedAt,
              market,
              evidence,
            });
          }
        }

        // Update cursor
        const newCursor = updateCursorSuccess(PROVIDER_KIND, chainId, assetCursor);

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
          error: error instanceof Error ? error.message : "Stellar poll failed",
          elapsedMs: Math.round(performance.now() - startedAt),
        };
      }
    },
  };
}
