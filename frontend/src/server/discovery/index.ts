import type {
  DiscoveryCandidate,
  DiscoveryProviderKind,
  DiscoveryServiceConfig,
} from "@/server/discovery/types";
import { listCandidates, listCandidatesByProvider, listCandidatesByChain, getObservationCount, getUniqueIdentityCount } from "@/server/discovery/store";
import { registerProviders, startScheduler, stopScheduler, isSchedulerRunning, getSchedulerRegistrations } from "@/server/discovery/scheduler";
import { listCursors } from "@/server/discovery/cursor";

// ─── Documentation ───────────────────────────────────────────────────────────
/**
 * # Discovery Service
 *
 * ## Purpose
 * A bounded discovery service that finds candidate tokens/pairs without
 * recommending or executing trades. It acts as the **observation layer**
 * between raw blockchain data and the trading agent pipeline.
 *
 * ## Boundary
 * - **Produces:** `DiscoveryCandidate` objects with market data & evidence.
 * - **Does NOT produce:** trade recommendations, execution plans, risk scores,
 *   or any output that could be directly converted into an executable action.
 * - **Never converts discovery output directly into an executable action.**
 *
 * ## Supported initial chains
 * - EVM: ethereum, base, bsc, arbitrum, polygon, optimism, avalanche, linea,
 *   scroll, zksync, opbnb, mantle, blast, fantom, gnosis, celo, moonbeam,
 *   moonriver, berachain, sonic, unichain, worldchain, monad, plasma, goat
 * - Stellar: stellar-pubnet, stellar-testnet
 *
 * ## Providers
 * - **dexscreener_new_pairs:** Polls DexScreener token profiles for new pairs
 * - **stellar_market:** Polls Stellar Horizon for new assets & liquidity pools
 *
 * ## Data guarantees
 * - Duplicate pairs collapse by canonical chain identity (`canonicalKey`)
 * - Missing fields are `undefined`, not zero — distinguishing "no data" from 0
 * - Every observation links to source evidence and checked time
 * - Observations are immutable once stored
 */

// ─── Initialisation (lazy singleton) ─────────────────────────────────────────

let initialized = false;

/**
 * Initialise the discovery service with the given configuration.
 * Safe to call multiple times — subsequent calls are no-ops.
 *
 * @param config - Discovery service configuration
 */
export function initDiscoveryService(config: DiscoveryServiceConfig = {}): void {
  if (initialized) return;
  initialized = true;

  registerProviders(config);

  if (config.enableScheduler !== false) {
    startScheduler(config);
    console.log("[Discovery] Service initialised with scheduler");
  } else {
    console.log("[Discovery] Service initialised (scheduler disabled)");
  }
}

/**
 * Shut down the discovery service, stopping the scheduler and freeing resources.
 */
export function shutdownDiscoveryService(): void {
  stopScheduler();
  initialized = false;
  console.log("[Discovery] Service shut down");
}

/**
 * Whether the discovery service has been initialised.
 */
export function isDiscoveryInitialized(): boolean {
  return initialized;
}

/**
 * Whether the scheduler is actively polling.
 */
export function isSchedulerActive(): boolean {
  return isSchedulerRunning();
}

// ─── Consumer-facing API ─────────────────────────────────────────────────────

/**
 * Get all discovered candidates.
 * This is the primary output of the discovery service.
 * Consumers receive **market data only** — no executable actions.
 */
export function getDiscoveredCandidates(): DiscoveryCandidate[] {
  return listCandidates();
}

/**
 * Get discovered candidates filtered by provider kind.
 */
export function getDiscoveredCandidatesByProvider(kind: DiscoveryProviderKind): DiscoveryCandidate[] {
  return listCandidatesByProvider(kind);
}

/**
 * Get discovered candidates filtered by chain ID.
 */
export function getDiscoveredCandidatesByChain(chainId: string): DiscoveryCandidate[] {
  return listCandidatesByChain(chainId);
}

/**
 * Get service health diagnostics.
 */
export function getDiscoveryServiceHealth(): {
  initialized: boolean;
  schedulerRunning: boolean;
  providerCount: number;
  uniqueCandidates: number;
  totalObservations: number;
  cursorCount: number;
  providers: { kind: string; chain: string; label: string }[];
} {
  const registrations = getSchedulerRegistrations();

  return {
    initialized,
    schedulerRunning: isSchedulerRunning(),
    providerCount: registrations.length,
    uniqueCandidates: getUniqueIdentityCount(),
    totalObservations: getObservationCount(),
    cursorCount: listCursors().length,
    providers: registrations.map((r) => ({
      kind: r.provider.kind,
      chain: r.provider.chainId,
      label: r.provider.label,
    })),
  };
}

/**
 * Execute a single manual poll cycle without starting the scheduler.
 * Useful for testing or triggered scans.
 */
export async function runDiscoveryCycle(config?: DiscoveryServiceConfig): Promise<{
  candidatesCount: number;
  totalObservations: number;
  results: Array<{
    providerKind: string;
    chainId: string;
    ok: boolean;
    newObservations: number;
    error?: string;
  }>;
}> {
  const { pollAll } = await import("@/server/discovery/scheduler");
  const results = await pollAll();

  return {
    candidatesCount: getUniqueIdentityCount(),
    totalObservations: getObservationCount(),
    results: results.map((r) => ({
      providerKind: r.providerKind,
      chainId: r.chainId,
      ok: r.ok,
      newObservations: r.observations.length,
      error: r.error,
    })),
  };
}
