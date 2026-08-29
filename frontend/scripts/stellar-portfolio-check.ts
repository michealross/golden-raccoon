import assert from "node:assert/strict";
import {
  buildStellarPortfolioSnapshot,
  calculateMinimumReserveXlm,
  calculateSpendableXlm,
  stellarPortfolioCacheKey,
  type StellarPortfolioHoldingInput,
} from "../src/server/stellar/portfolioModel";
import { getPortfolioRiskSignals } from "../src/server/portfolio/riskScoring";

const wallet =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const issuer =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function native(
  balance: string,
  priceUsd: number | null = 0.1,
): StellarPortfolioHoldingInput {
  return {
    assetKind: "native",
    assetKey: "native",
    symbol: "XLM",
    name: "Stellar Lumens",
    balance,
    sellingLiabilities: "0",
    authorized: true,
    verified: true,
    priceUsd,
    priceSource: priceUsd === null ? undefined : "fixture",
  };
}

function snapshot(
  holdings: StellarPortfolioHoldingInput[],
  subentryCount = Math.max(0, holdings.length - 1),
  dataWarnings: string[] = [],
) {
  return buildStellarPortfolioSnapshot({
    walletAddress: wallet,
    networkId: "stellar-testnet",
    networkName: "Stellar Testnet",
    baseReserveStroops: 5_000_000,
    account: { subentryCount },
    holdings,
    providerLatencyMs: 1,
    dataWarnings,
  });
}

const minimumReserve = calculateMinimumReserveXlm(
  { subentryCount: 3, numSponsoring: 2, numSponsored: 1 },
  5_000_000,
);
assert.equal(minimumReserve, 3);
assert.equal(
  calculateSpendableXlm({
    balance: "10",
    minimumReserveXlm: 3,
    sellingLiabilities: "1.25",
  }),
  5.75,
);

const xlmOnly = snapshot([native("10")], 0);
assert.equal(xlmOnly.minimumReserveXlm, 1);
assert.equal(xlmOnly.spendableNativeBalance, 9);
assert.notEqual(
  xlmOnly.spendableNativeBalance,
  xlmOnly.nativeBalance,
  "Spendable XLM must account for reserve.",
);
assert.equal(
  getPortfolioRiskSignals(xlmOnly.holdings).hasNativeGasToken,
  true,
  "Native XLM must satisfy the gas-asset readiness signal.",
);

const multiTrustline = snapshot([
  native("5"),
  {
    assetKind: "classic",
    assetKey: `classic:USDC:${issuer}`,
    symbol: "USDC",
    name: "USD Coin",
    balance: "25",
    issuer,
    authorized: true,
    verified: true,
    priceUsd: 1,
    priceSource: "official_stellar_usdc",
  },
  {
    assetKind: "classic",
    assetKey: `classic:EURC:${issuer}`,
    symbol: "EURC",
    name: "Euro Coin",
    balance: "2",
    issuer,
    authorized: true,
    verified: true,
    priceUsd: 1.1,
    priceSource: "fixture",
  },
]);
assert.equal(multiTrustline.holdings.length, 3);
assert.equal(multiTrustline.valuationStatus, "complete");
assert.equal(
  multiTrustline.holdings.find((holding) => holding.symbol === "USDC")
    ?.issuer,
  issuer,
);

const unauthorized = snapshot([
  native("5"),
  {
    assetKind: "classic",
    assetKey: `classic:LOCKED:${issuer}`,
    symbol: "LOCKED",
    name: "Locked asset",
    balance: "8",
    issuer,
    authorized: false,
    authorizationRequired: true,
    revocable: true,
    clawbackEnabled: true,
    verified: false,
    priceUsd: 2,
    priceSource: "fixture",
  },
]);
const unauthorizedHolding = unauthorized.holdings.find(
  (holding) => holding.symbol === "LOCKED",
);
assert.equal(unauthorizedHolding?.stellarRisk?.authorized, false);
assert.equal(unauthorizedHolding?.stellarRisk?.clawbackEnabled, true);
assert.ok((unauthorizedHolding?.signals.contractRisk ?? 0) >= 70);
assert.ok((unauthorizedHolding?.riskScore ?? 0) >= 50);
assert.ok(unauthorized.riskScore >= 72);

