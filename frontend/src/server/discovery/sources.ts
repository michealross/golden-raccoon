import type { DiscoveryCandidate, DiscoverySourceKind } from "@/server/types";
import { scanNetworks, getScanNetwork } from "@/lib/scanNetworks";

const DEXSCREENER_BASE = "https://api.dexscreener.com/latest/dex";
const STELLAR_EXPERT_BASE = "https://stellar.expert/api/explorer/public";

let offlineSnapshotWarned = false;

const offlineFallbackCandidates: DiscoveryCandidate[] = [
  {
    id: "offline-evm-weth-base",
    chain: "base",
    contractAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    symbol: "WETH",
    tokenName: "Wrapped Ether",
    pairAddress: "0x4444444444444444444444444444444444444446",
    pairUrl: "https://dexscreener.com/base/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    source: "dexscreener",
    sourceUrl: "https://dexscreener.com/base/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    discoveredAt: "2026-07-06T12:00:00.000Z",
    metrics: {
      liquidityUsd: 38_000_000,
      volume24hUsd: 6_500_000,
      fdvUsd: 12_500_000_000,
      fdvLiquidityRatio: 320,
      priceChange24hPercent: 1.4,
      pairAgeDays: 1500,
    },
    raw: { provider: "dexscreener", offline: true },
  },
  {
    id: "offline-evm-thin-base",
    chain: "base",
    contractAddress: "0x4444444444444444444444444444444444444444",
    symbol: "THIN",
    tokenName: "Thin Liquidity Token",
    pairAddress: "0x4f44444444444444444444444444444444444444",
    pairUrl: "https://dexscreener.com/base/0x4444444444444444444444444444444444444444",
    source: "dexscreener",
    sourceUrl: "https://dexscreener.com/base/0x4444444444444444444444444444444444444444",
    discoveredAt: "2026-07-06T12:00:00.000Z",
    metrics: {
      liquidityUsd: 12_000,
      volume24hUsd: 3_500,
      fdvUsd: 4_000_000,
      fdvLiquidityRatio: 333,
      priceChange24hPercent: 14.5,
      pairAgeDays: 1,
    },
    raw: { provider: "dexscreener", offline: true },
  },
  {
    id: "offline-stellar-usdc",
    chain: "stellar-public",
    symbol: "USDC",
    tokenName: "USD Coin",
    assetType: "classic",
    issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGW3QHOBBVYGFX6DOMTHYS",
    assetKey: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGW3QHOBBVYGFX6DOMTHYS",
    source: "stellar_market",
    sourceUrl: "https://stellar.expert/explorer/public/asset/USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGW3QHOBBVYGFX6DOMTHYS",
    discoveredAt: "2026-07-06T12:00:00.000Z",
    metrics: {
      liquidityUsd: 250_000_000,
      volume24hUsd: 6_000_000,
      pairAgeDays: 2200,
    },
    raw: { provider: "stellar_expert", offline: true },
  },
];

type DexScreenerTokenResponse = {
  schemaVersion?: string;
  pairs?: Array<{
    chainId?: string;
    dexId?: string;
    url?: string;
    pairAddress?: string;
    baseToken?: { address?: string; name?: string; symbol?: string };
    quoteToken?: { address?: string; symbol?: string };
    priceUsd?: string;
    fdv?: number;
    marketCap?: number;
    liquidity?: { usd?: number };
    volume?: { h24?: number };
    priceChange?: { h24?: number };
    pairCreatedAt?: number;
  }>;
};

type StellarExpertAsset = {
  id?: string;
  code?: string;
  issuer?: string;
  type?: string;
  name?: string;
  amount?: string;
  trades?: number;
  payments?: number;
  domain?: string;
  toml?: { currency?: string };
};

type StellarExpertResponse = {
  _embedded?: {
    records?: StellarExpertAsset[];
  };
};

function pairAgeDays(pairCreatedAt?: number) {
  if (!pairCreatedAt) return undefined;

  return Math.max(0, Math.floor((Date.now() - pairCreatedAt) / 86_400_000));
}

function fdvLiquidityRatio(fdv: number | undefined, liquidityUsd: number | undefined) {
  if (!fdv || !liquidityUsd) return undefined;

  return fdv / liquidityUsd;
}

