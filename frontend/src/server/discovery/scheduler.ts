import type {
  DiscoveryChainId,
  DiscoveryProviderKind,
  DiscoveryServiceConfig,
  PollResult,
  ProviderPollingConfig,
} from "@/server/discovery/types";
import type { DiscoveryProvider, ProviderRegistration } from "@/server/discovery/provider";
import { defaultPollingConfigs, getChainsForProvider } from "@/server/discovery/provider";
import { getCursor, isCursorReady, isCursorStale } from "@/server/discovery/cursor";
import { storeObservations, pruneObservations } from "@/server/discovery/store";
import { createDexScreenerProvider } from "@/server/discovery/providers/dexscreener";
import { createStellarMarketProvider } from "@/server/discovery/providers/stellar";

// ─── Provider factory map ────────────────────────────────────────────────────

const providerFactories: Record<
  DiscoveryProviderKind,
  (chainId: DiscoveryChainId) => DiscoveryProvider
> = {
  dexscreener_new_pairs: createDexScreenerProvider,
  stellar_market: createStellarMarketProvider,
};

// ─── Scheduler state ─────────────────────────────────────────────────────────

type SchedulerState = {
  running: boolean;
  pollIntervalId: ReturnType<typeof setInterval> | null;
  registrations: ProviderRegistration[];
  config: DiscoveryServiceConfig;
};

const state: SchedulerState = {
  running: false,
  pollIntervalId: null,
  registrations: [],
  config: {},
};

// ─── Resolve polling config ──────────────────────────────────────────────────

function resolveConfig(
  kind: DiscoveryProviderKind,
  overrides?: DiscoveryServiceConfig["providerOverrides"],
): ProviderPollingConfig {
  const defaults = defaultPollingConfigs[kind];
  const override = overrides?.[kind];
  if (!override) return defaults;

  return {
    rateLimit: { ...defaults.rateLimit, ...override.rateLimit },
    backoff: { ...defaults.backoff, ...override.backoff },
    freshness: { ...defaults.freshness, ...override.freshness },
  };
}

// ─── Register providers ──────────────────────────────────────────────────────

export function registerProviders(config: DiscoveryServiceConfig = {}): ProviderRegistration[] {
  const enabledProviders = config.enabledProviders ?? Object.keys(providerFactories) as DiscoveryProviderKind[];
  const enabledChains = config.enabledChains;

  const registrations: ProviderRegistration[] = [];

  for (const kind of enabledProviders) {
    const chains = getChainsForProvider(kind);
    const factory = providerFactories[kind];

    if (!factory) continue;

    for (const chainId of chains) {
      if (enabledChains && !enabledChains.includes(chainId)) continue;

      const provider = factory(chainId);
      if (!provider.isAvailable()) continue;

      registrations.push({
        provider,
        config: resolveConfig(kind, config.providerOverrides),
      });
    }
  }

  state.registrations = registrations;
  return registrations;
}

// ─── Poll a single provider ──────────────────────────────────────────────────

export async function pollProvider(
  registration: ProviderRegistration,
): Promise<PollResult> {
  const { provider, config } = registration;
  const cursor = getCursor(provider.kind, provider.chainId);

  // Check freshness - if cursor is fresh enough, skip this poll
  if (cursor && !isCursorStale(cursor, config.freshness.maxCursorAgeMs) && isCursorReady(cursor)) {
    // Check if poll interval has elapsed
    const ageMs = Date.now() - new Date(cursor.updatedAt).getTime();
    if (ageMs < config.freshness.pollIntervalMs) {
      return {
        chainId: provider.chainId,
        providerKind: provider.kind,
        observations: [],
        cursor,
        ok: true,
        elapsedMs: 0,
      };
    }
  }

  const result = await provider.poll(cursor, config);

  // Store observations if poll succeeded
  if (result.ok && result.observations.length > 0) {
    const stored = storeObservations(
      result.observations.map((obs) => ({
        identity: obs.identity,
        observedBy: obs.observedBy,
        observedAt: obs.observedAt,
        market: obs.market,
        evidence: obs.evidence,
        riskScore: obs.riskScore,
        riskLevel: obs.riskLevel,
      })),
    );

    // Prune old observations per identity to limit memory use
    const maxPerIdentity = state.config.maxObservationsPerIdentity ?? 3;
    const prunedKeys = new Set<string>();
    for (const obs of stored) {
      if (!prunedKeys.has(obs.identity.canonicalKey)) {
        pruneObservations(obs.identity.canonicalKey, maxPerIdentity);
        prunedKeys.add(obs.identity.canonicalKey);
      }
    }
  }

  return result;
}

// ─── Poll all registered providers ───────────────────────────────────────────

export async function pollAll(): Promise<PollResult[]> {
  const results: PollResult[] = [];

  for (const registration of state.registrations) {
    try {
      const result = await pollProvider(registration);
      results.push(result);
    } catch (error) {
      results.push({
        chainId: registration.provider.chainId,
        providerKind: registration.provider.kind,
        observations: [],
        cursor: {
          providerKind: registration.provider.kind,
          chainId: registration.provider.chainId,
          cursor: "",
          updatedAt: new Date().toISOString(),
          consecutiveFailures: 0,
          nextAllowedPollMs: Date.now() + 30_000,
        },
        ok: false,
        error: error instanceof Error ? error.message : "Poll failed unexpectedly",
        elapsedMs: 0,
      });
    }
  }

  return results;
}

// ─── Scheduler lifecycle ─────────────────────────────────────────────────────

export function startScheduler(config: DiscoveryServiceConfig = {}): void {
  if (state.running) return;

  state.config = config;
  registerProviders(config);
  state.running = true;

  // Run an initial poll cycle immediately
  pollAll().catch((error) => {
    console.error(`[Discovery Scheduler] Initial poll failed: ${error instanceof Error ? error.message : error}`);
  });

  // Set up interval for subsequent polls
  const intervalMs = Math.min(
    ...state.registrations.map((r) => r.config.freshness.pollIntervalMs),
    60_000, // Cap at 60s
  );

  state.pollIntervalId = setInterval(() => {
    pollAll().catch((error) => {
      console.error(`[Discovery Scheduler] Poll cycle failed: ${error instanceof Error ? error.message : error}`);
    });
  }, intervalMs);

  console.log(`[Discovery Scheduler] Started with ${state.registrations.length} provider(s), polling every ${intervalMs}ms`);
}

export function stopScheduler(): void {
  if (!state.running) return;

  if (state.pollIntervalId !== null) {
    clearInterval(state.pollIntervalId);
    state.pollIntervalId = null;
  }

  state.running = false;
  console.log("[Discovery Scheduler] Stopped");
}

export function isSchedulerRunning(): boolean {
  return state.running;
}

export function getSchedulerRegistrations(): ProviderRegistration[] {
  return [...state.registrations];
}
