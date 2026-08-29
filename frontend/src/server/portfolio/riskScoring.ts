import type { PortfolioSnapshot, TokenHolding, TokenSignal } from "../types";
import { clampScore, scoreToRiskLevel, weightedScore } from "@/server/agents/shared";
import { getKnownTokenClass, isEstablishedLargeCap, isKnownHighVolatilitySymbol, isVerifiedStablecoin } from "@/server/portfolio/tokenRegistry";

const weights: Record<keyof TokenSignal, number> = {
  scamRisk: 0.16,
  websiteTrustRisk: 0.09,
  contractRisk: 0.13,
  whaleSellRisk: 0.13,
  liquidityRisk: 0.12,
  xSentimentRisk: 0.09,
  holderConcentrationRisk: 0.11,
  priceVolatilityRisk: 0.07,
  portfolioExposureRisk: 0.1,
};

export function scoreTokenRisk(signals: TokenSignal): number {
  const weightedScore = Object.entries(weights).reduce((score, [key, weight]) => {
    return score + signals[key as keyof TokenSignal] * weight;
  }, 0);

  return clampScore(weightedScore);
}

export function getRiskLevel(score: number): TokenHolding["riskLevel"] {
  return scoreToRiskLevel(score);
}

export type PortfolioRiskSignals = {
  concentrationRisk: number;
  assetQualityRisk: number;
  liquidityExitRisk: number;
  stableReserveRisk: number;
  volatilityRisk: number;
  correlationRisk: number;
  chainExecutionRisk: number;
  weightedHoldingRisk: number;
  coreAssetExposurePercent: number;
  largestHoldingPercent: number;
  top3HoldingPercent: number;
  top5HoldingPercent: number;
  stableReservePercent: number;
  unverifiedExposurePercent: number;
  highRiskClassExposurePercent: number;
  unknownPriceExposurePercent: number;
  lowLiquidityExposurePercent: number;
  highVolatilityExposurePercent: number;
  dominantThemePercent: number;
  dominantChainPercent: number;
  hasNativeGasToken: boolean;
  highRiskExposurePercent: number;
  criticalExposurePercent: number;
};

function sumAllocation(holdings: TokenHolding[]) {
  return holdings.reduce((total, holding) => total + holding.allocationPercent, 0);
}

export function getPortfolioRiskSignals(holdings: TokenHolding[]): PortfolioRiskSignals {
  const sortedByAllocation = [...holdings].sort((left, right) => right.allocationPercent - left.allocationPercent);
  const largestHoldingPercent = sortedByAllocation[0]?.allocationPercent ?? 0;
  const top3HoldingPercent = sumAllocation(sortedByAllocation.slice(0, 3));
  const top5HoldingPercent = sumAllocation(sortedByAllocation.slice(0, 5));
  const stableReservePercent = sumAllocation(holdings.filter((holding) => isVerifiedStablecoinHolding(holding)));
  const weightedHoldingRisk = getWeightedHoldingRisk(holdings);
  const coreAssetExposurePercent = sumAllocation(holdings.filter((holding) => isCoreAssetHolding(holding)));
  const unverifiedExposurePercent = sumAllocation(holdings.filter((holding) => !holding.isVerified));
  const highRiskClassExposurePercent = sumAllocation(holdings.filter((holding) => isHighRiskClassHolding(holding)));
  const unknownPriceExposurePercent = sumAllocation(holdings.filter((holding) => holding.priceUsd === null || holding.priceUsd <= 0 || holding.valueUsd <= 0));
  const lowLiquidityExposurePercent = sumAllocation(holdings.filter((holding) => holding.signals.liquidityRisk >= 70));
  const highVolatilityExposurePercent = sumAllocation(holdings.filter((holding) => Math.abs(holding.dayChangePercent ?? 0) >= 10));
  const dominantThemePercent = getDominantThemePercent(holdings);
  const dominantChainPercent = getDominantChainPercent(holdings);
  const hasNativeGasToken = holdings.some(
    (holding) =>
      (holding.tokenAddress === "native" ||
        holding.tokenAddress.startsWith("native:")) &&
      holding.balance > 0,
  );
  const highRiskExposurePercent = sumAllocation(holdings.filter((holding) => holding.riskScore >= 50));
  const criticalExposurePercent = sumAllocation(holdings.filter((holding) => holding.riskScore >= 75));

  return {
    concentrationRisk: getQualityAdjustedConcentrationRisk(
      getConcentrationRisk(largestHoldingPercent, top3HoldingPercent, top5HoldingPercent),
      stableReservePercent,
      coreAssetExposurePercent,
    ),
    assetQualityRisk: getAssetQualityRisk(unverifiedExposurePercent, highRiskClassExposurePercent, unknownPriceExposurePercent),
    liquidityExitRisk: getLiquidityExitRisk(lowLiquidityExposurePercent, holdings),
    stableReserveRisk: getStableReserveRisk(stableReservePercent),
    volatilityRisk: getVolatilityRisk(highVolatilityExposurePercent, holdings),
    correlationRisk: getCorrelationRisk(dominantThemePercent, stableReservePercent, coreAssetExposurePercent),
    chainExecutionRisk: getChainExecutionRisk(dominantChainPercent, hasNativeGasToken),
    weightedHoldingRisk,
    coreAssetExposurePercent,
    largestHoldingPercent,
    top3HoldingPercent,
    top5HoldingPercent,
    stableReservePercent,
    unverifiedExposurePercent,
    highRiskClassExposurePercent,
    unknownPriceExposurePercent,
    lowLiquidityExposurePercent,
    highVolatilityExposurePercent,
    dominantThemePercent,
    dominantChainPercent,
    hasNativeGasToken,
    highRiskExposurePercent,
    criticalExposurePercent,
  };
}