const partial = snapshot([
  native("5"),
  {
    assetKind: "classic",
    assetKey: `classic:UNKNOWN:${issuer}`,
    symbol: "UNKNOWN",
    name: "Unknown-price asset",
    balance: "50",
    issuer,
    authorized: true,
    verified: false,
    priceUsd: null,
  },
]);
const unpriced = partial.holdings.find(
  (holding) => holding.symbol === "UNKNOWN",
);
assert.equal(partial.valuationStatus, "partial");
assert.equal(partial.unpricedAssetCount, 1);
assert.equal(unpriced?.priceUsd, null);
assert.equal(unpriced?.priceStatus, "unavailable");
assert.equal(partial.totalValueUsd, 0.5);

const contracts = snapshot([
  native("5"),
  {
    assetKind: "sac",
    assetKey: "contract:CSAC",
    symbol: "SAC",
    name: "Stellar Asset Contract",
    balance: "3",
    contractId: "CSAC",
    authorized: true,
    riskDataComplete: false,
    verified: true,
    priceUsd: 1,
    priceSource: "fixture",
  },
  {
    assetKind: "sep41",
    assetKey: "contract:CSEP41",
    symbol: "SEP41",
    name: "SEP-41 token",
    balance: "4",
    contractId: "CSEP41",
    authorized: true,
    verified: true,
    priceUsd: null,
  },
]);
assert.deepEqual(
  contracts.holdings
    .filter((holding) => holding.assetKind !== "native")
    .map((holding) => holding.assetKind)
    .sort(),
  ["sac", "sep41"],
);
assert.equal(contracts.valuationStatus, "partial");
assert.equal(
  contracts.holdings.find((holding) => holding.assetKind === "sac")
    ?.stellarRisk?.dataStatus,
  "partial",
);

const duplicateSac = snapshot([
  native("5"),
  {
    assetKind: "classic",
    assetKey: `classic:USDC:${issuer}`,
    symbol: "USDC",
    name: "USD Coin trustline",
    balance: "10",
    issuer,
    contractId: "CDUPLICATESAC",
    authorized: false,
    clawbackEnabled: true,
    riskDataComplete: true,
    verified: true,
    priceUsd: 1,
    priceSource: "official_stellar_usdc",
  },
  {
    assetKind: "sac",
    assetKey: "contract:CDUPLICATESAC",
    symbol: "USDC",
    name: "USD Coin SAC",
    balance: "10",
    issuer,
    contractId: "CDUPLICATESAC",
    authorized: true,
    riskDataComplete: true,
    verified: true,
    priceUsd: 1,
    priceSource: "official_stellar_usdc",
  },
]);
const dedupedUsdc = duplicateSac.holdings.filter(
  (holding) => holding.symbol === "USDC",
);
assert.equal(dedupedUsdc.length, 1, "Classic/SAC identity must be deduped.");
assert.equal(dedupedUsdc[0]?.balance, 10);
assert.equal(dedupedUsdc[0]?.assetKind, "sac");
assert.equal(
  dedupedUsdc[0]?.stellarRisk?.authorized,
  false,
  "Trustline authorization must win over optimistic contract metadata.",
);
assert.equal(
  dedupedUsdc[0]?.stellarRisk?.clawbackEnabled,
  true,
  "Trustline clawback risk must survive SAC enrichment.",
);
assert.equal(
  duplicateSac.totalValueUsd,
  10.5,
  "Classic/SAC duplicate must not inflate valuation.",
);

const providerPartial = snapshot(
  [native("5")],
  0,
  ["Contract balance unavailable for configured token."],
);
assert.equal(providerPartial.valuationStatus, "partial");
assert.equal(providerPartial.dataWarnings?.length, 1);

const empty = snapshot([], 0);
assert.equal(empty.holdings.length, 0);
assert.equal(empty.nativeBalance, 0);
assert.equal(empty.totalValueUsd, 0);
assert.equal(empty.reserveReady, false);

assert.notEqual(
  stellarPortfolioCacheKey(wallet, "stellar-testnet"),
  stellarPortfolioCacheKey(wallet, "stellar-pubnet"),
  "Cache keys must isolate networks.",
);
assert.notEqual(
  stellarPortfolioCacheKey(wallet, "stellar-testnet"),
  stellarPortfolioCacheKey(
    "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBRK",
    "stellar-testnet",
  ),
  "Cache keys must isolate wallets.",
);

console.log(
  "Stellar portfolio checks passed: XLM-only, multi-trustline, unauthorized, partial-price, SAC/SEP-41, empty-account, and cache isolation.",
);
