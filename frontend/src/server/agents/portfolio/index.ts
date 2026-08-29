import type { AgentResult, AgentSource, PortfolioSnapshot } from "@/server/types";
import { getPortfolioProviderHealth, getPortfolioSnapshot, type PortfolioSnapshotSource } from "@/server/portfolio/getPortfolio";
import { buildAgentResult } from "@/server/agents/shared";
import { getPortfolioRiskSignals } from "@/server/portfolio/riskScoring";
import { getPortfolioHardeningReport } from "@/server/portfolio/hardening";
import { getKnownTokenClass, isVerifiedStablecoin } from "@/server/portfolio/tokenRegistry";

function getProviderSources(): AgentSource[] {
  const health = getPortfolioProviderHealth();
  const checkedAt = new Date().toISOString();

  return [
    {
      label: "GoldRush/Covalent",
      status: health.goldRush.configured ? "connected" : "unavailable",
      detail: health.goldRush.detail,
      checkedAt,
      reliability: health.goldRush.configured ? 0.82 : 0.1,
    },
    {
      label: "Alchemy",
      status: health.alchemy.configured ? "connected" : "unavailable",
      detail: health.alchemy.detail,
      checkedAt,
      reliability: health.alchemy.configured ? 0.74 : 0.1,
    },
    {
      label: "GOAT RPC",
      status: health.goatRpc.configured ? "connected" : "unavailable",
      detail: health.goatRpc.detail,
      checkedAt,
      reliability: health.goatRpc.configured ? 0.7 : 0.1,
    },
  ];
}

function severityFromScore(score: number) {
  if (score >= 75) return "critical";
  if (score >= 50) return "high";
  if (score >= 25) return "medium";
  return "low";
}

function getRecommendedAction(portfolio: PortfolioSnapshot, riskSignals: ReturnType<typeof getPortfolioRiskSignals>) {
  if (riskSignals.stableReservePercent < 5 && riskSignals.highRiskExposurePercent >= 70) {
    return "manual_review";
  }

  if (portfolio.riskScore >= 75) {
    return "swap_to_stable";
  }

  if (portfolio.riskScore >= 50) {
    return "reduce_exposure";
  }

  return "watch";
}

type PortfolioTargetToken = {
  discovery?: import("@/server/types").DiscoveryAgentContext;
  contractAddress?: string;
  symbol?: string;
};

function findTargetHolding(portfolio: PortfolioSnapshot, target?: PortfolioTargetToken) {
  const contractAddress = target?.contractAddress?.toLowerCase();
  const symbol = target?.symbol?.toUpperCase();

  if (!contractAddress && !symbol) {
    return undefined;
  }

  if (contractAddress) {
    return portfolio.holdings.find((holding) => holding.tokenAddress.toLowerCase() === contractAddress);
  }

  return portfolio.holdings.find((holding) => Boolean(symbol && holding.symbol.toUpperCase() === symbol));
}

