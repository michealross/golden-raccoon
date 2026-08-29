/**
 * Discovery service fixture check.
 * Validates the acceptance criteria from Issue #36:
 * - Duplicate pairs collapse by canonical identity
 * - Polling resumes safely after restart
 * - Missing fields are unavailable, not zero
 * - Provider outage increments backoff
 * - Stale cursors trigger fresh polls
 * - Symbol collisions are detected
 */

import { resetStore, storeObservations, listCandidates, getObservationCount } from "../src/server/discovery/store";
import { resetCursors, getCursor, updateCursorSuccess, updateCursorFailure, isCursorReady, isCursorStale, dumpCursors, loadCursors } from "../src/server/discovery/cursor";
import { buildEvmCanonicalIdentity, buildStellarCanonicalIdentity, DedupSet, detectSymbolCollisions } from "../src/server/discovery/dedup";
import { defaultPollingConfigs } from "../src/server/discovery/provider";
import type { CandidateMarketData, CandidateObservation, DiscoveryCursor } from "../src/server/discovery/types";

const backoffConfig = defaultPollingConfigs.dexscreener_new_pairs.backoff;

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log("  PASS: " + label);
    passed++;
  } else {
    console.error("  FAIL: " + label);
    failed++;
  }
}

function makeObservation(
  overrides: Partial<CandidateObservation> & { identity: CandidateObservation["identity"] }
): Omit<CandidateObservation, "id"> {
  return {
    observedBy: "dexscreener_new_pairs" as const,
    observedAt: new Date().toISOString(),
    market: {},
    evidence: [],
    ...overrides,
  };
}

// ─── 1. Deduplication ───────────────────────────────────────────────────────

function testDedupCollapse(): void {
  console.log("\n[Test] Deduplication - duplicate pairs collapse by canonical identity");

  resetStore();

  const identity = buildEvmCanonicalIdentity("ethereum", "0x1234", "TOKEN");

  storeObservations([
    makeObservation({ identity, market: { liquidityUsd: 100_000 }, observedAt: new Date(Date.now() - 5000).toISOString() }),
  ]);
  storeObservations([
    makeObservation({ identity, market: { liquidityUsd: 200_000 }, observedAt: new Date().toISOString() }),
  ]);

  const candidates = listCandidates();
  assert(candidates.length === 1, "Two observations with same canonicalKey -> one candidate");
  assert(candidates[0].observationCount === 2, "observationCount reflects both observations");
  assert(candidates[0].market.liquidityUsd === 200_000, "Latest market data is used (200k, not 100k)");
}

// ─── 2. DedupSet per cycle ──────────────────────────────────────────────────

function testDedupSet(): void {
  console.log("\n[Test] DedupSet - per-cycle deduplication");

  const dedup = new DedupSet();
  const key1 = "evm:ethereum:0x1234";
  const key2 = "evm:ethereum:0x5678";

  assert(!dedup.checkAndMark(key1), "First sighting of key1 is not duplicate");
  assert(dedup.checkAndMark(key1), "Second sighting of key1 is duplicate");
  assert(!dedup.checkAndMark(key2), "First sighting of key2 is not duplicate");
}

// ─── 3. Canonical identity key generation ────────────────────────────────────

function testCanonicalKey(): void {
  console.log("\n[Test] Canonical identity - keys are deterministic and case-normalized");

  const evmIdentity = buildEvmCanonicalIdentity("ethereum", "0xABC123", "TKN");
  assert(evmIdentity.canonicalKey === "evm:ethereum:0xabc123", "EVM canonical key is lowercase-normalized");
  assert(evmIdentity.address === "0xabc123", "EVM address is lowercase-normalized");

  const stellarIdentity = buildStellarCanonicalIdentity("stellar-pubnet", "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", "USDC");
  assert(
    stellarIdentity.canonicalKey === "stellar:stellar-pubnet:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    "Stellar canonical key is uppercase-normalized",
  );
}

// ─── 4. Missing fields - not zero ────────────────────────────────────────────

