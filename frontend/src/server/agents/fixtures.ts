import type { AgentInputIdentity, PortfolioSnapshot, StellarTrustlinePreview, TokenHolding, TokenSignal } from "@/server/types";
import { getRiskLevel, scorePortfolioRisk, scoreTokenRisk } from "@/server/portfolio/riskScoring";

function signals(overrides: Partial<TokenSignal> = {}): TokenSignal {
  return {
    scamRisk: 12,
    websiteTrustRisk: 18,
    contractRisk: 18,
    whaleSellRisk: 20,
    liquidityRisk: 20,
    xSentimentRisk: 24,
    holderConcentrationRisk: 20,
    priceVolatilityRisk: 20,
    portfolioExposureRisk: 20,
    ...overrides,
  };
}

function holding(input: Omit<TokenHolding, "riskScore" | "riskLevel">): TokenHolding {
  const riskScore = scoreTokenRisk(input.signals);

  return {
    ...input,
    riskScore,
    riskLevel: getRiskLevel(riskScore),
  };
}

// Stellar-specific fixture helpers
export type StellarTrustlineFixture = {
  assetCode: string;
  issuer: string;
  chain: string;
  walletAddress: string;
  expectedCanCreate: boolean;
  expectedBlockedReason?: StellarTrustlinePreview["blockedReason"];
  issuerFlags: {
    authRequired: boolean;
    authRevocable: boolean;
    authClawbackEnabled: boolean;
    authImmutable: boolean;
  };
  xlmBalance: number;
  subentryCount: number;
  expectedReserveRequiredXlm: number;
  expectedSufficientReserve: boolean;
};

export type StellarSwapFixture = {
  chain: string;
  walletAddress: string;
  fromAsset: string;
  toAsset: string;
  fromIssuer?: string;
  toIssuer?: string;
  amount: number;
  slippageBps: number;
  expectedQuoteSuccess: boolean;
  expectedRouteType?: "classic_path_payment" | "soroban_swap" | "mixed";
};

export const stellarTrustlineFixtures: Record<string, StellarTrustlineFixture> = {
  // Safe trustline - test USDC on testnet with safe issuer
  safeUsdcTestnet: {
    assetCode: "USDC",
    issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    chain: "stellar-testnet",
    walletAddress: "GAH4OKQGUST2QO4AZYBEZNRAGNKYCDMII6RONIRNT77CQ5OAYZAQ3QDQ",
    expectedCanCreate: true,
    issuerFlags: {
      authRequired: false,
      authRevocable: false,
      authClawbackEnabled: false,
      authImmutable: false,
    },
    xlmBalance: 50,
    subentryCount: 0,
    expectedReserveRequiredXlm: 0.5,
    expectedSufficientReserve: true,
  },
  // Clawback issuer - should be blocked
  clawbackIssuer: {
    assetCode: "CLAWBACK",
    issuer: "GDX4EONGQK7W5FY3W5Y6KZXTLJUV3VXOYG5ZYVBQK7Z5OZOBY5J3T4Z6",
    chain: "stellar-testnet",
    walletAddress: "GAH4OKQGUST2QO4AZYBEZNRAGNKYCDMII6RONIRNT77CQ5OAYZAQ3QDQ",
    expectedCanCreate: false,
    expectedBlockedReason: "clawback_enabled",
    issuerFlags: {
      authRequired: false,
      authRevocable: true,
      authClawbackEnabled: true,
      authImmutable: false,
    },
    xlmBalance: 10,
    subentryCount: 3,
    expectedReserveRequiredXlm: 2.0,
    expectedSufficientReserve: false,
  },
  // Insufficient reserve - should be blocked
  insufficientReserve: {
    assetCode: "RESERVE",
    issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    chain: "stellar-testnet",
    walletAddress: "GAH4OKQGUST2QO4AZYBEZNRAGNKYCDMII6RONIRNT77CQ5OAYZAQ3QDQ",
    expectedCanCreate: false,
    expectedBlockedReason: "insufficient_reserve",
    issuerFlags: {
      authRequired: false,
      authRevocable: false,
      authClawbackEnabled: false,
      authImmutable: false,
    },
    xlmBalance: 1.0,
    subentryCount: 0,
    expectedReserveRequiredXlm: 0.5,
    expectedSufficientReserve: false,
  },
  // Wrong network - should be blocked
  wrongNetwork: {
    assetCode: "XLMTEST",
    issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    chain: "ethereum",
    walletAddress: "GAH4OKQGUST2QO4AZYBEZNRAGNKYCDMII6RONIRNT77CQ5OAYZAQ3QDQ",
    expectedCanCreate: false,
    expectedBlockedReason: "network_mismatch",
    issuerFlags: {
      authRequired: false,
      authRevocable: false,
      authClawbackEnabled: false,
      authImmutable: false,
    },
    xlmBalance: 0,
    subentryCount: 0,
    expectedReserveRequiredXlm: 0.5,
    expectedSufficientReserve: false,
  },
};

