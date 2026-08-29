import type {
  AgentInputIdentity,
  AgentResult,
  AgentSource,
  AgentMissingData,
  DiscoveryAgentContext,
  DiscoveryAgentInputIdentity,
  DiscoveryCandidate,
  DiscoveryClassification,
  DiscoveryScanResult,
  ResolvedTokenIdentity,
} from "@/server/types";
import { classifyDiscovery } from "@/server/agents/decision";
import { runAgentSafely, buildAgentResult } from "@/server/agents/shared";
import { runNewsAgent, type NewsAgentProviders } from "@/server/agents/news";
import { runOnchainAgent, type OnchainAgentProviders } from "@/server/agents/onchain";
import { runPortfolioAgent } from "@/server/agents/portfolio";
import { runSocialAgent } from "@/server/agents/social";
import { resolveTokenIdentity } from "@/server/identity/tokenIdentity";
import { assertApprovalOnly } from "@/server/security/policy";
import { fetchLiveDiscoveryCandidates } from "@/server/discovery/sources";

export type DiscoveryCandidateProviders = {
  listCandidates?: (chain?: string) => Promise<DiscoveryCandidate[]>;
  onchain?: OnchainAgentProviders;
  news?: NewsAgentProviders;
  skipPortfolio?: boolean;
};

function buildUnavailablePortfolioResult(discovery: DiscoveryAgentContext): AgentResult {
  return buildAgentResult({
    agent: "portfolio",
    score: 50,
    verdict: "Wallet not connected for candidate scan",
    summary: `Portfolio context is unavailable because no wallet is connected for ${discovery.tokenSymbol ?? discovery.candidateId}.`,
    findings: [
      {
        label: "Wallet not connected",
        severity: "medium",
        detail: `Candidate ${discovery.tokenSymbol ?? discovery.candidateId} was scanned without a connected wallet; portfolio overlay is intentionally not generated because no holdings can be queried.`,
        sourceLabel: "Discovery pipeline",
        interpretation: "Discovery continues so the decision can still be made from onchain, news and social evidence.",
      },
    ],
    sources: [
      {
        label: "Wallet portfolio API",
        status: "unavailable",
        detail: "Discovery scan invoked without walletAddress; portfolio provider was not contacted.",
        checkedAt: new Date().toISOString(),
        reliability: 0.1,
      },
    ],
    confidence: 0.18,
    recommendedAction: "manual_review",
    blockingReasons: [],
    missingData: [
      {
        field: "portfolio holdings",
        reason: "Wallet is not connected for the Discovery context.",
        impact: "medium",
        requiredFor: "portfolio-overlay decisions",
        canRetry: true,
        fallbackUsed: false,
      },
    ],
    rawSignals: {
      discovery,
      portfolioScope: "candidate_without_wallet",
    },
  });
}

function buildIdentityInput(candidate: DiscoveryCandidate): DiscoveryAgentInputIdentity {
  return {
    chain: candidate.chain,
    contractAddress: candidate.contractAddress,
    symbol: candidate.symbol,
    tokenName: candidate.tokenName,
    issuer: candidate.issuer,
    assetKey: candidate.assetKey,
    pairAddress: candidate.pairAddress,
    dexScreenerPairUrl: candidate.pairUrl,
    assetType: candidate.assetType,
  };
}

function getDiscoveryIdentity(input: DiscoveryAgentInputIdentity): ResolvedTokenIdentity {
  return resolveTokenIdentity(input as AgentInputIdentity);
}

function collectSourceLineage(results: AgentResult[]): AgentSource[] {
  return results.flatMap((result) => result.sources);
}

function collectMissingData(results: AgentResult[]): AgentMissingData[] {
  return results
    .flatMap((result) => result.missingData)
    .slice(0, 8);
}

function hasUsableProviderCoverage(results: AgentResult[]) {
  return results.some((result) => result.sources.some((source) => source.status === "connected"));
}

function normalizeCandidates(candidates: DiscoveryCandidate[]): DiscoveryCandidate[] {
  return candidates.filter((candidate) => Boolean(candidate.chain && (candidate.contractAddress || candidate.assetKey || candidate.pairAddress)));
}

function clampScore(value: number) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function buildDiscoveryAgentContext(
  candidate: DiscoveryCandidate,
  identity: ResolvedTokenIdentity,
  options: { mode: DiscoveryAgentContext["discoveryMode"]; sourceLabel?: string },
): DiscoveryAgentContext {
  return {
    candidateId: candidate.id,
    chain: candidate.chain,
    source: candidate.source,
    discoveryMode: options.mode,
    identityKey: identity.identityKey,
    identityConfidence: identity.confidence,
    identityConfidenceLabel: identity.confidenceLabel,
    metrics: { ...candidate.metrics },
    scanOriginLabel: options.sourceLabel ?? (options.mode === "watchlist_rescan" ? "Watchlist rescan" : "Discovery scan"),
  };
}

