import type {
  PortfolioSnapshot,
  StellarPortfolioActivity,
  TokenHolding,
  TokenSignal,
} from "@/server/types";
import {
  getRiskLevel,
  scorePortfolioRisk,
  scoreTokenRisk,
} from "@/server/portfolio/riskScoring";

export type StellarAccountReserveInput = {
  subentryCount: number;
  numSponsoring?: number;
  numSponsored?: number;
};

export type StellarPortfolioHoldingInput = {
  assetKind: "native" | "classic" | "sac" | "sep41";
  assetKey: string;
  symbol: string;
  name: string;
  balance: string;
  issuer?: string;
  contractId?: string;
  buyingLiabilities?: string;
  sellingLiabilities?: string;
  authorized?: boolean;
  authorizationRequired?: boolean;
  revocable?: boolean;
  clawbackEnabled?: boolean;
  riskDataComplete?: boolean;
  verified: boolean;
  priceUsd: number | null;
  priceSource?: string;
};

export type StellarPortfolioModelInput = {
  walletAddress: string;
  networkId: string;
  networkName: string;
  baseReserveStroops: number;
  account: StellarAccountReserveInput;
  holdings: StellarPortfolioHoldingInput[];
  recentActivity?: StellarPortfolioActivity[];
  xlmDayChangePercent?: number;
  providerLatencyMs: number;
  dataWarnings?: string[];
};