function normalizeDexScreenerPair(pair: NonNullable<DexScreenerTokenResponse["pairs"]>[number]): DiscoveryCandidate | undefined {
  if (!pair.baseToken?.address || !pair.chainId || !pair.pairAddress) return undefined;

  const network = scanNetworks.find((n) => n.dexScreenerChainId === pair.chainId || n.id === pair.chainId);
  const chainId = network?.id ?? pair.chainId;
  const liquidityUsd = pair.liquidity?.usd ?? 0;
  const fdv = pair.fdv ?? pair.marketCap ?? 0;

  return {
    id: `${chainId}:${pair.baseToken.address.toLowerCase()}:${pair.pairAddress.toLowerCase()}`,
    chain: chainId,
    contractAddress: pair.baseToken.address,
    pairAddress: pair.pairAddress,
    pairUrl: pair.url,
    symbol: pair.baseToken.symbol,
    tokenName: pair.baseToken.name,
    source: "dexscreener",
    sourceUrl: pair.url,
    discoveredAt: new Date().toISOString(),
    metrics: {
      liquidityUsd,
      volume24hUsd: pair.volume?.h24,
      fdvUsd: fdv,
      fdvLiquidityRatio: fdvLiquidityRatio(fdv, liquidityUsd),
      priceChange24hPercent: pair.priceChange?.h24,
      pairAgeDays: pairAgeDays(pair.pairCreatedAt),
    },
    raw: { provider: "dexscreener", dexId: pair.dexId, pairCreatedAt: pair.pairCreatedAt },
  };
}

async function fetchDexScreenerTrendingForChain(networkChainId: string): Promise<DiscoveryCandidate[]> {
  const network = getScanNetwork(networkChainId);

  if (!network || !network.dexScreenerChainId) return [];

  try {
    const url = `${DEXSCREENER_BASE}/tokens/${encodeURIComponent(network.dexScreenerChainId)}/top`;
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(7_000), cache: "no-store" });
    if (!response.ok) return [];

    const payload = (await response.json()) as DexScreenerTokenResponse;
    const pairs = (payload.pairs ?? []).slice(0, 8);

    return pairs
      .map((pair) => normalizeDexScreenerPair(pair))
      .filter((candidate): candidate is DiscoveryCandidate => Boolean(candidate));
  } catch {
    return [];
  }
}

function normalizeStellarExpert(record: StellarExpertAsset): DiscoveryCandidate | undefined {
  if (!record.code || !record.issuer) return undefined;
  if (record.type !== "credit_alphanum4" && record.type !== "credit_alphanum12") return undefined;

  const issuer = record.issuer;
  const code = record.code;
  const assetKey = `${code}:${issuer}`;
  const sourceUrl = `https://stellar.expert/explorer/public/asset/${code}-${issuer}`;

  return {
    id: `stellar-public:${assetKey}`,
    chain: "stellar-public",
    symbol: code,
    tokenName: record.name ?? code,
    assetType: "classic",
    issuer,
    assetKey,
    source: "stellar_market",
    sourceUrl,
    discoveredAt: new Date().toISOString(),
    metrics: {
      volume24hUsd: typeof record.trades === "number" ? record.trades : undefined,
      pairAgeDays: 0,
    },
    raw: { provider: "stellar_expert", record },
  };
}

async function fetchStellarExpertTop(): Promise<DiscoveryCandidate[]> {
  try {
    const url = `${STELLAR_EXPERT_BASE}/asset?limit=8&order=desc&sort_by=trades`;
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(7_000), cache: "no-store" });
    if (!response.ok) return [];

    const payload = (await response.json()) as StellarExpertResponse;
    const records = payload._embedded?.records ?? [];

    return records
      .map((record) => normalizeStellarExpert(record))
      .filter((candidate): candidate is DiscoveryCandidate => Boolean(candidate));
  } catch {
    return [];
  }
}

export async function fetchLiveDiscoveryCandidates(chain?: string): Promise<{ candidates: DiscoveryCandidate[]; source: "live" | "offline" }> {
  const wantsStellar = !chain || chain === "stellar-public";
  const wantsEvm = !chain || chain !== "stellar-public";

  const [evmChains, stellarRecords] = await Promise.all([
    wantsEvm
      ? Promise.all(
          scanNetworks
            .filter((n) => Boolean(n.dexScreenerChainId) && n.chainFamily !== undefined)
            .slice(0, 4)
            .map(async (network) => ({ chain: network.id, candidates: await fetchDexScreenerTrendingForChain(network.id) })),
        ).then((results) => results.flatMap((entry) => entry.candidates))
      : Promise.resolve([] as DiscoveryCandidate[]),
    wantsStellar ? fetchStellarExpertTop() : Promise.resolve([] as DiscoveryCandidate[]),
  ]);

  const live = [...evmChains, ...stellarRecords];

  if (live.length > 0) {
    if (chain) {
      return { candidates: live.filter((candidate) => candidate.chain === chain), source: "live" };
    }

    return { candidates: live, source: "live" };
  }

  if (!offlineSnapshotWarned) {
    offlineSnapshotWarned = true;

    if (process.env.NODE_ENV !== "production") {
      console.warn("[discovery] Live sources unavailable; serving offline candidate snapshot.");
    }
  }

  const fallback = chain ? offlineFallbackCandidates.filter((candidate) => candidate.chain === chain) : offlineFallbackCandidates;

  return { candidates: fallback, source: "offline" };
}

export function isOfflineSnapshot(candidate: DiscoveryCandidate) {
  return Boolean(candidate.raw && (candidate.raw as Record<string, unknown>).offline === true);
}