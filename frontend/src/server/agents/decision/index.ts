import type { AgentFinding, AgentMissingData, AgentRecommendedAction, AgentResult, RiskLevel, UserRule } from "@/server/types";
import { buildAgentResult, clampScore, scoreToRiskLevel } from "@/server/agents/shared";
import { validateAgentResult } from "@/server/agents/schema";

type DecisionMode = "portfolio_review" | "token_scan" | "pre_buy_check" | "holding_review" | "execution_prepare" | "discovery_candidate";

type UserRiskProfile = {
  mode?: "conservative" | "balanced" | "aggressive" | "custom";
  maxRiskScore?: number;
  maxPortfolioRiskScore?: number;
  maxSingleTokenExposurePercent?: number;
  minStableReservePercent?: number;
};

type DecisionContext = {
  mode?: DecisionMode;
  userAlreadyOwnsToken?: boolean;
  targetExposurePercent?: number;
  holdingAllocationPercent?: number;
  stableReservePercent?: number;
  walletAddress?: string;
  tokenSymbol?: string;
  establishedAsset?: boolean;
  discoveryContext?: {
    chainFamily?: string;
    discoverySource?: string;
    identityConfidence?: number;
    identityConfidenceLabel?: "low" | "medium" | "high";
    metrics?: Record<string, unknown>;
  };
};

type ExecutionReadiness = {
  feasible?: boolean;
  actionAllowed?: boolean;
  blockedReason?: string;
  simulationStatus?: "not_required" | "pending" | "passed" | "failed" | "unavailable";
};

type DecisionInput = {
  results?: AgentResult[];
  context?: DecisionContext;
  executionReadiness?: ExecutionReadiness;
  userRules?: Partial<UserRule>;
  userRiskProfile?: UserRiskProfile;
};

type WeightedScoreDetail = {
  agent: AgentResult["agent"];
  score: number;
  weight: number;
  contribution: number;
};

type DecisionBlocker = {
  label: string;
  severity: RiskLevel;
  action: AgentRecommendedAction;
  detail: string;
  sourceAgent?: AgentResult["agent"];
};

type DecisionExplanation = {
  finalAction: AgentRecommendedAction;
  riskSummary: string;
  evidence: string[];
  counterEvidence: string[];
  missingData: string[];
  userImpact: string;
  confidenceExplanation: string;
  whatWouldChangeDecision: string[];
};

const baseAgentWeights: Partial<Record<AgentResult["agent"], number>> = {
  onchain: 0.5,
  portfolio: 0.22,
  news: 0.15,
  social: 0.1,
  execution: 0.03,
  decision: 0,
};

const criticalBlockerMatrix = [
  { blocker: "honeypot", finalAction: "avoid", executionAllowed: false },
  { blocker: "cannot_sell", finalAction: "avoid", executionAllowed: false },
  { blocker: "active_blacklist", finalAction: "manual_review", executionAllowed: false },
  { blocker: "official_phishing_link", finalAction: "manual_review", executionAllowed: false },
  { blocker: "identity_conflict", finalAction: "manual_review", executionAllowed: false },
  { blocker: "no_live_source_coverage", finalAction: "manual_review", executionAllowed: false },
  { blocker: "simulation_failed", finalAction: "manual_review", executionAllowed: false },
] as const;

function findingScore(severity: RiskLevel) {
  return {
    low: 18,
    medium: 48,
    high: 78,
    critical: 96,
  }[severity];
}

function hasAgent(results: AgentResult[], agent: AgentResult["agent"]) {
  return results.some((result) => result.agent === agent);
}

function getResult(results: AgentResult[], agent: AgentResult["agent"]) {
  return results.find((result) => result.agent === agent);
}

function getValidSpecialistResults(results: AgentResult[] = []) {
  const validResults: AgentResult[] = [];
  const invalidMessages: string[] = [];

  for (const result of results) {
    if (result.agent === "decision") {
      continue;
    }

    const parsed = validateAgentResult(result);

    if (parsed.success) {
      validResults.push(parsed.data);
      continue;
    }

    invalidMessages.push(`${result.agent ?? "unknown"}: ${parsed.error.issues[0]?.message ?? "Invalid AgentResult contract."}`);
  }

  return {
    validResults,
    invalidMessages,
  };
}

function normalizeWeightMap(weights: Partial<Record<AgentResult["agent"], number>>) {
  const total = Object.values(weights).reduce((sum, weight) => sum + (weight ?? 0), 0);

  if (total <= 0) {
    return weights;
  }

  return Object.fromEntries(Object.entries(weights).map(([agent, weight]) => [agent, (weight ?? 0) / total])) as Partial<Record<AgentResult["agent"], number>>;
}