function finiteNumber(value: string | number | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clampRisk(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function calculateMinimumReserveXlm(
  account: StellarAccountReserveInput,
  baseReserveStroops: number,
) {
  const reserveEntries = Math.max(
    0,
    2 +
      Math.max(0, account.subentryCount) +
      Math.max(0, account.numSponsoring ?? 0) -
      Math.max(0, account.numSponsored ?? 0),
  );

  return (Math.max(0, baseReserveStroops) / 10_000_000) * reserveEntries;
}

export function calculateSpendableXlm(input: {
  balance: string | number;
  minimumReserveXlm: number;
  sellingLiabilities?: string | number;
}) {
  return Math.max(
    0,
    finiteNumber(input.balance) -
      Math.max(0, input.minimumReserveXlm) -
      Math.max(0, finiteNumber(input.sellingLiabilities)),
  );
}

function signalsForHolding(input: {
  allocationPercent: number;
  authorized: boolean;
  authorizationRequired: boolean;
  revocable: boolean;
  clawbackEnabled: boolean;
  verified: boolean;
  priced: boolean;
  reserveReady: boolean;
  riskDataComplete: boolean;
}): TokenSignal {
  const issuerControlRisk =
    (input.authorizationRequired ? 12 : 0) +
    (input.revocable ? 24 : 0) +
    (input.clawbackEnabled ? 34 : 0);

  return {
    scamRisk: input.verified ? 8 : 42,
    websiteTrustRisk: input.verified ? 10 : 38,
    contractRisk: clampRisk(
      (input.authorized ? 12 : 72) +
        issuerControlRisk +
        (input.riskDataComplete ? 0 : 28),
    ),
    whaleSellRisk: 30,
    liquidityRisk: input.priced
      ? input.reserveReady
        ? input.riskDataComplete
          ? 18
          : 34
        : 38
      : 72,
    xSentimentRisk: 25,
    holderConcentrationRisk: clampRisk(input.allocationPercent),
    priceVolatilityRisk: input.priced ? 18 : 58,
    portfolioExposureRisk: clampRisk(input.allocationPercent),
  };
}

export function dedupeStellarHoldings(
  holdings: StellarPortfolioHoldingInput[],
) {
  const byIdentity = new Map<string, StellarPortfolioHoldingInput>();

  for (const holding of holdings) {
    const identity = holding.contractId
      ? `contract:${holding.contractId.toUpperCase()}`
      : holding.assetKey.toUpperCase();
    const existing = byIdentity.get(identity);

    if (!existing) {
      byIdentity.set(identity, holding);
      continue;
    }

    const classic =
      existing.assetKind === "classic"
        ? existing
        : holding.assetKind === "classic"
          ? holding
          : null;
    const sac =
      existing.assetKind === "sac"
        ? existing
        : holding.assetKind === "sac"
          ? holding
          : null;

    if (classic && sac) {
      byIdentity.set(identity, {
        ...classic,
        assetKind: "sac",
        name: sac.name || classic.name,
        verified: classic.verified || sac.verified,
        priceUsd: sac.priceUsd ?? classic.priceUsd,
        priceSource: sac.priceSource ?? classic.priceSource,
        riskDataComplete:
          classic.riskDataComplete !== false &&
          sac.riskDataComplete !== false,
      });
    }
  }

  return [...byIdentity.values()];
}

export function buildStellarPortfolioSnapshot(
  input: StellarPortfolioModelInput,
): PortfolioSnapshot {
  const minimumReserveXlm = calculateMinimumReserveXlm(
    input.account,
    input.baseReserveStroops,
  );
  const nativeInput = input.holdings.find(
    (holding) => holding.assetKind === "native",
  );
  const nativeBalance = finiteNumber(nativeInput?.balance);
  const nativeSellingLiabilities = finiteNumber(
    nativeInput?.sellingLiabilities,
  );
  const spendableNativeBalance = calculateSpendableXlm({
    balance: nativeBalance,
    minimumReserveXlm,
    sellingLiabilities: nativeSellingLiabilities,
  });
  const reserveReady =
    nativeBalance >= minimumReserveXlm + nativeSellingLiabilities;

  const preliminary = dedupeStellarHoldings(input.holdings).map((holding) => {
    const balance = Math.max(0, finiteNumber(holding.balance));
    const priced =
      holding.priceUsd !== null &&
      Number.isFinite(holding.priceUsd) &&
      holding.priceUsd > 0;
    const valueUsd = priced ? balance * holding.priceUsd! : 0;

    return {
      holding,
      balance,
      valueUsd,
      priced,
    };
  });
  const totalValueUsd = preliminary.reduce(
    (total, entry) => total + entry.valueUsd,
    0,
  );
  const holdings = preliminary
    .map(({ holding, balance, valueUsd, priced }): TokenHolding => {
      const allocationPercent =
        totalValueUsd > 0 ? (valueUsd / totalValueUsd) * 100 : 0;
      const authorized = holding.authorized !== false;
      const authorizationRequired = holding.authorizationRequired === true;
      const revocable = holding.revocable === true;
      const clawbackEnabled = holding.clawbackEnabled === true;
      const riskDataComplete = holding.riskDataComplete !== false;
      const signals = signalsForHolding({
        allocationPercent,
        authorized,
        authorizationRequired,
        revocable,
        clawbackEnabled,
        verified: holding.verified,
        priced,
        reserveReady,
        riskDataComplete,
      });
      const riskScore = scoreTokenRisk(signals);

      return {
        tokenAddress: holding.assetKey,
        symbol: holding.symbol,
        name: holding.name,
        assetKind: holding.assetKind,
        issuer: holding.issuer,
        contractId: holding.contractId,
        chainId: input.networkId,
        chainName: input.networkName,
        isVerified: holding.verified,
        balance,
        priceUsd: priced ? holding.priceUsd : null,
        priceStatus: priced ? "priced" : "unavailable",
        priceSource: holding.priceSource,
        valueUsd,
        allocationPercent,
        riskScore,
        riskLevel: getRiskLevel(riskScore),
        signals,
        stellarRisk: {
          authorized,
          authorizationRequired,
          revocable,
          clawbackEnabled,
          liquidity: priced ? "known" : "unknown",
          dataStatus: riskDataComplete ? "complete" : "partial",
        },
      };
    })
    .sort(
      (left, right) =>
        right.valueUsd - left.valueUsd || right.balance - left.balance,
    );
  const unpricedAssetCount = holdings.filter(
    (holding) =>
      holding.balance > 0 && holding.priceStatus === "unavailable",
  ).length;
  const hasUnauthorizedTrustline = holdings.some(
    (holding) => holding.stellarRisk?.authorized === false,
  );
  const hasControlledTrustline = holdings.some(
    (holding) =>
      holding.stellarRisk?.revocable ||
      holding.stellarRisk?.clawbackEnabled,
  );
  const hasPartialRiskData = holdings.some(
    (holding) => holding.stellarRisk?.dataStatus === "partial",
  );
  const hasProviderWarnings = (input.dataWarnings?.length ?? 0) > 0;
  const baseRisk = scorePortfolioRisk(holdings);
  const riskScore = Math.max(
    baseRisk,
    unpricedAssetCount > 0 ? 52 : 0,
    hasUnauthorizedTrustline ? 72 : 0,
    hasControlledTrustline ? 58 : 0,
    hasPartialRiskData ? 60 : 0,
    hasProviderWarnings ? 55 : 0,
    reserveReady ? 0 : 68,
  );

  return {
    walletAddress: input.walletAddress,
    nativeBalance,
    nativeSymbol: "XLM",
    dayChangePercent: input.xlmDayChangePercent ?? 0,
    totalValueUsd,
    riskScore,
    createdAt: new Date().toISOString(),
    holdings,
    valuationStatus:
      unpricedAssetCount > 0 || hasProviderWarnings ? "partial" : "complete",
    unpricedAssetCount,
    accountSubentryCount: input.account.subentryCount,
    minimumReserveXlm,
    nativeSellingLiabilities,
    spendableNativeBalance,
    reserveReady,
    recentActivity: input.recentActivity ?? [],
    dataWarnings: input.dataWarnings ?? [],
    providerMeta: {
      provider: "stellar_rpc_and_data_api",
      network: input.networkId,
      latencyMs: input.providerLatencyMs,
    },
  };
}

export function stellarPortfolioCacheKey(
  walletAddress: string,
  networkId: string,
) {
  return `${networkId.trim().toLowerCase()}:${walletAddress.trim().toUpperCase()}`;
}
