import type { AgentStep, PortfolioSnapshot } from "../types";
import { getDiscoveredCandidates, isDiscoveryInitialized } from "../discovery";

export function observePortfolio(portfolio: PortfolioSnapshot): AgentStep {
  const riskyToken = [...portfolio.holdings].sort((a, b) => b.riskScore - a.riskScore)[0];

  return {
    key: "observe",
    label: "Observe",
    status: "complete",
    detail: `Read ${portfolio.holdings.length} holdings and detected elevated ${riskyToken?.symbol ?? "token"} exposure.`,
  };
}

/**
 * Observe newly discovered candidates from the discovery service.
 * Returns undefined if the discovery service is not initialised.
 */
export function observeDiscoveryCandidates(): AgentStep | undefined {
  if (!isDiscoveryInitialized()) {
    return undefined;
  }

  try {
    const candidates = getDiscoveredCandidates();
    const discoveredChains = new Set(candidates.map((c) => c.chainId));
    const byProvider = new Map<string, number>();
    for (const c of candidates) {
      const count = byProvider.get(c.lastObservedBy) ?? 0;
      byProvider.set(c.lastObservedBy, count + 1);
    }
    const providerSummary = Array.from(byProvider.entries())
      .map(([provider, count]) => `${count} from ${provider}`)
      .join(", ");

    return {
      key: "observe",
      label: "Discover",
      status: candidates.length > 0 ? "complete" : "complete",
      detail:
        candidates.length > 0
          ? `Discovered ${candidates.length} candidate${candidates.length === 1 ? "" : "s"} across ${discoveredChains.size} chain${discoveredChains.size === 1 ? "" : "s"} (${providerSummary}).`
          : "Discovery service is active but no candidates found yet.",
    };
  } catch {
    return undefined;
  }
}