async function gatherSpecialistResults(
  candidate: DiscoveryCandidate,
  identity: ResolvedTokenIdentity,
  options: {
    walletAddress?: string;
    providers?: DiscoveryCandidateProviders;
    discovery: DiscoveryAgentContext;
  },
) {
  const providers = options.providers ?? {};
  const discovery = options.discovery;

  const onchainTask = async () => runOnchainAgent(
    {
      chain: candidate.chain,
      contractAddress: candidate.contractAddress,
      symbol: candidate.symbol,
      issuer: candidate.issuer,
      assetKey: candidate.assetKey,
      assetType: candidate.assetType,
      discovery,
    } as Parameters<typeof runOnchainAgent>[0],
    providers.onchain ?? {},
  );
  const newsTask = async () => runNewsAgent(
    {
      tokenName: candidate.tokenName,
      symbol: candidate.symbol,
      contractAddress: candidate.contractAddress,
      projectName: candidate.tokenName,
      chain: candidate.chain,
      discovery,
    },
    providers.news ?? {},
  );
  const socialTask = async () => runSocialAgent({
    symbol: candidate.symbol,
    tokenName: candidate.tokenName,
    contractAddress: candidate.contractAddress,
    websiteUrl: identity.websiteUrl,
    twitterUrl: identity.twitterUrl,
    telegramUrl: identity.telegramUrl,
    discovery,
  });

  const [onchainResult, newsResult, socialResult, portfolioResult] = await Promise.all([
    runAgentSafely("onchain", onchainTask),
    runAgentSafely("news", newsTask),
    runAgentSafely("social", socialTask),
    runAgentSafely("news", () =>
      runNewsAgent(
        {
          tokenName: candidate.tokenName,
          symbol: candidate.symbol,
          contractAddress: candidate.contractAddress,
          projectName: candidate.tokenName,
          chain: candidate.chain,
          discovery,
        },
        providers.news ?? {},
      ),
    ),
    providers.skipPortfolio
      ? Promise.resolve(undefined)
      : runAgentSafely("portfolio", async () => {
          if (!options.walletAddress) {
            return buildUnavailablePortfolioResult(discovery);
}
          return runPortfolioAgent(options.walletAddress, {
            contractAddress: candidate.contractAddress,
            symbol: candidate.symbol,
            discovery,
          });
        }),
  ]);

  return { onchainResult, newsResult, socialResult, portfolioResult };
}

export async function listDiscoveryCandidates(chain?: string, providers: DiscoveryCandidateProviders = {}): Promise<DiscoveryCandidate[]> {
  const providerFn = providers.listCandidates ?? (async (chainFilter?: string) => {
    const live = await fetchLiveDiscoveryCandidates(chainFilter);

    return live.candidates;
  });
  const fetched = await providerFn(chain);

  return normalizeCandidates(fetched);
}

export type ScanDiscoveryResultSummary = {
  candidate: DiscoveryCandidate;
  identity: ResolvedTokenIdentity;
  results: AgentResult[];
  decision: AgentResult;
  classification: DiscoveryClassification;
  classificationReasons: string[];
  confidence: number;
  sourceLineage: AgentSource[];
  missingData: AgentMissingData[];
  scannedAt: string;
  hasPortfolioContext: boolean;
  transactionPrepared: false;
  serverCanSign: false;
  autoExecute: false;
};

export type ScanDiscoveryOptions = {
  walletAddress?: string;
  providers?: DiscoveryCandidateProviders;
  scanMode?: DiscoveryAgentContext["discoveryMode"];
  sourceLabel?: string;
};