function testMissingFields(): void {
  console.log("\n[Test] Missing fields - unavailable fields are undefined, not zero");

  resetStore();

  const identity = buildEvmCanonicalIdentity("ethereum", "0xmissing", "MISS");
  const partialMarket: CandidateMarketData = {};

  storeObservations([
    makeObservation({ identity, market: partialMarket }),
  ]);

  const candidate = listCandidates().find((c) => c.canonicalKey === identity.canonicalKey);
  assert(candidate !== undefined, "Candidate exists");

  if (candidate) {
    assert(candidate.market.pairAgeDays === undefined, "pairAgeDays is undefined (not 0)");
    assert(candidate.market.liquidityUsd === undefined, "liquidityUsd is undefined (not 0)");
    assert(candidate.market.volume24hUsd === undefined, "volume24hUsd is undefined (not 0)");
    assert(candidate.market.fdvUsd === undefined, "fdvUsd is undefined (not 0)");

    // Set only one field and verify the rest remain undefined
    resetStore();
    const partialMarket2: CandidateMarketData = { liquidityUsd: 50_000 };
    storeObservations([
      makeObservation({ identity: buildEvmCanonicalIdentity("ethereum", "0xpartial", "PART"), market: partialMarket2 }),
    ]);
    const candidate2 = listCandidates().find((c) => c.address === "0xpartial");
    if (candidate2) {
      assert(candidate2.market.liquidityUsd === 50_000, "Set field liquidityUsd = 50000");
      assert(candidate2.market.volume24hUsd === undefined, "Unset field volume24hUsd is undefined");
      assert(candidate2.market.fdvLiquidityRatio === undefined, "Unset field fdvLiquidityRatio is undefined");
    }
  }
}

// ─── 5. Cursor resumption after restart ──────────────────────────────────────

function testCursorResumption(): void {
  console.log("\n[Test] Cursor - polling resumes safely after restart");

  resetCursors();

  const cursor1 = updateCursorSuccess("dexscreener_new_pairs", "ethereum", "0xlatestPair");
  assert(cursor1.consecutiveFailures === 0, "After success, consecutiveFailures = 0");
  assert(cursor1.cursor === "0xlatestPair", "Cursor stores the provider-specific value");

  const dumped = dumpCursors();
  assert(dumped.length === 1, "Dumped cursor count = 1");

  resetCursors();
  assert(getCursor("dexscreener_new_pairs", "ethereum") === null, "After reset, cursor is null");

  loadCursors(dumped);
  const loaded = getCursor("dexscreener_new_pairs", "ethereum");
  assert(loaded !== null, "After load, cursor exists");
  assert(loaded!.cursor === "0xlatestPair", "After load, cursor value is restored");
  assert(loaded!.consecutiveFailures === 0, "After load, consecutiveFailures = 0");
}

// ─── 6. Provider outage backoff ──────────────────────────────────────────────

function testProviderBackoff(): void {
  console.log("\n[Test] Backoff - consecutive failures increase backoff duration");

  resetCursors();

  const firstFailure = updateCursorFailure("dexscreener_new_pairs", "base", backoffConfig);
  assert(firstFailure.consecutiveFailures === 1, "First failure -> consecutiveFailures = 1");
  assert(!isCursorReady(firstFailure), "After first failure, cursor is NOT ready (backoff applied)");

  const secondFailure = updateCursorFailure("dexscreener_new_pairs", "base", backoffConfig);
  assert(secondFailure.consecutiveFailures === 2, "Second failure -> consecutiveFailures = 2");

  const delay1 = firstFailure.nextAllowedPollMs - Date.now();
  const delay2 = secondFailure.nextAllowedPollMs - Date.now();
  assert(delay2 > delay1, "Second backoff delay is longer than first (exponential)");

  const success = updateCursorSuccess("dexscreener_new_pairs", "base", "0xnewPair");
  assert(success.consecutiveFailures === 0, "After success, consecutiveFailures resets to 0");
  assert(isCursorReady(success), "After success, cursor is ready immediately");
}

// ─── 7. Cursor staleness ────────────────────────────────────────────────────

function testCursorStaleness(): void {
  console.log("\n[Test] Freshness - stale cursors trigger fresh polls");

  resetCursors();

  const staleCursor: DiscoveryCursor = {
    providerKind: "dexscreener_new_pairs",
    chainId: "bsc",
    cursor: "0xoldPair",
    updatedAt: new Date(Date.now() - 600_000).toISOString(),
    consecutiveFailures: 0,
    nextAllowedPollMs: 0,
  };

  assert(isCursorStale(staleCursor, 300_000), "Cursor updated 10min ago is stale with 5min maxAge");
  assert(!isCursorStale(staleCursor, 600_000), "Same cursor is NOT stale with 10min maxAge");

  const freshCursor: DiscoveryCursor = {
    ...staleCursor,
    updatedAt: new Date(Date.now() - 10_000).toISOString(),
  };
  assert(!isCursorStale(freshCursor, 300_000), "Fresh cursor (10s old) is not stale with 5min maxAge");
}

