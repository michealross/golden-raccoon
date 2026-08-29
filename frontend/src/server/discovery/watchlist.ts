import type {
  AgentMissingData,
  AgentSource,
  DiscoveryAgentInputIdentity,
  DiscoveryAlert,
  DiscoveryAlertKind,
  DiscoveryCandidate,
  DiscoveryScanResult,
  DiscoveryClassification,
  DiscoverySourceKind,
  ResolvedTokenIdentity,
  RiskLevel,
  WatchlistEntry,
  WatchlistEntryInput,
  WatchlistScanRun,
} from "@/server/types";
import { resolveTokenIdentity } from "@/server/identity/tokenIdentity";
import {
  addWatchlistEntry,
  addWatchlistScanRun,
  createAgentRunRecord,
  createDiscoveryAlert,
  getWatchlistEntry,
  listWatchlistEntries,
  listWatchlistScanRuns,
  removeWatchlistEntry as removeEntry,
} from "@/server/storage";
import { scanDiscoveryCandidate, type ScanDiscoveryResultSummary, type DiscoveryCandidateProviders } from "@/server/discovery/pipeline";

type DiscoveryEntry = WatchlistEntryInput & {
  resolved: ResolvedTokenIdentity;
};

export type AddWatchlistEntryResult =
  | { ok: true; entry: WatchlistEntry; alreadyExisted: boolean }
  | { ok: false; error: string };

export function deriveCanonicalChainIdentity(input: WatchlistEntryInput & { resolved?: ResolvedTokenIdentity }) {
  const identity = input.resolved ?? resolveTokenIdentity({
    chain: input.chain,
    contractAddress: input.contractAddress,
    symbol: input.symbol,
    tokenName: input.tokenName,
    issuer: input.issuer,
    assetKey: input.assetKey,
    pairAddress: input.pairAddress,
    assetType: input.assetType,
  } as DiscoveryAgentInputIdentity);

  return {
    resolved: identity,
    identityKey: identity.identityKey || `${input.chain}:${input.contractAddress ?? input.assetKey ?? "unknown"}`,
  };
}

export async function addToWatchlist(input: WatchlistEntryInput): Promise<AddWatchlistEntryResult> {
  const { resolved, identityKey } = deriveCanonicalChainIdentity(input);

  if (!resolved.identityKey || resolved.identityKey === "unknown-token") {
    return { ok: false, error: "Identity could not be resolved; add a contract address or Stellar CODE:ISSUER before adding to watchlist." };
  }

  const enriched: DiscoveryEntry = { ...input, resolved };

  const { entry, alreadyExisted } = addWatchlistEntry({
    ...enriched,
    identityKey,
  });

  return { ok: true, entry, alreadyExisted };
}

export async function rescanWatchlistEntry(
  entryId: string,
  options: { walletAddress?: string; providers?: DiscoveryCandidateProviders } = {},
) {
  const entry = getWatchlistEntry(entryId);
  if (!entry) {
    return { ok: false as const, error: "Entry not found" };
  }

  if (options.walletAddress && entry.walletAddress && options.walletAddress.toLowerCase() !== entry.walletAddress.toLowerCase()) {
    return { ok: false as const, error: "Wallet address does not match the watchlist entry's owner." };
  }

  return scanEntry(entry, { walletAddress: entry.walletAddress, providers: options.providers });
}