export function getConcentrationRisk(largestHoldingPercent: number, top3HoldingPercent: number, top5HoldingPercent: number) {
  if (largestHoldingPercent >= 60) return 92;
  if (largestHoldingPercent >= 40) return 72;
  if (top3HoldingPercent >= 80) return 66;
  if (top5HoldingPercent >= 90) return 54;
  if (largestHoldingPercent >= 25) return 38;

  return 18;
}

export function getStableReserveRisk(stableReservePercent: number) {
  if (stableReservePercent < 5) return 70;
  if (stableReservePercent < 10) return 50;
  if (stableReservePercent < 20) return 32;

  return 16;
}

function getQualityAdjustedConcentrationRisk(concentrationRisk: number, stableReservePercent: number, coreAssetExposurePercent: number) {
  if (stableReservePercent >= 60) {
    return Math.min(concentrationRisk, 24);
  }

  if (stableReservePercent >= 40) {
    return Math.min(concentrationRisk, 42);
  }

  if (coreAssetExposurePercent >= 80) {
    return Math.min(concentrationRisk, 28);
  }

  if (coreAssetExposurePercent >= 60) {
    return Math.min(concentrationRisk, 42);
  }

  return concentrationRisk;
}

export function getAssetQualityRisk(unverifiedExposurePercent: number, highRiskClassExposurePercent: number, unknownPriceExposurePercent: number) {
  return weightedScore([
    { score: exposureToRisk(unverifiedExposurePercent, 15, 35, 60), weight: 0.42 },
    { score: exposureToRisk(highRiskClassExposurePercent, 15, 30, 50), weight: 0.38 },
    { score: exposureToRisk(unknownPriceExposurePercent, 10, 25, 45), weight: 0.2 },
  ]);
}

export function getLiquidityExitRisk(lowLiquidityExposurePercent: number, holdings: TokenHolding[]) {
  const allocationWeightedLiquidityRisk = weightedScore(
    holdings.map((holding) => ({
      score: holding.signals.liquidityRisk,
      weight: Math.max(holding.allocationPercent, 1),
    })),
  );

  return weightedScore([
    { score: exposureToRisk(lowLiquidityExposurePercent, 15, 30, 50), weight: 0.58 },
    { score: allocationWeightedLiquidityRisk, weight: 0.42 },
  ]);
}

export function getVolatilityRisk(highVolatilityExposurePercent: number, holdings: TokenHolding[]) {
  const allocationWeightedVolatility = weightedScore(
    holdings.map((holding) => ({
      score: Math.min(100, Math.abs(holding.dayChangePercent ?? 0) * 4),
      weight: Math.max(holding.allocationPercent, 1),
    })),
  );

  return weightedScore([
    { score: exposureToRisk(highVolatilityExposurePercent, 15, 30, 50), weight: 0.55 },
    { score: allocationWeightedVolatility, weight: 0.45 },
  ]);
}

export function getCorrelationRisk(dominantThemePercent: number, stableReservePercent: number, coreAssetExposurePercent = 0) {
  if (stableReservePercent >= 60) {
    return 12;
  }

  const dominantThemeRisk = exposureToRisk(dominantThemePercent, 50, 70, 85);
  const noStablePenalty = stableReservePercent < 15 ? 18 : stableReservePercent < 30 ? 8 : 0;

  const rawRisk = clampScore(dominantThemeRisk + noStablePenalty);

  if (coreAssetExposurePercent >= 80) return Math.min(rawRisk, 24);
  if (coreAssetExposurePercent >= 60) return Math.min(rawRisk, 42);

  return rawRisk;
}