export const stellarSwapFixtures: Record<string, StellarSwapFixture> = {
  // Successful classic path payment swap on testnet
  xlmToUsdcTestnet: {
    chain: "stellar-testnet",
    walletAddress: "GAH4OKQGUST2QO4AZYBEZNRAGNKYCDMII6RONIRNT77CQ5OAYZAQ3QDQ",
    fromAsset: "native",
    toAsset: "USDC",
    toIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    amount: 100,
    slippageBps: 100,
    expectedQuoteSuccess: true,
    expectedRouteType: "classic_path_payment",
  },
  // Failed swap - unknown asset
  unknownAssetSwap: {
    chain: "stellar-testnet",
    walletAddress: "GAH4OKQGUST2QO4AZYBEZNRAGNKYCDMII6RONIRNT77CQ5OAYZAQ3QDQ",
    fromAsset: "UNKNOWN",
    toAsset: "XLM",
    amount: 10,
    slippageBps: 100,
    expectedQuoteSuccess: false,
  },
  // XLM to XLM - should fail
  xlmToXlm: {
    chain: "stellar-testnet",
    walletAddress: "GAH4OKQGUST2QO4AZYBEZNRAGNKYCDMII6RONIRNT77CQ5OAYZAQ3QDQ",
    fromAsset: "native",
    toAsset: "XLM",
    amount: 100,
    slippageBps: 100,
    expectedQuoteSuccess: false,
  },
  // Invalid wallet address - should fail
  invalidWallet: {
    chain: "stellar-testnet",
    walletAddress: "0x1234",
    fromAsset: "XLM",
    toAsset: "USDC",
    toIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    amount: 100,
    slippageBps: 100,
    expectedQuoteSuccess: false,
  },
};

export const tokenIdentityFixtures: Record<string, AgentInputIdentity> = {
  safeBlueChipToken: {
    chain: "ethereum",
    contractAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    symbol: "WETH",
    tokenName: "Wrapped Ether",
    coingeckoId: "ethereum",
  },
  verifiedStablecoin: {
    chain: "base",
    contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54BDA02913",
    symbol: "USDC",
    tokenName: "USD Coin",
    coingeckoId: "usd-coin",
  },
  newMemeToken: {
    chain: "base",
    contractAddress: "0x1111111111111111111111111111111111111111",
    symbol: "MEME",
    tokenName: "New Meme",
  },
  honeypotToken: {
    chain: "bsc",
    contractAddress: "0x2222222222222222222222222222222222222222",
    symbol: "TRAP",
    tokenName: "Trap Token",
  },
  lowLiquidityToken: {
    chain: "base",
    contractAddress: "0x3333333333333333333333333333333333333333",
    symbol: "THIN",
    tokenName: "Thin Liquidity",
  },
  fakeSocialToken: {
    symbol: "GOAT",
    tokenName: "Fake GOAT",
    twitterUrl: "https://x.com/goat_airdrop_claim",
  },
  newsHeavyLegitimateToken: {
    chain: "ethereum",
    contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    symbol: "USDC",
    tokenName: "USD Coin",
    websiteUrl: "https://www.circle.com/usdc",
    coingeckoId: "usd-coin",
  },
  noDataToken: {
    symbol: "UNKNOWN",
  },
  symbolCollisionToken: {
    symbol: "AI",
  },
};

export function getPortfolioFixture(name: "stableHeavy" | "highConcentration" | "lowLiquidity"): PortfolioSnapshot {
  const holdings =
    name === "stableHeavy"
      ? [
          holding({
            tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54BDA02913",
            symbol: "USDC",
            name: "USD Coin",
            chainId: "base",
            chainName: "Base",
            isVerified: true,
            balance: 800,
            priceUsd: 1,
            valueUsd: 800,
            allocationPercent: 80,
            signals: signals({ liquidityRisk: 8, priceVolatilityRisk: 2, portfolioExposureRisk: 8 }),
          }),
          holding({
            tokenAddress: "native:base",
            symbol: "ETH",
            name: "Ethereum",
            chainId: "base",
            chainName: "Base",
            isVerified: true,
            balance: 0.08,
            priceUsd: 2500,
            valueUsd: 200,
            allocationPercent: 20,
            signals: signals({ liquidityRisk: 12, portfolioExposureRisk: 20 }),
          }),
        ]
      : name === "highConcentration"
        ? [
            holding({
              tokenAddress: "0x1111111111111111111111111111111111111111",
              symbol: "MEME",
              name: "Meme Token",
              chainId: "base",
              chainName: "Base",
              isVerified: false,
              balance: 1000000,
              priceUsd: 0.001,
              valueUsd: 900,
              allocationPercent: 90,
              signals: signals({ scamRisk: 62, liquidityRisk: 74, portfolioExposureRisk: 90 }),
            }),
            holding({
              tokenAddress: "native:base",
              symbol: "ETH",
              name: "Ethereum",
              chainId: "base",
              chainName: "Base",
              isVerified: true,
              balance: 0.04,
              priceUsd: 2500,
              valueUsd: 100,
              allocationPercent: 10,
              signals: signals({ liquidityRisk: 12, portfolioExposureRisk: 10 }),
            }),
          ]
        : [
            holding({
              tokenAddress: "0x3333333333333333333333333333333333333333",
              symbol: "THIN",
              name: "Thin Liquidity",
              chainId: "base",
              chainName: "Base",
              isVerified: false,
              balance: 50000,
              priceUsd: 0.01,
              valueUsd: 500,
              allocationPercent: 50,
              signals: signals({ liquidityRisk: 92, holderConcentrationRisk: 72, portfolioExposureRisk: 50 }),
            }),
            holding({
              tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54BDA02913",
              symbol: "USDC",
              name: "USD Coin",
              chainId: "base",
              chainName: "Base",
              isVerified: true,
              balance: 500,
              priceUsd: 1,
              valueUsd: 500,
              allocationPercent: 50,
              signals: signals({ liquidityRisk: 8, priceVolatilityRisk: 2 }),
            }),
          ];

  return {
    walletAddress: `fixture:${name}`,
    nativeBalance: 0,
    nativeSymbol: "ETH",
    dayChangePercent: 0,
    totalValueUsd: holdings.reduce((total, item) => total + item.valueUsd, 0),
    riskScore: scorePortfolioRisk(holdings),
    createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    holdings,
  };
}
