import type { PortfolioSnapshot, TokenHolding } from "@/server/types";
import { getKnownTokenClass, isVerifiedStablecoin } from "@/server/portfolio/tokenRegistry";
import type { PortfolioRiskSignals } from "@/server/portfolio/riskScoring";

export type PortfolioEmptyState = "empty_wallet" | "provider_unavailable" | "unsupported_chain" | "has_holdings";

function isDustHolding(holding: TokenHolding) {
  return holding.valueUsd > 0 && holding.valueUsd < 1 && holding.allocationPercent < 0.2;
}

function isSpamLikeHolding(holding: TokenHolding) {
  const symbol = holding.symbol.toUpperCase();
  const name = holding.name.toLowerCase();

  return (
    !holding.isVerified &&
    (isDustHolding(holding) || symbol.includes("AIRDROP") || symbol.includes("CLAIM") || name.includes("airdrop") || name.includes("claim"))
  );
}

export function getPortfolioEmptyState(portfolio: PortfolioSnapshot, sourceStatus: "connected" | "unavailable"): PortfolioEmptyState {
  if (portfolio.holdings.length > 0) return "has_holdings";
  if (sourceStatus === "unavailable") return "provider_unavailable";
  if (portfolio.nativeSymbol === "UNSUPPORTED") return "unsupported_chain";

  return "empty_wallet";
}

export function getPriceReliability(holding: TokenHolding) {
  if (holding.priceUsd === null || holding.priceUsd <= 0 || holding.valueUsd <= 0) {
    return {
      level: "no_price" as const,
      risk: 82,
      detail: "No usable USD price is available.",
    };
  }

  if (!holding.isVerified) {
    return {
      level: "dex_only" as const,
      risk: 48,
      detail: "Price is available but token is not verified.",
    };
  }

  if (Math.abs(holding.dayChangePercent ?? 0) >= 40) {
    return {
      level: "stale_or_anomalous" as const,
      risk: 62,
      detail: "Price move is large enough to require freshness review.",
    };
  }

  return {
    level: "verified_market" as const,
    risk: 12,
    detail: "Verified token with usable market price.",
  };
}

export function getPortfolioHardeningReport(portfolio: PortfolioSnapshot, riskSignals: PortfolioRiskSignals, sourceStatus: "connected" | "unavailable") {
  const spamHoldings = portfolio.holdings.filter(isSpamLikeHolding);
  const dustHoldings = portfolio.holdings.filter(isDustHolding);
  const fakeStablecoins = portfolio.holdings.filter((holding) => {
    const symbol = holding.symbol.toUpperCase();

    return ["USDC", "USDT", "DAI"].includes(symbol) && !isVerifiedStablecoin(holding.symbol, holding.chainId ?? holding.chainName, holding.tokenAddress);
  });
  const priceReliability = portfolio.holdings.map((holding) => ({
    symbol: holding.symbol,
    tokenAddress: holding.tokenAddress,
    allocationPercent: holding.allocationPercent,
    ...getPriceReliability(holding),
  }));
  const chainReadiness = {
    hasNativeGasToken: riskSignals.hasNativeGasToken,
    dominantChainPercent: riskSignals.dominantChainPercent,
    executionReadiness: riskSignals.hasNativeGasToken ? "ready" : "gas_missing",
  };
  const riskDriverBreakdown = [
    { key: "concentration", score: riskSignals.concentrationRisk },
    { key: "stable_reserve", score: riskSignals.stableReserveRisk },
    { key: "liquidity_exit", score: riskSignals.liquidityExitRisk },
    { key: "asset_quality", score: riskSignals.assetQualityRisk },
    { key: "volatility", score: riskSignals.volatilityRisk },
    { key: "chain_readiness", score: riskSignals.chainExecutionRisk },
  ];

  return {
    emptyState: getPortfolioEmptyState(portfolio, sourceStatus),
    dustFilter: {
      ignoredDustValueUsd: dustHoldings.reduce((total, holding) => total + holding.valueUsd, 0),
      spamHoldingCount: spamHoldings.length,
      spamHoldings: spamHoldings.slice(0, 10).map((holding) => ({
        symbol: holding.symbol,
        name: holding.name,
        valueUsd: holding.valueUsd,
        tokenAddress: holding.tokenAddress,
      })),
    },
    priceReliability,
    fakeStablecoins: fakeStablecoins.map((holding) => ({
      symbol: holding.symbol,
      tokenAddress: holding.tokenAddress,
      chain: holding.chainId ?? holding.chainName,
    })),
    chainReadiness,
    riskDriverBreakdown,
    highRiskClasses: portfolio.holdings
      .filter((holding) => getKnownTokenClass(holding.symbol) === "meme" || holding.riskScore >= 50)
      .map((holding) => ({ symbol: holding.symbol, riskScore: holding.riskScore, allocationPercent: holding.allocationPercent })),
  };
}