function analyzePortfolioSnapshot(portfolio: PortfolioSnapshot, source: PortfolioSnapshotSource, target?: PortfolioTargetToken): AgentResult {
  const targetHolding = findTargetHolding(portfolio, target);
  const targetExposurePercent = targetHolding?.allocationPercent ?? 0;

  if (portfolio.holdings.length === 0) {
    const emptyState = portfolio.walletAddress === "unconnected" ? "wallet_not_connected" : source.status === "connected" ? "empty_wallet" : "provider_unavailable";

    return buildAgentResult({
      agent: "portfolio",
      score: emptyState === "wallet_not_connected" ? 42 : 58,
      verdict: emptyState === "wallet_not_connected" ? "Wallet not connected" : emptyState === "empty_wallet" ? "Empty wallet" : "Portfolio source unavailable",
      summary:
        emptyState === "wallet_not_connected"
          ? "Wallet is not connected. Portfolio exposure is not included in the final token decision."
          : emptyState === "empty_wallet"
          ? "Portfolio provider connected and returned no holdings. This is treated as an empty wallet, not a provider failure."
          : "Portfolio Agent could not read live wallet holdings. No mock holdings were generated.",
      findings: [
        {
          label: "Portfolio empty state",
          severity: "medium",
          detail: `${emptyState}: ${source.detail}`,
          sourceLabel: "Wallet portfolio API",
          raw: "No holding rows returned from configured portfolio providers.",
          interpretation:
            emptyState === "empty_wallet"
              ? "The wallet appears empty from connected data."
              : "Connect a supported wallet or configure a live portfolio provider before making allocation decisions.",
        },
      ],
      sources: [
        {
          label: "Wallet portfolio API",
          status: "unavailable",
          detail: `${source.detail} Snapshot for ${portfolio.walletAddress}.`,
        },
        ...getProviderSources(),
      ],
      confidence: 0.18,
      recommendedAction: "manual_review",
      rawSignals: {
        emptyState,
        liveModeUsesMockData: false,
        targetTokenExposurePercent: 0,
        targetToken: target,
      },
    });
  }

  const largestHolding = portfolio.holdings.reduce((largest, holding) =>
    holding.allocationPercent > largest.allocationPercent ? holding : largest
  );
  const riskSignals = getPortfolioRiskSignals(portfolio.holdings);
  const hardening = getPortfolioHardeningReport(portfolio, riskSignals, source.status);
  const stablecoinRatio = portfolio.holdings
    .filter((holding) => isVerifiedStablecoin(holding.symbol, holding.chainId ?? holding.chainName, holding.tokenAddress))
    .reduce((total, holding) => total + holding.allocationPercent, 0);
  const memeExposure = portfolio.holdings
    .filter((holding) => getKnownTokenClass(holding.symbol) === "meme" || holding.symbol.toUpperCase().includes("MEME"))
    .reduce((total, holding) => total + holding.allocationPercent, 0);
  const unknownExposure = portfolio.holdings
    .filter((holding) => !holding.isVerified)
    .reduce((total, holding) => total + holding.allocationPercent, 0);
  const volatileExposure = portfolio.holdings
    .filter((holding) => Math.abs(holding.dayChangePercent ?? 0) >= 10)
    .reduce((total, holding) => total + holding.allocationPercent, 0);
  const lowLiquidityExposure = portfolio.holdings
    .filter((holding) => holding.signals.liquidityRisk >= 70)
    .reduce((total, holding) => total + holding.allocationPercent, 0);
  const topRiskHoldings = [...portfolio.holdings]
    .sort((left, right) => {
      const riskGap = right.riskScore - left.riskScore;

      return riskGap !== 0 ? riskGap : right.allocationPercent - left.allocationPercent;
    })
    .slice(0, 5)
    .map((holding) => ({
      symbol: holding.symbol,
      name: holding.name,
      riskScore: holding.riskScore,
      allocationPercent: holding.allocationPercent,
      valueUsd: holding.valueUsd,
      chain: holding.chainName ?? holding.chainId,
    }));
  const recommendedAction = getRecommendedAction(portfolio, riskSignals);

  return buildAgentResult({
    agent: "portfolio",
    score: portfolio.riskScore,
    verdict: portfolio.riskScore >= 75 ? "Critical portfolio risk" : portfolio.riskScore >= 50 ? "High portfolio risk" : "Portfolio within monitoring range",
    summary: `${target?.symbol ?? "Target token"} exposure is ${targetExposurePercent.toFixed(1)}%. ${largestHolding.symbol} is ${largestHolding.allocationPercent.toFixed(1)}% of the wallet. Verified stable reserve is ${stablecoinRatio.toFixed(1)}%. Low-liquidity exposure is ${lowLiquidityExposure.toFixed(1)}%.`,
    findings: [
      {
        label: "Target token exposure",
        severity: targetExposurePercent >= 40 ? "high" : targetExposurePercent >= 15 ? "medium" : "low",
        scoreImpact: targetExposurePercent >= 40 ? 72 : targetExposurePercent >= 15 ? 42 : 8,
        detail:
          targetHolding
            ? `${targetHolding.symbol} is ${targetExposurePercent.toFixed(1)}% of the wallet, worth $${targetHolding.valueUsd.toFixed(2)}.`
            : "Target token was not found in connected wallet holdings.",
        raw: JSON.stringify({
          targetToken: target,
          targetExposurePercent,
          valueUsd: targetHolding?.valueUsd,
          holdingSymbol: targetHolding?.symbol,
        }),
        interpretation: targetExposurePercent > 0 ? "Existing exposure can harden the final decision even when token-level risk is moderate." : "No existing target exposure was found in the connected wallet.",
      },
      {
        label: "Dust and spam filter",
        severity: hardening.dustFilter.spamHoldingCount > 0 ? "medium" : "low",
        scoreImpact: Math.min(60, hardening.dustFilter.spamHoldingCount * 12),
        detail: `${hardening.dustFilter.spamHoldingCount} spam-like holding${hardening.dustFilter.spamHoldingCount === 1 ? "" : "s"} detected; $${hardening.dustFilter.ignoredDustValueUsd.toFixed(2)} dust value is tracked separately so it does not inflate portfolio risk.`,
        raw: JSON.stringify(hardening.dustFilter),
        interpretation: "Dust/spam holdings are visible as security context but do not dominate allocation-weighted portfolio risk.",
      },
      {
        label: "Price reliability",
        severity: hardening.priceReliability.some((item) => item.level === "no_price") ? "high" : hardening.priceReliability.some((item) => item.level === "dex_only" || item.level === "stale_or_anomalous") ? "medium" : "low",
        scoreImpact: Math.max(0, ...hardening.priceReliability.map((item) => item.risk)),
        detail: `${hardening.priceReliability.filter((item) => item.level === "verified_market").length} verified market price${hardening.priceReliability.length === 1 ? "" : "s"}, ${hardening.priceReliability.filter((item) => item.level !== "verified_market").length} price reliability warning${hardening.priceReliability.length === 1 ? "" : "s"}.`,
        raw: JSON.stringify(hardening.priceReliability),
        interpretation: "No-price and DEX-only exposure raises uncertainty even when allocation is small.",
      },
      {
        label: "Stablecoin verification",
        severity: hardening.fakeStablecoins.length > 0 ? "high" : "low",
        scoreImpact: hardening.fakeStablecoins.length > 0 ? 72 : 8,
        detail: hardening.fakeStablecoins.length > 0 ? `${hardening.fakeStablecoins.length} symbol-only stablecoin${hardening.fakeStablecoins.length === 1 ? "" : "s"} failed chain/address verification.` : "Stable reserve only counts allowlisted chain-specific stablecoin contracts.",
        raw: JSON.stringify(hardening.fakeStablecoins),
        interpretation: "Fake USDC/USDT names are not counted as stable reserve unless the chain-specific contract is trusted.",
      },
      {
        label: "Native gas readiness",
        severity: hardening.chainReadiness.hasNativeGasToken ? "low" : "medium",
        scoreImpact: riskSignals.chainExecutionRisk,
        detail: hardening.chainReadiness.hasNativeGasToken ? "Native gas token detected for execution readiness." : "No native gas token detected; execution readiness is reduced.",
        raw: JSON.stringify(hardening.chainReadiness),
        interpretation: "Missing gas token can block user-approved exits even when a reduce/swap recommendation is correct.",
      },
      {
        label: "Deterministic risk drivers",
        severity: severityFromScore(Math.max(...hardening.riskDriverBreakdown.map((item) => item.score))),
        scoreImpact: Math.max(...hardening.riskDriverBreakdown.map((item) => item.score)),
        detail: hardening.riskDriverBreakdown.map((item) => `${item.key} ${item.score}/100`).join("; "),
        raw: JSON.stringify(hardening.riskDriverBreakdown),
        interpretation: "Portfolio risk is decomposed into concentration, stable reserve, liquidity exit, asset quality, volatility and chain readiness.",
      },
      {
        label: "Largest holding",
        severity: riskSignals.largestHoldingPercent >= 60 ? "critical" : riskSignals.largestHoldingPercent >= 40 ? "high" : "medium",
        scoreImpact: riskSignals.concentrationRisk,
        detail: `${largestHolding.symbol} represents ${largestHolding.allocationPercent.toFixed(1)}% of the wallet. Top 3 holdings represent ${riskSignals.top3HoldingPercent.toFixed(1)}%.`,
        raw: JSON.stringify({
          largestHoldingPercent: riskSignals.largestHoldingPercent,
          top3HoldingPercent: riskSignals.top3HoldingPercent,
          top5HoldingPercent: riskSignals.top5HoldingPercent,
        }),
        interpretation:
          riskSignals.largestHoldingPercent >= 60
            ? "A single asset above 60% creates critical concentration exposure."
            : riskSignals.largestHoldingPercent >= 40
              ? "A single asset above 40% creates high concentration exposure."
              : "Concentration is within the current monitoring range.",
      },
      {
        label: "Stablecoin reserve",
        severity: stablecoinRatio < 5 ? "critical" : stablecoinRatio < 15 ? "high" : stablecoinRatio < 30 ? "medium" : "low",
        scoreImpact: riskSignals.stableReserveRisk,
        detail: `Verified stablecoin reserve is ${stablecoinRatio.toFixed(1)}% of portfolio value.`,
        raw: JSON.stringify({ stableReservePercent: stablecoinRatio }),
        interpretation:
          stablecoinRatio < 5
            ? "Stable reserve below 5% leaves the wallet highly exposed during drawdowns."
            : stablecoinRatio < 15
              ? "Stable reserve below 15% limits defensive flexibility."
              : "Stable reserve is present and reduces downside exposure.",
      },
      {
        label: "Asset quality",
        severity: severityFromScore(riskSignals.assetQualityRisk),
        scoreImpact: riskSignals.assetQualityRisk,
        detail: `Unverified exposure is ${riskSignals.unverifiedExposurePercent.toFixed(1)}%; high-risk class exposure is ${riskSignals.highRiskClassExposurePercent.toFixed(1)}%; unknown price exposure is ${riskSignals.unknownPriceExposurePercent.toFixed(1)}%.`,
        raw: JSON.stringify({
          unverifiedExposurePercent: riskSignals.unverifiedExposurePercent,
          highRiskClassExposurePercent: riskSignals.highRiskClassExposurePercent,
          unknownPriceExposurePercent: riskSignals.unknownPriceExposurePercent,
        }),
        interpretation: "Unverified, meme/high-volatility and no-price holdings reduce portfolio quality.",
      },
      {
        label: "Liquidity exit risk",
        severity: severityFromScore(riskSignals.liquidityExitRisk),
        scoreImpact: riskSignals.liquidityExitRisk,
        detail: `${lowLiquidityExposure.toFixed(1)}% of holdings carry elevated liquidity risk.`,
        raw: JSON.stringify({ lowLiquidityExposurePercent: riskSignals.lowLiquidityExposurePercent }),
        interpretation: "High allocation to low-liquidity assets can make exits fragile or expensive.",
      },
      {
        label: "Volatility",
        severity: severityFromScore(riskSignals.volatilityRisk),
        scoreImpact: riskSignals.volatilityRisk,
        detail: `${volatileExposure.toFixed(1)}% of the portfolio moved 10% or more in 24h.`,
        raw: JSON.stringify({ highVolatilityExposurePercent: riskSignals.highVolatilityExposurePercent }),
        interpretation: "High-volatility exposure matters more when it is a large allocation.",
      },
      {
        label: "Correlation and chain readiness",
        severity: severityFromScore(Math.max(riskSignals.correlationRisk, riskSignals.chainExecutionRisk)),
        scoreImpact: Math.max(riskSignals.correlationRisk, riskSignals.chainExecutionRisk),
        detail: `Dominant theme exposure is ${riskSignals.dominantThemePercent.toFixed(1)}%; dominant chain exposure is ${riskSignals.dominantChainPercent.toFixed(1)}%; native gas token ${riskSignals.hasNativeGasToken ? "detected" : "not detected"}.`,
        raw: JSON.stringify({
          correlationRisk: riskSignals.correlationRisk,
          chainExecutionRisk: riskSignals.chainExecutionRisk,
          dominantThemePercent: riskSignals.dominantThemePercent,
          dominantChainPercent: riskSignals.dominantChainPercent,
          hasNativeGasToken: riskSignals.hasNativeGasToken,
        }),
        interpretation: "Theme or chain concentration and missing gas token reduce resilience and execution readiness.",
      },
      {
        label: "Top risk holdings",
        severity: topRiskHoldings.some((holding) => holding.riskScore >= 75) ? "critical" : topRiskHoldings.some((holding) => holding.riskScore >= 50) ? "high" : "medium",
        scoreImpact: topRiskHoldings[0]?.riskScore ?? portfolio.riskScore,
        detail: topRiskHoldings
          .map((holding) => `${holding.symbol} ${holding.riskScore}/100 at ${holding.allocationPercent.toFixed(1)}%`)
          .join("; "),
        raw: JSON.stringify(topRiskHoldings),
        interpretation: "These holdings contribute the most token-level risk to the portfolio.",
      },
    ],
    sources: [
      {
        label: "Wallet portfolio API",
        status: source.status,
        detail: `${source.detail} Snapshot for ${portfolio.walletAddress}.`,
      },
      ...getProviderSources(),
    ],
    confidence: source.status === "connected" ? 0.76 : 0.58,
    recommendedAction,
    blockingReasons:
      riskSignals.stableReservePercent < 5 && riskSignals.highRiskExposurePercent >= 70
        ? ["Stable reserve is below 5% while high-risk exposure is at least 70%."]
        : [],
    rawSignals: {
      portfolioRisk: riskSignals,
      hardening,
      targetToken: target,
      targetTokenExposurePercent: targetExposurePercent,
      targetTokenHolding: targetHolding
        ? {
            symbol: targetHolding.symbol,
            tokenAddress: targetHolding.tokenAddress,
            allocationPercent: targetHolding.allocationPercent,
            valueUsd: targetHolding.valueUsd,
            riskScore: targetHolding.riskScore,
          }
        : undefined,
      stablecoinRatio,
      memeExposure,
      unknownExposure,
      volatileExposure,
      lowLiquidityExposure,
      topRiskHoldings,
    },
  });
}

export async function runPortfolioAgent(walletAddress?: string, target?: PortfolioTargetToken): Promise<AgentResult> {
  const { portfolio, source } = await getPortfolioSnapshot(walletAddress);

  return analyzePortfolioSnapshot(portfolio, source, target);
}