// ─── 8. Evidence links ──────────────────────────────────────────────────────

function testEvidenceLinks(): void {
  console.log("\n[Test] Evidence - every candidate links to source evidence and checked time");

  resetStore();

  const identity = buildEvmCanonicalIdentity("ethereum", "0xevidence", "EVID");
  const evidence = [
    {
      providerKind: "dexscreener_new_pairs" as const,
      sourceLabel: "DexScreener API",
      sourceUrl: "https://dexscreener.com/ethereum/0xevidence",
      externalId: "0xevidence",
      fetchedAt: new Date().toISOString(),
      latencyMs: 320,
    },
  ];

  storeObservations([
    makeObservation({ identity, evidence, market: { liquidityUsd: 10_000 } }),
  ]);

  const candidates = listCandidates();
  const candidate = candidates.find((c) => c.canonicalKey === identity.canonicalKey);
  assert(candidate !== undefined, "Candidate with evidence exists");

  if (candidate) {
    assert(candidate.evidence.length >= 1, "Candidate has at least one evidence link");
    assert(candidate.evidence[0].sourceLabel === "DexScreener API", "Evidence has source label");
    assert(Boolean(candidate.evidence[0].fetchedAt), "Evidence has fetch timestamp (checked time)");
    assert(candidate.lastObservedAt !== undefined, "Candidate has lastObservedAt timestamp");
  }
}

// ─── 9. Malformed data handling ─────────────────────────────────────────────

function testMalformedData(): void {
  console.log("\n[Test] Malformed data - invalid data does not corrupt the store");

  resetStore();

  const identity = buildEvmCanonicalIdentity("ethereum", "0xmalformed", "BAD");
  const malformedMarket: CandidateMarketData = {};

  storeObservations([
    makeObservation({ identity, market: malformedMarket }),
  ]);

  const candidates = listCandidates();
  const candidate = candidates.find((c) => c.canonicalKey === identity.canonicalKey);
  assert(candidate !== undefined, "Candidate with malformed data exists");

  if (candidate) {
    assert(typeof candidate.canonicalKey === "string", "canonicalKey is a string");
    assert(candidate.chainFamily === "evm", "chainFamily is preserved");
    assert(candidate.chainId === "ethereum", "chainId is preserved");
  }
}

// ─── 10. Symbol collision detection ─────────────────────────────────────────

function testSymbolCollision(): void {
  console.log("\n[Test] Collision - symbol collisions are detected across canonical identities");

  const identity1 = buildEvmCanonicalIdentity("ethereum", "0xcollision", "TOKEN");
  const identity2 = buildEvmCanonicalIdentity("ethereum", "0xcollision2", "TKN");

  const collision = detectSymbolCollisions(identity1, identity2);
  assert(collision !== null, "Symbol collision detected between TOKEN and TKN on ethereum");
  assert(collision!.existingSymbol === "TOKEN", "Collision reports existing symbol TOKEN");
  assert(collision!.incomingSymbol === "TKN", "Collision reports incoming symbol TKN");

  // No collision when symbols match
  const identity3 = buildEvmCanonicalIdentity("ethereum", "0xsame", "SAME");
  const identity4 = buildEvmCanonicalIdentity("ethereum", "0xsame2", "SAME");
  const noCollision = detectSymbolCollisions(identity3, identity4);
  assert(noCollision === null, "No collision when symbols match");

  // No collision across different chains
  const identity5 = buildEvmCanonicalIdentity("base", "0xbase", "TOKEN");
  const identity6 = buildEvmCanonicalIdentity("ethereum", "0xeth", "TKN");
  const crossChainCollision = detectSymbolCollisions(identity5, identity6);
  assert(crossChainCollision === null, "No collision across different chains");
}

// ─── Run all tests ──────────────────────────────────────────────────────────

const tests = [
  testDedupCollapse,
  testDedupSet,
  testCanonicalKey,
  testMissingFields,
  testCursorResumption,
  testProviderBackoff,
  testCursorStaleness,
  testEvidenceLinks,
  testMalformedData,
  testSymbolCollision,
];

console.log("=== Discovery Service Fixture Check ===");
console.log("Running " + tests.length + " test suites...\n");

for (const test of tests) {
  try {
    test();
  } catch (error) {
    console.error("  ERROR: " + test.name + " threw: " + (error instanceof Error ? error.message : error));
    failed++;
  }
}

console.log("\n=== Results: " + passed + " passed, " + failed + " failed ===");

resetStore();
resetCursors();

process.exit(failed > 0 ? 1 : 0);