export async function scanEntry(entry: WatchlistEntry, options: { walletAddress?: string; providers?: DiscoveryCandidateProviders } = {}) {
  const candidateSource: DiscoverySourceKind =
    entry.source === "dexscreener" || entry.source === "stellar_market" ? entry.source : "manual";

  const candidate: DiscoveryCandidate = {
    id: entry.id,
    chain: entry.chain,
    contractAddress: entry.contractAddress,
    pairAddress: entry.pairAddress,
    symbol: entry.symbol,
    tokenName: entry.tokenName,
    assetKey: entry.assetKey,
    issuer: entry.issuer,
    assetType: entry.assetType,
    source: candidateSource,
    discoveredAt: entry.createdAt,
    metrics: {},
    raw: { watchlistEntryId: entry.id },
  };

  let scan: DiscoveryScanResult | undefined;

  try {
    scan = await scanDiscoveryCandidate(candidate, {
      walletAddress: options.walletAddress ?? entry.walletAddress,
      providers: options.providers,
      scanMode: "watchlist_rescan",
      sourceLabel: `Watchlist rescan · ${entry.symbol ?? entry.identityKey}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    const partialRun = addWatchlistScanRun({
      entryId: entry.id,
      walletAddress: entry.walletAddress,
      identityKey: entry.identityKey,
      classification: "watch",
      classificationReasons: [`Scan failed: ${message}`],
      confidence: 0.18,
      score: 50,
      sourceLineage: [],
      missingData: [
        {
          field: "watchlist scan",
          reason: message,
          impact: "high",
          requiredFor: "rescan",
          canRetry: true,
          fallbackUsed: false,
        },
      ],
      status: "failed",
    });

    const failedAlerts = deriveAlertsFromScan({
      entry,
      previousRun: listWatchlistScanRuns(entry.id)[1],
      scan: {
        candidate,
        identity: resolveTokenIdentity(candidate as Parameters<typeof resolveTokenIdentity>[0]),
        results: [],
        decision: {
          agent: "decision",
          status: "blocked",
          riskScore: 100,
          score: 100,
          riskLevel: "critical",
          verdict: `Watchlist rescan failed: ${message}`,
          summary: `Rescan failed for ${entry.symbol ?? entry.identityKey}.`,
          findings: [],
          sources: [],
          dataQuality: {
            mode: "stale",
            connectedSources: 0,
            unavailableSources: 0,
            mockSources: 0,
            sourceCount: 0,
            reliability: 0.05,
            detail: "Scan pipeline failed; prior visible observation is preserved as latest visible result.",
          },
          confidence: 0.18,
          recommendedAction: "manual_review",
          blockingReasons: [`Scan failed: ${message}`],
          missingData: [],
          rawSignals: { failureDetail: message },
          createdAt: new Date().toISOString(),
        },
        classification: "scam",
        classificationReasons: [`Scan failed: ${message}`],
        confidence: 0.18,
        sourceLineage: [],
        missingData: [],
        scannedAt: partialRun.scannedAt,
      } as DiscoveryScanResult,
      runId: partialRun.id,
      forceTriggerKinds: ["critical_risk"],
    });

    return {
      ok: true as const,
      entry,
      scan: undefined,
      newRun: partialRun,
      previousRun: listWatchlistScanRuns(entry.id)[1],
      stale: true,
      alerts: failedAlerts,
    };
  }

  const runtimeRunRecord = createAgentRunRecord({
    walletAddress: entry.walletAddress,
    mode: "discovery_candidate",
    inputSnapshot: {
      watchlistEntryId: entry.id,
      identityKey: entry.identityKey,
      candidateId: candidate.id,
    },
    targetToken: {
      symbol: entry.symbol,
      name: entry.tokenName,
      tokenAddress: entry.contractAddress,
      chain: entry.chain,
    },
    results: scan.results,
  });

  const newRun = addWatchlistScanRun({
    entryId: entry.id,
    walletAddress: entry.walletAddress,
    identityKey: entry.identityKey,
    classification: scan.classification,
    classificationReasons: scan.classificationReasons,
    confidence: scan.confidence,
    score: scan.decision.score,
    sourceLineage: scan.sourceLineage,
    missingData: scan.missingData,
    agentRunId: runtimeRunRecord.id,
    riskReport: undefined,
    status: scan.decision.status === "blocked" ? "partial" : "completed",
  });

  const alerts = deriveAlertsFromScan({
    entry,
    previousRun: listWatchlistScanRuns(entry.id)[1],
    scan,
    runId: newRun.id,
  });

  return {
    ok: true as const,
    entry,
    scan,
    newRun,
    previousRun: listWatchlistScanRuns(entry.id)[1],
    alerts,
  };
}

export async function removeFromWatchlist(entryId: string) {
  return removeEntry(entryId);
}

export function listWatchlist(walletAddress: string): WatchlistEntry[] {
  return listWatchlistEntries(walletAddress);
}

export function listWatchlistHistory(entryId: string): WatchlistScanRun[] {
  return listWatchlistScanRuns(entryId);
}

type AlertTrigger = {
  kind: DiscoveryAlertKind;
  title: string;
  detail: string;
  severity: RiskLevel;
  sourceLabel?: string;
};

const liquidityDropKeywords = [
  "liquidity drop",
  "liquidity thin",
  "liquidity withdraw",
  "liquidity withdrawn",
  "liquidity drained",
  "liquidity removed",
  "liquidity exit",
];

export function deriveAlertsFromScan(input: {
  scan: DiscoveryScanResult;
  previousRun?: WatchlistScanRun;
  entry: WatchlistEntry;
  runId?: string;
  forceTriggerKinds?: DiscoveryAlertKind[];
}): DiscoveryAlert[] {
  const triggers: AlertTrigger[] = [];
  const { scan, previousRun, entry } = input;

  const pushCriticalFlag = scan.classification === "scam" || scan.decision.score >= 75;
  const forced = new Set(input.forceTriggerKinds ?? []);

  if (pushCriticalFlag || forced.has("critical_risk")) {
    triggers.push({
      kind: "critical_risk",
      title: "Critical risk on watchlist entry",
      detail: `${entry.symbol ?? entry.identityKey} classified ${scan.classification} at score ${scan.decision.score}/100.`,
      severity: "critical",
      sourceLabel: "Discovery pipeline",
    });
  }

  if (previousRun && previousRun.classification !== scan.classification) {
    triggers.push({
      kind: "classification_change",
      title: "Watchlist classification changed",
      detail: `${entry.symbol ?? entry.identityKey} changed from ${previousRun.classification} to ${scan.classification}.`,
      severity: scan.classification === "scam" ? "critical" : scan.classification === "risky" ? "high" : "medium",
      sourceLabel: "Watchlist rescan",
    });
  }

  for (const source of scan.sourceLineage) {
    const lower = (source.detail ?? "").toLowerCase();

    if (lower.includes("phishing") || lower.includes("drainer")) {
      triggers.push({
        kind: "social_phishing",
        title: "Phishing/drainer link detected",
        detail: source.detail ?? "Risk from social scan.",
        severity: "critical",
        sourceLabel: source.label,
      });
    }

    if (lower.includes("hack") || lower.includes("exploit") || lower.includes("rug")) {
      triggers.push({
        kind: "news_incident",
        title: "Incident reported in news",
        detail: source.detail ?? "Incident from news coverage.",
        severity: "high",
        sourceLabel: source.label,
      });
    }

    if (liquidityDropKeywords.some((keyword) => lower.includes(keyword))) {
      triggers.push({
        kind: "liquidity_drop",
        title: "Liquidity risk signal",
        detail: source.detail ?? "Liquidity concern.",
        severity: "medium",
        sourceLabel: source.label,
      });
    }
  }

  return triggers.map((trigger) =>
    createDiscoveryAlert({
      walletAddress: entry.walletAddress,
      entryId: entry.id,
      runId: input.runId ?? listWatchlistHistory(entry.id)[0]?.id,
      kind: trigger.kind,
      title: trigger.title,
      detail: trigger.detail,
      severity: trigger.severity,
      sourceLabel: trigger.sourceLabel,
    }),
  );
}

export type { ScanDiscoveryResultSummary as DiscoveryScanSummary };
export type { DiscoveryAlert, DiscoveryAlertKind, WatchlistScanRun, AgentSource, AgentMissingData };