export function getChainExecutionRisk(dominantChainPercent: number, hasNativeGasToken: boolean) {
  const concentrationRisk = dominantChainPercent >= 90 ? 24 : dominantChainPercent >= 70 ? 18 : 12;
  const gasPenalty = hasNativeGasToken ? 0 : 28;

  return clampScore(concentrationRisk + gasPenalty);
}

function isVerifiedStablecoinHolding(holding: TokenHolding) {
  return isVerifiedStablecoin(holding.symbol, holding.chainId ?? holding.chainName, holding.tokenAddress);
}

function isCoreAssetHolding(holding: TokenHolding) {
  if (isVerifiedStablecoinHolding(holding)) return true;

  if (holding.isVerified !== true || getKnownTokenClass(holding.symbol) === "meme") return false;

  return isEstablishedLargeCap(holding.symbol) || ["WETH", "WBTC"].includes(holding.symbol.toUpperCase());
}

function isHighRiskClassHolding(holding: TokenHolding) {
  const tokenClass = getKnownTokenClass(holding.symbol);

  return tokenClass === "meme" || isKnownHighVolatilitySymbol(holding.symbol) || holding.riskScore >= 50;
}

function exposureToRisk(percent: number, mediumAt: number, highAt: number, criticalAt: number) {
  if (percent >= criticalAt) return 90;
  if (percent >= highAt) return 72;
  if (percent >= mediumAt) return 42;
  return 16;
}

function getHoldingTheme(holding: TokenHolding) {
  const symbol = holding.symbol.toUpperCase();
  const tokenClass = getKnownTokenClass(symbol);

  if (tokenClass === "stablecoin") return "stable";
  if (tokenClass === "meme" || isKnownHighVolatilitySymbol(symbol) || symbol.includes("MEME")) return "meme";
  if (symbol.includes("AI")) return "ai";
  if ((holding.chainName ?? holding.chainId ?? "").toLowerCase().includes("base")) return "l2";
  if (["ETH", "WETH", "BTC", "WBTC", "BNB", "SOL", "GOAT"].includes(symbol)) return "blue_chip";

  return "unknown";
}

function getDominantThemePercent(holdings: TokenHolding[]) {
  const themes = holdings.reduce<Record<string, number>>((total, holding) => {
    const theme = getHoldingTheme(holding);
    total[theme] = (total[theme] ?? 0) + holding.allocationPercent;

    return total;
  }, {});

  return Math.max(0, ...Object.values(themes));
}

function getDominantChainPercent(holdings: TokenHolding[]) {
  const chains = holdings.reduce<Record<string, number>>((total, holding) => {
    const chain = (holding.chainId ?? holding.chainName ?? "unknown").toLowerCase();
    total[chain] = (total[chain] ?? 0) + holding.allocationPercent;

    return total;
  }, {});

  return Math.max(0, ...Object.values(chains));
}

function getWeightedHoldingRisk(holdings: TokenHolding[]): number {
  const total = holdings.reduce((sum, holding) => sum + holding.valueUsd, 0);

  if (total <= 0) {
    return 0;
  }

  const weightedRisk = holdings.reduce((sum, holding) => {
    return sum + holding.riskScore * (holding.valueUsd / total);
  }, 0);

  return clampScore(weightedRisk);
}

export function scorePortfolioRisk(holdings: TokenHolding[]): number {
  if (holdings.length === 0) {
    return 0;
  }

  const signals = getPortfolioRiskSignals(holdings);
  const formulaScore = weightedScore([
    { score: signals.concentrationRisk, weight: 0.3 },
    { score: signals.assetQualityRisk, weight: 0.2 },
    { score: signals.liquidityExitRisk, weight: 0.15 },
    { score: signals.stableReserveRisk, weight: 0.1 },
    { score: signals.volatilityRisk, weight: 0.1 },
    { score: signals.correlationRisk, weight: 0.1 },
    { score: signals.chainExecutionRisk, weight: 0.05 },
  ]);

  if (signals.largestHoldingPercent >= 60 && signals.criticalExposurePercent >= 60) {
    return Math.max(formulaScore, 75);
  }

  if (signals.stableReservePercent < 5 && signals.highRiskExposurePercent >= 70) {
    return Math.max(formulaScore, 70);
  }

  return formulaScore;
}

export function summarizePortfolioRisk(portfolio: PortfolioSnapshot): string {
  const riskiest = [...portfolio.holdings].sort((a, b) => b.riskScore - a.riskScore)[0];

  if (!riskiest) {
    return "No holdings detected for this wallet.";
  }

  return `${riskiest.symbol} is the main portfolio risk driver at ${riskiest.allocationPercent}% exposure with a ${riskiest.riskScore}/100 token risk score.`;
}