function inferContext(results: AgentResult[], context?: DecisionContext): Required<Pick<DecisionContext, "mode" | "userAlreadyOwnsToken" | "holdingAllocationPercent" | "stableReservePercent">> &
  DecisionContext {
  const portfolio = getResult(results, "portfolio");
  const rawPortfolio = portfolio?.rawSignals?.portfolioRisk as
    | {
        largestHoldingPercent?: number;
        stableReservePercent?: number;
      }
    | undefined;
  const stablecoinRatio = typeof portfolio?.rawSignals?.stablecoinRatio === "number" ? portfolio.rawSignals.stablecoinRatio : undefined;
  const holdingAllocationPercent =
    context?.holdingAllocationPercent ??
    context?.targetExposurePercent ??
    rawPortfolio?.largestHoldingPercent ??
    (typeof portfolio?.rawSignals?.largestHoldingPercent === "number" ? portfolio.rawSignals.largestHoldingPercent : undefined) ??
    0;
  const userAlreadyOwnsToken = context?.userAlreadyOwnsToken ?? (hasAgent(results, "portfolio") || holdingAllocationPercent > 0);
  const mode = context?.mode ?? (userAlreadyOwnsToken ? "holding_review" : "pre_buy_check");

  return {
    ...context,
    mode,
    userAlreadyOwnsToken,
    holdingAllocationPercent,
    stableReservePercent: context?.stableReservePercent ?? rawPortfolio?.stableReservePercent ?? stablecoinRatio ?? 0,
  };
}

function getContextAwareWeights(results: AgentResult[], context: ReturnType<typeof inferContext>) {
  const weights = { ...baseAgentWeights };

  if (context.mode === "pre_buy_check" || context.mode === "token_scan") {
    weights.onchain = 0.54;
    weights.news = 0.17;
    weights.social = 0.14;
    weights.portfolio = hasAgent(results, "portfolio") ? 0.12 : 0.02;
    weights.execution = 0.03;
  }

  if (context.mode === "token_scan" && context.establishedAsset) {
    weights.onchain = 0.8;
    weights.news = 0.08;
    weights.social = 0.06;
    weights.portfolio = hasAgent(results, "portfolio") ? 0.04 : 0;
    weights.execution = 0.02;

    for (const agent of ["news", "social"] as const) {
      const result = getResult(results, agent);

      if (result && !result.sources.some((source) => source.status === "connected")) weights[agent] = 0;
    }
  }

  if (context.userAlreadyOwnsToken || context.mode === "holding_review" || context.mode === "portfolio_review") {
    weights.onchain = 0.45;
    weights.portfolio = 0.25;
    weights.news = 0.15;
    weights.social = 0.1;
    weights.execution = 0.05;
  }

  if (!hasAgent(results, "portfolio")) weights.portfolio = 0;
  if (!hasAgent(results, "onchain")) weights.onchain = 0;
  if (!hasAgent(results, "news")) weights.news = 0;
  if (!hasAgent(results, "social")) weights.social = 0;
  if (!hasAgent(results, "execution")) weights.execution = 0;

  return normalizeWeightMap(weights);
}

function getWeightedScore(results: AgentResult[], context: ReturnType<typeof inferContext>) {
  const weights = getContextAwareWeights(results, context);
  const details: WeightedScoreDetail[] = results
    .filter((result) => result.agent !== "decision")
    .map((result) => {
      const weight = weights[result.agent] ?? 0;

      return {
        agent: result.agent,
        score: result.score,
        weight,
        contribution: result.score * weight,
      };
    })
    .filter((detail) => detail.weight > 0);
  const totalWeight = details.reduce((total, detail) => total + detail.weight, 0);
  const score = totalWeight > 0 ? clampScore(details.reduce((total, detail) => total + detail.contribution, 0) / totalWeight) : 50;

  return {
    score,
    details,
    weights,
  };
}

function getSourceCoverage(results: AgentResult[]) {
  const sources = results.flatMap((result) => result.sources);
  const connected = sources.filter((source) => source.status === "connected").length;
  const unavailable = sources.filter((source) => source.status === "unavailable").length;
  const mock = sources.filter((source) => source.status === "mock").length;
  const total = sources.length;
  const agentCoverage = Object.fromEntries(
    results.map((result) => {
      const agentSources = result.sources;
      const connectedSources = agentSources.filter((source) => source.status === "connected").length;

      return [
        result.agent,
        {
          connected: connectedSources,
          total: agentSources.length,
          ratio: agentSources.length > 0 ? connectedSources / agentSources.length : 0,
          status: connectedSources > 0 ? "connected" : "unavailable",
        },
      ];
    }),
  );

  return {
    connected,
    unavailable,
    mock,
    total,
    ratio: total > 0 ? connected / total : 0,
    agentCoverage,
  };
}