export async function scanDiscoveryCandidate(
  candidate: DiscoveryCandidate,
  options: ScanDiscoveryOptions = {},
): Promise<DiscoveryScanResult> {
  assertApprovalOnly({ autoExecute: false });

  const identityInput = buildIdentityInput(candidate);
  const identity = getDiscoveryIdentity(identityInput);
  const discovery = buildDiscoveryAgentContext(candidate, identity, {
    mode: options.scanMode ?? "candidate",
    sourceLabel: options.sourceLabel,
  });
  const { onchainResult, newsResult, socialResult, portfolioResult } = await gatherSpecialistResults(candidate, identity, {
    walletAddress: options.walletAddress,
    providers: options.providers,
    discovery,
  });
  const specialistResults: AgentResult[] = [onchainResult, newsResult, socialResult, ...(portfolioResult ? [portfolioResult] : [])];

  const blockersList = specialistResults.flatMap((result) =>
    result.findings
      .filter((finding) => finding.severity === "critical")
      .map((finding) => ({ sourceAgent: result.agent, label: finding.label, detail: finding.detail })),
  );
  const hasCriticalBlocker = blockersList.length > 0;
  const connectedSourceCount = specialistResults
    .flatMap((result) => result.sources)
    .filter((source) => source.status === "connected").length;
  const totalSourceCount = specialistResults
    .flatMap((result) => result.sources)
    .length;
  const decisionScore = hasCriticalBlocker
    ? Math.max(...specialistResults.map((result) => result.score), 75)
    : clampScore(
        onchainResult.score * 0.5 +
          newsResult.score * 0.15 +
          socialResult.score * 0.15 +
          (portfolioResult ? portfolioResult.score * 0.2 : 0),
      );
  const identityConfidence = identity.confidence;
  const decisionConfidence = hasCriticalBlocker
    ? Math.min(0.42, identityConfidence)
    : Math.min(
        0.9,
        Math.max(
          0.18,
          identityConfidence * 0.35 +
            (totalSourceCount > 0 ? (connectedSourceCount / totalSourceCount) * 0.35 : 0) +
            (hasUsableProviderCoverage(specialistResults) ? 0.2 : 0) +
            (portfolioResult ? 0.1 : 0),
        ),
      );

  const classification: DiscoveryClassification = (() => {
    if (hasCriticalBlocker) return decisionScore >= 75 ? "scam" : "risky";
    if (decisionScore >= 75) return "risky";
    if (decisionScore >= 50) return "risky";
    return "watch";
  })();

  const refinementDecision = classifyDiscovery({
    action: classification === "scam" ? "avoid" : classification === "risky" ? "manual_review" : "watch",
    score: decisionScore,
    confidence: decisionConfidence,
    results: specialistResults,
    context: {
      mode: "discovery_candidate",
      walletAddress: options.walletAddress,
      tokenSymbol: candidate.symbol,
      userAlreadyOwnsToken: false,
      establishedAsset: false,
      discoveryContext: {
        chainFamily: candidate.chain,
        discoverySource: candidate.source,
        identityConfidence,
        identityConfidenceLabel: identity.confidenceLabel,
        metrics: { ...candidate.metrics },
      },
    },
    blockers: blockersList.map((blocker) => ({
      label: `${blocker.sourceAgent}: ${blocker.label}`,
      severity: "critical" as const,
      action: classification === "scam" ? ("avoid" as const) : ("manual_review" as const),
      detail: blocker.detail,
    })),
    coverageConnected: connectedSourceCount,
    coverageTotal: totalSourceCount,
  });

  const finalClassification: DiscoveryClassification =
    refinementDecision.classification === "early_opportunity" && hasCriticalBlocker
      ? "risky"
      : refinementDecision.classification;

  const decisionAgent: AgentResult = {
    agent: "decision",
    status:
      finalClassification === "scam"
        ? "blocked"
        : finalClassification === "risky"
          ? "warning"
          : "complete",
    riskScore: decisionScore,
    score: decisionScore,
    riskLevel:
      decisionScore >= 75 ? "critical" : decisionScore >= 50 ? "high" : decisionScore >= 25 ? "medium" : "low",
    verdict: `Discovery ${finalClassification}`,
    summary: `Discovery classification: ${finalClassification}. Identity confidence ${identity.confidenceLabel} (${Math.round(identityConfidence * 100)}%). Source coverage ${connectedSourceCount}/${totalSourceCount}.`,
    findings: [
      ...specialistResults.flatMap((result) => result.findings),
      {
        label: "Discovery classification",
        severity:
          finalClassification === "scam"
            ? "critical"
            : finalClassification === "risky"
              ? "high"
              : finalClassification === "early_opportunity"
                ? "low"
                : "medium",
        detail: `Classified as ${finalClassification}. ${refinementDecision.reasons.join(" ")}`,
        sourceLabel: "Discovery pipeline",
        interpretation: `Discovery classification ${finalClassification} reflects identity, coverage, confidence, score and thin-liquidity gates.`,
        scoreImpact:
          finalClassification === "scam"
            ? 75
            : finalClassification === "risky"
              ? 55
              : 10,
        confidence: 0.7,
      },
    ],
    sources: collectSourceLineage(specialistResults),
    dataQuality: onchainResult.dataQuality,
    confidence: decisionConfidence,
    recommendedAction:
      finalClassification === "scam" ? "avoid" : finalClassification === "risky" ? "manual_review" : "no_action",
    blockingReasons:
      finalClassification === "scam" || finalClassification === "risky"
        ? blockersList.map((b) => `${b.sourceAgent}: ${b.label}`)
        : [],
    missingData: collectMissingData(specialistResults),
    rawSignals: {
      discoveryAgentContext: discovery,
      discoveryClassification: refinementDecision,
      finalClassification,
      identity,
      candidate,
      hasPortfolioContext: Boolean(portfolioResult),
      sourceCoverage: { connected: connectedSourceCount, total: totalSourceCount },
      executionGuarantees: {
        serverCanSign: false,
        autoExecute: false,
        transactionPrepared: false,
      },
    },
    createdAt: new Date().toISOString(),
  };

  return {
    candidate,
    identity,
    results: [...specialistResults, decisionAgent],
    decision: decisionAgent,
    classification: finalClassification,
    classificationReasons: refinementDecision.reasons,
    confidence: decisionConfidence,
    sourceLineage: collectSourceLineage(specialistResults),
    missingData: collectMissingData(specialistResults),
    scannedAt: decisionAgent.createdAt,
  };
}