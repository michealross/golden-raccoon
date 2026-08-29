import type { AgentInputIdentity, ResolvedTokenIdentity } from "@/server/types";
import { buildTokenIdentityGraph } from "@/server/identity/identityGraph";

const evmAddressPattern = /^0x[a-fA-F0-9]{40}$/;
const genericSymbols = new Set(["AI", "GOAT", "MOON", "PEPE", "MEME", "DOGE", "CAT", "BTC", "ETH"]);

function normalizeUrl(value?: string) {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return value.trim().toLowerCase();
  }
}

function normalizeChain(value?: string) {
  return value?.trim().toLowerCase();
}

function normalizeAddress(value?: string) {
  return evmAddressPattern.test(value ?? "") ? value?.toLowerCase() : undefined;
}

function getConfidenceLabel(confidence: number): ResolvedTokenIdentity["confidenceLabel"] {
  if (confidence >= 0.72) return "high";
  if (confidence >= 0.42) return "medium";
  return "low";
}

export function resolveTokenIdentity(input: AgentInputIdentity): ResolvedTokenIdentity {
  const contractAddress = normalizeAddress(input.contractAddress);
  const chain = normalizeChain(input.chain);
  const symbol = input.symbol?.trim().toUpperCase();
  const tokenName = input.tokenName?.trim();
  const websiteUrl = normalizeUrl(input.websiteUrl);
  const twitterUrl = normalizeUrl(input.twitterUrl);
  const telegramUrl = normalizeUrl(input.telegramUrl);
  const discordUrl = normalizeUrl(input.discordUrl);
  const identityGraph = buildTokenIdentityGraph({ ...input, websiteUrl, twitterUrl, telegramUrl, discordUrl });
  const matchReasons: string[] = [];
  const warnings: string[] = [];
  let confidence = 0;

  if (contractAddress) {
    confidence += 0.38;
    matchReasons.push("contract address");
  } else if (input.contractAddress) {
    warnings.push("contract address is not a valid EVM address");
  }

  if (chain) {
    confidence += 0.14;
    matchReasons.push("chain");
  }

  if (websiteUrl) {
    confidence += 0.14;
    matchReasons.push("website");
  }

  if (twitterUrl || telegramUrl || discordUrl) {
    confidence += 0.12;
    matchReasons.push("official social link");
  }

  if (input.coingeckoId) {
    confidence += 0.12;
    matchReasons.push("CoinGecko id");
  }

  if (input.dexScreenerPairUrl) {
    confidence += 0.08;
    matchReasons.push("DexScreener pair");
  }

  if (input.coinmarketcapId) {
    confidence += 0.1;
    matchReasons.push("CoinMarketCap id");
  }

  if (input.pairAddress) {
    confidence += 0.08;
    matchReasons.push("pair address");
  }

  if (symbol && tokenName) {
    confidence += 0.1;
    matchReasons.push("symbol and token name");
  } else if (symbol) {
    confidence += 0.04;
    matchReasons.push("symbol only");
  }

  if (symbol && genericSymbols.has(symbol) && !contractAddress) {
    confidence -= 0.18;
    warnings.push("generic or collision-prone symbol without contract address");
  }

  if (identityGraph.collision.risk === "high") {
    confidence -= 0.12;
    warnings.push(identityGraph.collision.detail);
  }

  if (identityGraph.officialLinks.conflicts.length > 0) {
    confidence -= 0.16;
    warnings.push(...identityGraph.officialLinks.conflicts);
  } else {
    confidence += identityGraph.officialLinks.confidenceBoost;
  }

  if (!contractAddress && !websiteUrl && !input.coingeckoId && !input.dexScreenerPairUrl) {
    warnings.push("identity depends on weak token labels");
  }

  const boundedConfidence = Math.min(0.96, Math.max(0.08, confidence));
  const identityKey =
    contractAddress && chain
      ? `${chain}:${contractAddress}`
      : contractAddress
        ? contractAddress
        : input.assetKey && chain
          ? `${chain}:${input.assetKey}`
          : [symbol, tokenName, websiteUrl, input.coingeckoId].filter(Boolean).join(":").toLowerCase() || "unknown-token";

  return {
    ...input,
    chain,
    contractAddress,
    symbol,
    tokenName,
    websiteUrl,
    twitterUrl,
    telegramUrl,
    discordUrl,
    identityKey,
    confidence: boundedConfidence,
    confidenceLabel: getConfidenceLabel(boundedConfidence),
    matchReasons,
    warnings,
    identityGraph: {
      nodes: identityGraph.nodes,
      edges: identityGraph.edges,
    },
    symbolCollision: identityGraph.collision,
    officialLinkVerification: identityGraph.officialLinks,
  };
}