function applyCoveragePenalty(score: number, results: AgentResult[], context: ReturnType<typeof inferContext>) {
  const coverage = getSourceCoverage(results);
  const onchainHasCoverage = getResult(results, "onchain")?.sources.some((source) => source.status === "connected");

  if (context.establishedAsset && onchainHasCoverage) return score;

  if (results.length === 0 || coverage.total === 0 || coverage.connected === 0) {
    return clampScore(Math.max(score, 72));
  }

  if (coverage.ratio < 0.35) {
    return clampScore(Math.max(score, 66));
  }

  if (coverage.ratio < 0.5) {
    return clampScore(Math.max(score, 58));
  }

  return score;
}

function includesAny(text: string, patterns: string[]) {
  const normalized = text.toLowerCase();

  return patterns.some((pattern) => normalized.includes(pattern));
}

function collectCriticalBlockers(results: AgentResult[], coverage: ReturnType<typeof getSourceCoverage>, executionReadiness?: ExecutionReadiness): DecisionBlocker[] {
  const blockers: DecisionBlocker[] = [];

  if (results.length === 0) {
    blockers.push({
      label: "No agent results",
      severity: "high",
      action: "manual_review",
      detail: "Decision Agent received no specialist outputs.",
    });
  }

  if (coverage.total === 0 || coverage.connected === 0) {
    blockers.push({
      label: "No connected source",
      severity: "high",
      action: "manual_review",
      detail: "No connected live source contributed to the decision.",
    });
  }

  for (const result of results) {
    const criticalEvidence = [
      ...result.blockingReasons,
      ...result.findings
        .filter((finding) => finding.severity === "critical")
        .map((finding) => `${finding.label} ${finding.detail}`),
    ].join(" ");

    if (result.agent === "onchain" && includesAny(criticalEvidence, ["honeypot", "cannot sell", "cannot-sell", "critical simulation", "blacklist", "no deployed bytecode"])) {
      blockers.push({
        label: "Critical onchain blocker",
        severity: "critical",
        action: "avoid",
        detail: "Onchain checks indicate honeypot, cannot-sell, blacklist or equivalent critical trade blocker.",
        sourceAgent: result.agent,
      });
    }

    if (result.agent === "social" && includesAny(criticalEvidence, ["phishing", "drainer", "identity mismatch", "official-looking phishing"])) {
      blockers.push({
        label: "Critical social identity/link blocker",
        severity: "critical",
        action: result.riskScore >= 75 ? "avoid" : "manual_review",
        detail: "Social checks indicate phishing/drainer links or official identity mismatch.",
        sourceAgent: result.agent,
      });
    }

    if (result.blockingReasons.length > 0 && result.riskScore >= 75) {
      blockers.push({
        label: `${result.agent} blocking reason`,
        severity: "critical",
        action: result.agent === "portfolio" ? "manual_review" : "avoid",
        detail: result.blockingReasons.join(" "),
        sourceAgent: result.agent,
      });
    }
  }

  if (executionReadiness?.feasible === false || executionReadiness?.actionAllowed === false || executionReadiness?.simulationStatus === "failed") {
    blockers.push({
      label: "Execution readiness blocked",
      severity: "high",
      action: "manual_review",
      detail: executionReadiness.blockedReason ?? "Execution readiness is blocked or simulation failed.",
      sourceAgent: "execution",
    });
  }

  return blockers;
}

function getWorstFindings(results: AgentResult[]) {
  return results
    .flatMap((result) =>
      result.findings.map((finding) => ({
        ...finding,
        agent: result.agent,
        score: findingScore(finding.severity),
      })),
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

function getMissingData(results: AgentResult[], coverage: ReturnType<typeof getSourceCoverage>, invalidMessages: string[] = []): AgentMissingData[] {
  const missing = results.flatMap((result) =>
    result.missingData.map((item) => ({
      ...item,
      field: `${result.agent}: ${item.field}`,
    })),
  );

  for (const message of invalidMessages) {
    missing.push({
      field: "invalid agent output",
      reason: message,
      impact: "high",
      requiredFor: "decision contract validation",
      canRetry: true,
      fallbackUsed: false,
    });
  }

  if (!hasAgent(results, "onchain")) {
    missing.push({ field: "onchain result", reason: "Onchain Agent result was not supplied.", impact: "high", requiredFor: "critical blocker detection" });
  }

  if (!hasAgent(results, "news")) {
    missing.push({ field: "news result", reason: "News Agent result was not supplied.", impact: "medium", requiredFor: "catalyst and incident context" });
  }

  if (!hasAgent(results, "social")) {
    missing.push({ field: "social result", reason: "Social Agent result was not supplied.", impact: "medium", requiredFor: "phishing and identity context" });
  }

  if (coverage.connected === 0) {
    missing.push({ field: "source coverage", reason: "No connected source contributed to the decision.", impact: "high", requiredFor: "hold/buy confidence" });
  }

  return missing.slice(0, 8);
}

function getCrossAgentAgreement(results: AgentResult[]) {
  if (results.length <= 1) {
    return 0.5;
  }

  const levels = results.map((result) => result.riskScore);
  const average = levels.reduce((total, score) => total + score, 0) / levels.length;
  const averageDistance = levels.reduce((total, score) => total + Math.abs(score - average), 0) / levels.length;

  return Math.max(0.15, 1 - averageDistance / 55);
}

function getIdentityConfidence(results: AgentResult[]) {
  const rawValues = results.flatMap((result) => {
    const values: number[] = [];
    const raw = result.rawSignals ?? {};
    const identity = raw.identity as { confidence?: unknown } | undefined;

    if (typeof raw.identityMatchConfidence === "number") values.push(raw.identityMatchConfidence);
    if (typeof raw.officialAccountConfidence === "number") values.push(raw.officialAccountConfidence);
    if (identity && typeof identity.confidence === "number") values.push(identity.confidence);

    return values;
  });

  return rawValues.length > 0 ? rawValues.reduce((total, value) => total + value, 0) / rawValues.length : 0.5;
}

function getProviderFreshness(results: AgentResult[]) {
  const checkedTimes = results
    .flatMap((result) => result.sources.map((source) => source.checkedAt).filter((value): value is string => Boolean(value)))
    .map((value) => new Date(value).getTime())
    .filter((value) => !Number.isNaN(value));

  if (checkedTimes.length === 0) {
    return 0.52;
  }

  const newest = Math.max(...checkedTimes);
  const ageHours = Math.max(0, (Date.now() - newest) / 3_600_000);

  if (ageHours <= 1) return 0.95;
  if (ageHours <= 12) return 0.78;
  if (ageHours <= 48) return 0.58;

  return 0.35;
}

function getDecisionConfidence(results: AgentResult[], coverage: ReturnType<typeof getSourceCoverage>) {
  if (results.length === 0) {
    return 0.22;
  }

  const averageAgentConfidence = results.reduce((total, result) => total + result.confidence, 0) / results.length;
  const sourceCoverage = coverage.ratio;
  const identityConfidence = getIdentityConfidence(results);
  const providerFreshness = getProviderFreshness(results);
  const agreement = getCrossAgentAgreement(results);

  return Math.min(
    0.9,
    Math.max(0.18, averageAgentConfidence * 0.35 + sourceCoverage * 0.25 + identityConfidence * 0.15 + providerFreshness * 0.1 + agreement * 0.15),
  );
}

function getDecisionConfidenceFormula(results: AgentResult[], coverage: ReturnType<typeof getSourceCoverage>, conflicts: DecisionBlocker[]) {
  const averageAgentConfidence = results.length > 0 ? results.reduce((total, result) => total + result.confidence, 0) / results.length : 0;
  const sourceCoverage = coverage.ratio;
  const identityConfidence = getIdentityConfidence(results);
  const providerFreshness = getProviderFreshness(results);
  const agreement = getCrossAgentAgreement(results);
  const conflictPenalty = Math.min(0.28, conflicts.length * 0.07);
  const rawConfidence = averageAgentConfidence * 0.35 + sourceCoverage * 0.25 + identityConfidence * 0.15 + providerFreshness * 0.1 + agreement * 0.15;

  return {
    agentConfidence: averageAgentConfidence,
    sourceCoverage,
    identityConfidence,
    providerFreshness,
    crossAgentAgreement: agreement,
    conflictPenalty,
    finalConfidence: Math.min(0.9, Math.max(0.18, rawConfidence - conflictPenalty)),
  };
}

function getHighestPriorityAction(blockers: DecisionBlocker[]) {
  if (blockers.some((blocker) => blocker.action === "avoid")) return "avoid";
  if (blockers.some((blocker) => blocker.action === "manual_review")) return "manual_review";

  return undefined;
}

function resolveConflicts(results: AgentResult[], context: ReturnType<typeof inferContext>, score: number): DecisionBlocker[] {
  const conflicts: DecisionBlocker[] = [];
  const onchain = getResult(results, "onchain");
  const news = getResult(results, "news");
  const social = getResult(results, "social");
  const portfolio = getResult(results, "portfolio");
  const onchainCritical = Boolean(onchain && (onchain.riskScore >= 75 || onchain.findings.some((finding) => finding.severity === "critical")));
  const socialPositive = Boolean(
    social?.findings.some((finding) => includesAny(`${finding.label} ${finding.detail}`, ["positive", "hype", "community update"])) ||
      social?.riskScore !== undefined && social.riskScore < 25,
  );
  const newsPositive = Boolean(news?.rawSignals?.positiveCatalysts && Array.isArray(news.rawSignals.positiveCatalysts) && news.rawSignals.positiveCatalysts.length > 0);
  const lowLiquidity = Boolean(onchain?.findings.some((finding) => finding.label.toLowerCase().includes("liquidity") && finding.severity === "high"));

  if (onchainCritical && socialPositive) {
    conflicts.push({
      label: "Onchain critical overrides social positivity",
      severity: "critical",
      action: "avoid",
      detail: "Positive social signals cannot offset critical onchain trade blockers.",
      sourceAgent: "onchain",
    });
  }

  if (newsPositive && lowLiquidity) {
    conflicts.push({
      label: "Positive news but fragile liquidity",
      severity: "high",
      action: "manual_review",
      detail: "Positive news/listing catalyst is present, but liquidity remains too thin for a confident hold/buy decision.",
      sourceAgent: "onchain",
    });
  }

  if (portfolio && context.holdingAllocationPercent >= 25 && score >= 45 && score < 75) {
    conflicts.push({
      label: "High exposure with medium/high token risk",
      severity: "high",
      action: context.stableReservePercent < 15 ? "swap_to_stable" : "reduce_exposure",
      detail: `Holding exposure is ${context.holdingAllocationPercent.toFixed(1)}% while combined token risk is elevated.`,
      sourceAgent: "portfolio",
    });
  }

  if (!social && onchain && onchain.riskScore < 25 && context.holdingAllocationPercent < 10) {
    conflicts.push({
      label: "Social missing with otherwise low risk",
      severity: "medium",
      action: score < 25 ? "watch" : "manual_review",
      detail: "Social coverage is missing. Low exposure and clean onchain data allow watch, not a confident buy/hold.",
      sourceAgent: "social",
    });
  }

  return conflicts;
}

function decideAction(input: {
  score: number;
  confidence: number;
  results: AgentResult[];
  context: ReturnType<typeof inferContext>;
  blockers: DecisionBlocker[];
  conflicts: DecisionBlocker[];
  userRules?: Partial<UserRule>;
  userRiskProfile?: UserRiskProfile;
}): AgentRecommendedAction {
  const priorityAction = getHighestPriorityAction([...input.blockers, ...input.conflicts].filter((item) => item.action === "avoid" || item.action === "manual_review"));

  if (priorityAction) return priorityAction;

  const conflictAction = getHighestPriorityAction(input.conflicts);

  if (conflictAction) return conflictAction;

  const maxRiskScore = input.userRiskProfile?.maxRiskScore ?? input.userRules?.maxRiskScore;

  if (typeof maxRiskScore === "number" && input.score > maxRiskScore) {
    return "manual_review";
  }

  if (input.confidence < 0.42) {
    return "manual_review";
  }

  if (input.context.userAlreadyOwnsToken && input.context.holdingAllocationPercent >= 25 && input.score >= 50) {
    return input.context.stableReservePercent < 15 ? "swap_to_stable" : "reduce_exposure";
  }

  if (input.context.userAlreadyOwnsToken && input.context.holdingAllocationPercent >= 15 && input.score >= 40) {
    return "reduce_exposure";
  }    if (input.score >= 75) return "avoid";
  if (input.score >= 50) return input.context.userAlreadyOwnsToken ? "reduce_exposure" : "manual_review";
  if (input.score >= 25) return "watch";

  return input.context.userAlreadyOwnsToken && input.context.holdingAllocationPercent <= 20 ? "hold" : "watch";
}

export type DiscoveryClassification = "watch" | "risky" | "scam" | "early_opportunity";

export type DiscoveryClassificationDecision = {
  classification: DiscoveryClassification;
  reasons: string[];
};

export function classifyDiscovery(input: {
  action: AgentRecommendedAction;
  score: number;
  confidence: number;
  results: AgentResult[];
  context?: DecisionContext;
  blockers: DecisionBlocker[];
  coverageConnected: number;
  coverageTotal: number;
}): DiscoveryClassificationDecision {
  const reasons: string[] = [];
  const contextConfidence = input.context?.discoveryContext?.identityConfidence ?? 0;
  const confidenceLabel = input.context?.discoveryContext?.identityConfidenceLabel ?? "low";
  const hasCriticalBlocker = input.blockers.some((blocker) => blocker.severity === "critical");
  const coverageRatio = input.coverageTotal > 0 ? input.coverageConnected / input.coverageTotal : 0;
  const identityResolved = contextConfidence >= 0.42 && confidenceLabel !== "low";
  const metrics = input.context?.discoveryContext?.metrics;
  const criticallyThin = Boolean(
    metrics &&
      typeof metrics.liquidityUsd === "number" &&
      metrics.liquidityUsd < 50_000 &&
      typeof metrics.pairAgeDays === "number" &&
      metrics.pairAgeDays < 7 &&
      typeof metrics.fdvLiquidityRatio === "number" &&
      metrics.fdvLiquidityRatio > 50,
  );

  if (hasCriticalBlocker) {
    reasons.push("Critical blocker observed from a connected specialist agent.");
    return { classification: "scam", reasons };
  }

  if (input.action === "avoid" || input.score >= 75) {
    reasons.push("Decision Agent recommended avoid due to elevated risk score.");
    return { classification: "risky", reasons };
  }

  if (!identityResolved) {
    reasons.push(`Identity confidence is ${confidenceLabel} (${Math.round(contextConfidence * 100)}%) - below resolution threshold.`);
  }

  if (coverageRatio < 0.5 || input.coverageConnected === 0) {
    reasons.push(`Source coverage is ${input.coverageConnected}/${input.coverageTotal}; not enough to upgrade classification.`);
  }

  if (input.confidence < 0.5) {
    reasons.push(`Decision confidence ${Math.round(input.confidence * 100)}% is below the discovery opportunity threshold.`);
  }

  if (criticallyThin) {
    reasons.push("Critically-thin liquidity with young pair age disqualifies from early opportunity.");
  }

  if (
    !criticallyThin &&
    identityResolved &&
    coverageRatio >= 0.5 &&
    input.confidence >= 0.5 &&
    input.score < 50 &&
    input.blockers.length === 0
  ) {
    reasons.push("Identity resolved, coverage adequate, no critical blockers, score below 50.");
    return { classification: "early_opportunity", reasons };
  }

  if (input.score >= 50 || input.blockers.length > 0) {
    reasons.push("Decision Agent flagged elevated risk or non-critical blockers.");
    return { classification: "risky", reasons };
  }

  return { classification: "watch", reasons };
}

function verdictForAction(action: AgentRecommendedAction) {
  if (action === "avoid") return "Avoid token";
  if (action === "swap_to_stable") return "Swap exposure to stablecoin";
  if (action === "reduce_exposure") return "Reduce exposure";
  if (action === "manual_review") return "Manual review required";
  if (action === "watch") return "Watch before acting";
  if (action === "hold") return "Hold within limits";

  return "No major blocker";
}

function getTopReasons(results: AgentResult[], blockers: DecisionBlocker[], conflicts: DecisionBlocker[]) {
  const blockerReasons = [...blockers, ...conflicts].map((blocker) => `${blocker.label}: ${blocker.detail}`);
  const findings = getWorstFindings(results).map((finding) => `${finding.agent}: ${finding.label} - ${finding.detail}`);

  return [...blockerReasons, ...findings].slice(0, 3);
}

function getCounterEvidence(results: AgentResult[]) {
  return results
    .flatMap((result) =>
      result.findings
        .filter((finding) => finding.severity === "low")
        .map((finding) => `${result.agent}: ${finding.label} - ${finding.detail}`),
    )
    .slice(0, 3);
}

function getWhatWouldChangeDecision(action: AgentRecommendedAction, missingData: AgentMissingData[]) {
  if (action === "avoid") {
    return ["Remove or disprove the critical blocker from a connected source.", "Confirm sellability and liquidity with a fresh onchain check.", "Resolve identity/link mismatch if social risk contributed."];
  }

  if (action === "manual_review") {
    return ["Add the missing connected sources listed in missing data.", "Increase identity confidence with contract, website and official social links.", "Run execution simulation before preparing any transaction."];
  }

  if (action === "reduce_exposure" || action === "swap_to_stable") {
    return ["Lower portfolio allocation to the risky asset.", "Improve stable reserve above the configured minimum.", "Show lower onchain/social/news risk on a fresh run."];
  }

  if (missingData.length > 0) {
    return ["Resolve missing data before upgrading this to a stronger hold decision."];
  }

  return ["A new critical onchain, social, news or portfolio finding would change the decision."];
}

function buildExplanation(input: {
  action: AgentRecommendedAction;
  score: number;
  confidence: number;
  results: AgentResult[];
  context: ReturnType<typeof inferContext>;
  blockers: DecisionBlocker[];
  conflicts: DecisionBlocker[];
  missingData: AgentMissingData[];
}): DecisionExplanation {
  const topReasons = getTopReasons(input.results, input.blockers, input.conflicts);
  const counterEvidence = getCounterEvidence(input.results);
  const exposure = input.context.holdingAllocationPercent;

  return {
    finalAction: input.action,
    riskSummary: `Final risk score is ${input.score}/100 (${scoreToRiskLevel(input.score)}).`,
    evidence: topReasons.length > 0 ? topReasons : ["No specialist evidence was supplied."],
    counterEvidence,
    missingData: input.missingData.slice(0, 3).map((item) => `${item.field}: ${item.reason}`),
    userImpact: input.context.userAlreadyOwnsToken
      ? `User exposure is estimated at ${exposure.toFixed(1)}%; stable reserve is ${input.context.stableReservePercent.toFixed(1)}%.`
      : "User appears to be evaluating a new token; portfolio reduction actions are avoided unless exposure is supplied.",
    confidenceExplanation: `Decision confidence is ${Math.round(input.confidence * 100)}%, based on agent confidence, source coverage, identity confidence, provider freshness and cross-agent agreement.`,
    whatWouldChangeDecision: getWhatWouldChangeDecision(input.action, input.missingData),
  };
}

function buildDecisionFindings(input: {
  results: AgentResult[];
  score: number;
  action: AgentRecommendedAction;
  confidence: number;
  coverage: ReturnType<typeof getSourceCoverage>;
  weightedScore: ReturnType<typeof getWeightedScore>;
  blockers: DecisionBlocker[];
  conflicts: DecisionBlocker[];
  missingData: AgentMissingData[];
  explanation: DecisionExplanation;
}): AgentFinding[] {
  return [
    {
      label: "Weighted agent score",
      severity: scoreToRiskLevel(input.score),
      detail: `Weighted score is ${input.score}/100. Weights: ${input.weightedScore.details
        .map((detail) => `${detail.agent} ${Math.round(detail.weight * 100)}%`)
        .join(", ")}.`,
      raw: JSON.stringify(input.weightedScore.details),
    },
    {
      label: "Critical blockers",
      severity: input.blockers.some((blocker) => blocker.severity === "critical") ? "critical" : input.blockers.length > 0 ? "high" : "low",
      detail: input.blockers.length > 0 ? input.blockers.map((blocker) => `${blocker.label}: ${blocker.detail}`).join("; ") : "No deterministic critical blocker was detected.",
      raw: JSON.stringify(input.blockers),
    },
    {
      label: "Conflict resolution",
      severity: input.conflicts.some((conflict) => conflict.severity === "critical") ? "critical" : input.conflicts.length > 0 ? "high" : "low",
      detail: input.conflicts.length > 0 ? input.conflicts.map((conflict) => `${conflict.label}: ${conflict.action}`).join("; ") : "No cross-agent conflict required an override.",
      raw: JSON.stringify(input.conflicts),
    },
    {
      label: "Top decision reasons",
      severity: input.explanation.evidence.some((reason) => includesAny(reason, ["critical", "honeypot", "cannot sell", "phishing"])) ? "critical" : "high",
      detail: input.explanation.evidence.join(" | "),
    },
    {
      label: "Missing data",
      severity: input.missingData.some((item) => item.impact === "high") ? "high" : input.missingData.length > 0 ? "medium" : "low",
      detail: input.missingData.length > 0 ? input.missingData.slice(0, 5).map((item) => `${item.field}: ${item.reason}`).join("; ") : "No material missing data was reported.",
    },
    {
      label: "Source coverage map",
      severity: input.coverage.connected === 0 ? "high" : input.coverage.ratio < 0.5 ? "medium" : "low",
      detail: `${input.coverage.connected} connected, ${input.coverage.unavailable} unavailable, and ${input.coverage.mock} mock source${input.coverage.total === 1 ? "" : "s"} contributed.`,
      raw: JSON.stringify(input.coverage),
    },
    {
      label: "Confidence model",
      severity: input.confidence >= 0.65 ? "low" : input.confidence >= 0.42 ? "medium" : "high",
      detail: input.explanation.confidenceExplanation,
      scoreImpact: clampScore((1 - input.confidence) * 100),
    },
    {
      label: "Structured decision output",
      severity: scoreToRiskLevel(input.score),
      detail: `Final action ${input.action.replaceAll("_", " ")}. ${input.explanation.userImpact}`,
      raw: JSON.stringify(input.explanation),
    },
  ];
}

function getDecisionSources(results: AgentResult[], invalidResultCount: number) {
  return [
    ...results.map((result) => ({
    label: `${result.agent} agent`,
    status: result.sources.some((source) => source.status === "connected") ? ("connected" as const) : ("unavailable" as const),
    detail: `${result.verdict}: ${result.summary}`,
    reliability: result.confidence,
    })),
    ...(invalidResultCount > 0
      ? [
          {
            label: "Agent result contract validation",
            status: "unavailable" as const,
            detail: `${invalidResultCount} submitted agent result${invalidResultCount === 1 ? "" : "s"} failed runtime schema validation.`,
            errorCode: "invalid_agent_result",
            reliability: 0.05,
          },
        ]
      : []),
  ];
}

function getLlmGuard(explanation: DecisionExplanation) {
  return {
    deterministicEngine: true,
    llmMayOverrideFinalAction: false,
    llmAllowedUses: ["explanation_text", "structured_reasoning"],
    schema: {
      finalAction: explanation.finalAction,
      riskSummary: explanation.riskSummary,
      evidence: explanation.evidence,
      counterEvidence: explanation.counterEvidence,
      missingData: explanation.missingData,
      userImpact: explanation.userImpact,
      confidenceExplanation: explanation.confidenceExplanation,
    },
    evidencePolicy: "LLM explanations may only use evidence, counterEvidence, missingData and agent source summaries provided by deterministic agent results.",
  };
}

function getDecisionCoreAudit(input: {
  action: AgentRecommendedAction;
  score: number;
  confidence: number;
  confidenceFormula: ReturnType<typeof getDecisionConfidenceFormula>;
  userRules?: Partial<UserRule>;
  userRiskProfile?: UserRiskProfile;
}) {
  return {
    deterministicCore: true,
    sameInputSameFinalAction: true,
    llmMayOverrideFinalAction: false,
    llmMayOverrideRiskScore: false,
    llmMayOverrideBlockers: false,
    finalAction: input.action,
    riskScore: input.score,
    confidence: input.confidence,
    confidenceFormula: input.confidenceFormula,
    criticalBlockerMatrix,
    whatWouldChangeDecisionIncluded: true,
    userPolicyInputs: {
      riskTolerance: input.userRiskProfile?.mode,
      maxTokenExposure: input.userRiskProfile?.maxSingleTokenExposurePercent,
      stableReserveTarget: input.userRiskProfile?.minStableReservePercent,
      blockedTokens: input.userRules?.blockedTokens,
      blockedChains: input.userRules?.allowedChains ? [] : undefined,
      watchOnlyMode: input.userRules?.allowedActions?.every((action) => action === "watch" || action === "hold" || action === "no_action"),
    },
  };
}

export function runDecisionAgent(input: DecisionInput): AgentResult {
  const { validResults, invalidMessages } = getValidSpecialistResults(input.results);
  const initialContext = inferContext(validResults, input.context);
  const results =
    initialContext.mode === "token_scan" && !initialContext.userAlreadyOwnsToken
      ? validResults.filter((result) => result.agent !== "portfolio")
      : validResults;
  const context = inferContext(results, input.context);
  const coverage = getSourceCoverage(results);
  const weightedScore = getWeightedScore(results, context);
  const score = applyCoveragePenalty(weightedScore.score, results, context);
  const blockers = [
    ...collectCriticalBlockers(results, coverage, input.executionReadiness),
    ...invalidMessages.map((message) => ({
      label: "Invalid agent output",
      severity: "high" as const,
      action: "manual_review" as const,
      detail: message,
    })),
  ];
  const conflicts = resolveConflicts(results, context, score);
  const confidenceFormula = getDecisionConfidenceFormula(results, coverage, conflicts);
  const confidence = confidenceFormula.finalConfidence || getDecisionConfidence(results, coverage);
  const missingData = getMissingData(results, coverage, invalidMessages);
  const recommendedAction = decideAction({
    score,
    confidence,
    results,
    context,
    blockers,
    conflicts,
    userRules: input.userRules,
    userRiskProfile: input.userRiskProfile,
  });
  const explanation = buildExplanation({
    action: recommendedAction,
    score,
    confidence,
    results,
    context,
    blockers,
    conflicts,
    missingData,
  });
  const findings = buildDecisionFindings({
    results,
    score,
    action: recommendedAction,
    confidence,
    coverage,
    weightedScore,
    blockers,
    conflicts,
    missingData,
    explanation,
  });

  return buildAgentResult({
    agent: "decision",
    score,
    verdict: verdictForAction(recommendedAction),
    summary:
      results.length > 0
        ? `Decision Agent combined ${results.map((result) => result.agent).join(", ")} signals into a ${recommendedAction.replaceAll("_", " ")} recommendation.`
        : "Decision Agent needs specialist agent results before producing a recommendation.",
    findings,
    sources: getDecisionSources(results, invalidMessages.length),
    confidence,
    recommendedAction,
    blockingReasons: blockers.map((blocker) => `${blocker.label}: ${blocker.detail}`),
    missingData,
    rawSignals: {
      context,
      weightedScore,
      sourceCoverage: coverage,
      blockers,
      conflicts,
      confidenceFormula,
      deterministicCore: getDecisionCoreAudit({
        action: recommendedAction,
        score,
        confidence,
        confidenceFormula,
        userRules: input.userRules,
        userRiskProfile: input.userRiskProfile,
      }),
      criticalBlockerMatrix,
      invalidAgentOutput: invalidMessages,
      explanation,
      userRules: input.userRules,
      userRiskProfile: input.userRiskProfile,
      executionReadiness: input.executionReadiness,
      llmGuard: getLlmGuard(explanation),
    },
  });
}
