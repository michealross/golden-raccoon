import type { AgentFinding, AgentResult, RiskBreakdownItem, RiskLevel, TokenScanResult } from "@/server/types";
import { runDecisionAgent } from "@/server/agents/decision";
import { buildExecutionPreview } from "@/server/agents/execution";
import { runPortfolioAgent } from "@/server/agents/portfolio";
import { runAgentSafely, scoreToRiskLevel } from "@/server/agents/shared";
import { runNewsAgent } from "@/server/agents/news";
import { runOnchainAgent } from "@/server/agents/onchain";
import { runSocialAgent } from "@/server/agents/social";
import { buildRiskReport, createRiskReportInput } from "@/server/scan/riskReport";
import { normalizeTokenInput } from "@/server/scan/tokenInput";
import { isVerifiedEstablishedAsset } from "@/server/portfolio/tokenRegistry";
import { getChainFamily } from "@/lib/chainIdentity";

type ScanCheck = NonNullable<TokenScanResult["analysisChecks"]>[number];
const unavailableCheckLabels = ["Deployed", "Honeypot", "Sell tax", "Ownership", "Holders", "Liquidity", "LP lock", "Market"];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown) {
  if (typeof value === "string" && value.trim() === "") return undefined;

  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;

  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasSignal(value: unknown) {
  return value !== undefined && value !== null && !(typeof value === "string" && value.trim() === "");
}

function isTrueFlag(value: unknown) {
  return value === true || value === 1 || value === "1" || (typeof value === "string" && value.toLowerCase() === "true");
}

function checkStatus(score: number | null): ScanCheck["status"] {
  if (score === null) return "unavailable";
  if (score >= 50) return "danger";
  if (score >= 25) return "warning";
  return "pass";
}

function shortUsd(value?: number) {
  if (typeof value !== "number") return undefined;
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}K`;
  return `$${Math.round(value)}`;
}

export function buildAnalysisChecks(onchainResult: AgentResult, establishedAsset: boolean): ScanCheck[] {
  const raw = asRecord(onchainResult.rawSignals);
  const identity = asRecord(raw.contractIdentity);
  const security = asRecord(raw.security);
  const holders = asRecord(raw.holders);
  const lp = asRecord(raw.lp);
  const lockProvider = asRecord(lp.lockProvider);
  const market = asRecord(raw.market);
  const bestPair = asRecord(market.bestPair);
  const scores = asRecord(raw.scoreBreakdown);
  const identityChecked = identity.checked === true;
  const deployed = identity.deployed === true;
  const honeypotKnown = hasSignal(security.honeypot);
  const honeypot = isTrueFlag(security.honeypot);
  const rawSellTax = asNumber(security.sellTax);
  const sellTax = rawSellTax === undefined ? undefined : rawSellTax * 100;
  const permissionValues = [security.hiddenOwner, security.ownerCanChangeBalance, security.mintable, security.pausable];
  const permissionFlags = permissionValues.filter(isTrueFlag).length;
  const permissionsKnown = permissionValues.every(hasSignal);
  const holderCount = asNumber(holders.holderCount) ?? 0;
  const holderScore = holderCount > 0 ? asNumber(scores.holderConcentration) ?? null : null;
  const dexConnected = onchainResult.sources.some((source) => source.label === "DexScreener token pairs" && source.status === "connected");
  const liquidityScore = dexConnected ? asNumber(scores.liquidityExit) ?? null : null;
  const marketScore = dexConnected ? asNumber(scores.marketAnomaly) ?? null : null;
  const protectedPercent = asNumber(lockProvider.protectedPercent);
  const boundedProtectedPercent =
    lockProvider.provider === "unavailable" || protectedPercent === undefined
      ? undefined
      : Math.max(0, Math.min(100, protectedPercent));
  const liquidityUsd = asNumber(bestPair.liquidityUsd);
  const fdvUsd = asNumber(bestPair.fdvUsd);
  const fdvLiquidityRatio = liquidityUsd && fdvUsd ? fdvUsd / liquidityUsd : undefined;
  const top5Percent = holderCount > 0 ? asNumber(holders.top5Percent) : undefined;
  const permissionLabels = [
    ["hidden owner", security.hiddenOwner],
    ["balance control", security.ownerCanChangeBalance],
    ["mint", security.mintable],
    ["pause", security.pausable],
  ].filter(([, value]) => isTrueFlag(value)).map(([label]) => label);

  const checks: Array<Omit<ScanCheck, "status">> = [
    { key: "deployed", label: "Deployed", score: identityChecked ? (deployed ? 0 : 100) : null, value: identityChecked ? (deployed ? "+" : "x") : "?", reason: identityChecked ? (deployed ? `Bytecode confirmed${asNumber(identity.bytecodeSize) ? ` (${asNumber(identity.bytecodeSize)} bytes)` : ""}.` : "No contract bytecode exists on this network.") : "RPC bytecode check was unavailable." },
    { key: "honeypot", label: "Honeypot", score: honeypotKnown ? (honeypot ? 100 : 0) : null, value: honeypotKnown ? (honeypot ? "x" : "+") : "?", reason: honeypotKnown ? (honeypot ? "Sell restriction or honeypot flag detected." : "No honeypot or cannot-sell flag detected.") : "Honeypot data was unavailable." },
    { key: "sell_tax", label: "Sell tax", score: sellTax === undefined ? null : sellTax >= 25 ? 100 : sellTax >= 10 ? 65 : sellTax > 0 ? 30 : 0, value: sellTax === undefined ? "?" : `${sellTax.toFixed(1)}%`, reason: sellTax === undefined ? "Sell tax could not be verified." : `Reported sell tax is ${sellTax.toFixed(1)}%.` },
    { key: "ownership", label: "Ownership", score: permissionFlags >= 2 ? 85 : permissionFlags === 1 ? 55 : permissionsKnown ? 0 : null, value: permissionFlags > 0 ? `${permissionFlags} flags` : permissionsKnown ? "+" : "?", reason: permissionFlags > 0 ? `${permissionLabels.join(", ")} control detected${establishedAsset && permissionLabels.includes("mint") ? "; bridge assets may require mint/burn control" : ""}.` : permissionsKnown ? "No elevated owner control detected." : "Ownership controls could not be verified." },
    { key: "holders", label: "Holders", score: holderScore, value: top5Percent === undefined ? undefined : `Top 5 ${top5Percent.toFixed(0)}%`, reason: top5Percent === undefined ? "Holder distribution was unavailable." : `Top 5 non-excluded holders control ${top5Percent.toFixed(1)}%.` },
    { key: "liquidity", label: "Liquidity", score: liquidityScore, value: dexConnected && liquidityUsd === undefined ? "$0" : shortUsd(liquidityUsd), reason: !dexConnected ? "DEX liquidity was unavailable." : liquidityUsd === undefined ? "No DEX liquidity pool was found." : `Best detected DEX pool holds ${shortUsd(liquidityUsd)} liquidity.` },
    { key: "lp_lock", label: "LP lock", score: boundedProtectedPercent === undefined ? null : Math.round(100 - boundedProtectedPercent), value: boundedProtectedPercent === undefined ? "?" : `${boundedProtectedPercent.toFixed(0)}%`, reason: boundedProtectedPercent === undefined ? "LP lock data was unavailable." : `${boundedProtectedPercent.toFixed(1)}% of detected LP is locked or burned.` },
    { key: "market", label: "Market", score: marketScore, value: asNumber(market.pairCount) ? `${asNumber(market.pairCount)} pairs` : undefined, reason: !dexConnected ? "Market data was unavailable." : fdvLiquidityRatio === undefined ? "No usable FDV/liquidity ratio was found." : `FDV is ${fdvLiquidityRatio.toFixed(1)}x detected DEX liquidity.` },
  ];

  return checks.map((check) => ({ ...check, status: checkStatus(check.score) }));
}

export function buildStellarAnalysisChecks(onchainResult: AgentResult): ScanCheck[] {
  const labels = [
    "Asset identity",
    "Issuer controls",
    "Clawback capability",
    "Trustline state",
    "Liquidity",
    "Contract interface",
    "Contract storage",
    "Data quality",
  ];

  return labels.map((label) => {
    const finding = onchainResult.findings.find((candidate) => candidate.label === label);
    const score = typeof finding?.scoreImpact === "number" ? finding.scoreImpact : null;

    return {
      key: label.toLowerCase().replaceAll(" ", "_"),
      label,
      status: checkStatus(score),
      score,
      value: score === null ? "?" : score < 25 ? "+" : score >= 50 ? "!" : "review",
      reason: finding?.detail ?? "This Stellar check was unavailable.",
    };
  });
}

function riskLevel(score: number): RiskLevel {
  return scoreToRiskLevel(score);
}

function scoreFromSeverity(severity: RiskLevel) {
  return {
    low: 18,
    medium: 48,
    high: 76,
    critical: 94,
  }[severity];
}

function mapFindingToBreakdown(finding: AgentFinding): RiskBreakdownItem {
  const lowerLabel = finding.label.toLowerCase();
  const score = scoreFromSeverity(finding.severity);
  const key: RiskBreakdownItem["key"] = lowerLabel.includes("liquidity")
    ? "liquidity"
    : lowerLabel.includes("fdv")
      ? "liquidity"
    : lowerLabel.includes("volume") || lowerLabel.includes("volatility") || lowerLabel.includes("pair") || lowerLabel.includes("anomaly")
      ? "volatility"
      : lowerLabel.includes("creator") || lowerLabel.includes("selling")
        ? "whales"
      : lowerLabel.includes("news") || lowerLabel.includes("catalyst") || lowerLabel.includes("regulatory") || lowerLabel.includes("scam")
        ? "scam"
      : lowerLabel.includes("social") || lowerLabel.includes("phishing") || lowerLabel.includes("giveaway") || lowerLabel.includes("engagement")
        ? "xSentiment"
      : lowerLabel.includes("tax") || lowerLabel.includes("permission") || lowerLabel.includes("contract")
        ? "contract"
        : lowerLabel.includes("holder")
          ? "holders"
          : "scam";

  return {
    key,
    label: finding.label,
    score,
    severity: finding.severity,
    finding: finding.detail,
  };
}

function suggestedActionFromDecision(decisionResult: AgentResult): TokenScanResult["suggestedAction"] {
  if (decisionResult.recommendedAction === "avoid" || decisionResult.recommendedAction === "manual_review" || decisionResult.recommendedAction === "watch") {
    return {
      type: "hold",
      fromToken: "TOKEN",
      toToken: "USDC",
      percent: 0,
    };
  }

  if (decisionResult.recommendedAction === "reduce_exposure") {
    return {
      type: "reduce_exposure",
      fromToken: "TOKEN",
      toToken: "USDC",
      percent: 30,
    };
  }

  if (decisionResult.recommendedAction === "swap_to_stable") {
    return {
      type: "swap_to_stablecoin",
      fromToken: "TOKEN",
      toToken: "USDC",
      percent: 30,
    };
  }

  return {
    type: "hold",
    fromToken: "TOKEN",
    toToken: "USDC",
    percent: 0,
  };
}

function verdictFromScore(score: number): TokenScanResult["verdict"] {
  if (score >= 75) return "critical";
  if (score >= 50) return "high_risk";
  if (score >= 25) return "watch";
  return "safe";
}

function getDataQuality(sources: TokenScanResult["sources"]): TokenScanResult["dataQuality"] {
  const connectedSources = sources.filter((source) => source.status === "connected").length;
  const unavailableSources = sources.filter((source) => source.status === "unavailable").length;
  const mockSources = sources.filter((source) => source.status === "mock").length;
  const mode = connectedSources === 0 ? "unavailable" : unavailableSources > 0 || mockSources > 0 ? "partial" : "live";

  return {
    mode,
    connectedSources,
    unavailableSources,
    mockSources,
    sourceCount: sources.length,
    reliability:
      sources.length > 0
        ? sources.reduce((total, source) => {
            if (source.status === "connected") return total + 0.75;
            if (source.status === "mock") return total + 0.35;
            return total + 0.1;
          }, 0) / sources.length
        : 0,
    detail:
      mode === "live"
        ? "All scan signals came from connected live sources."
        : mode === "partial"
          ? "Some scan signals were unavailable. The verdict is conservative."
          : "No live scan source could resolve this token. Manual review is required.",
  };
}

function buildUnresolvedTokenScan(query: string, chain?: string): TokenScanResult {
  const sources: TokenScanResult["sources"] = [
    {
      label: "Input normalization",
      status: "unavailable",
      detail: "Input could not be resolved as an EVM contract address or DexScreener pair/token URL.",
    },
  ];

  const scannedAt = new Date().toISOString();
  const dataQuality = getDataQuality(sources);
  const normalizedInput = createRiskReportInput(query, chain, null);

  return {
    symbol: query.trim().slice(0, 16).toUpperCase() || "UNKNOWN",
    tokenAddress: "",
    chain: chain || "unknown",
    normalizedInput,
    overallRiskScore: 72,
    opportunityScore: 0,
    verdict: "high_risk",
    summary: "Token scan could not resolve this input through live token sources. No mock risk score was generated.",
    reasons: [
      "Input was not a valid EVM contract address.",
      "Input was not a supported DexScreener token or pair URL.",
      "Manual review is required before any wallet action.",
    ],
    suggestedAction: {
      type: "hold",
      fromToken: "TOKEN",
      toToken: "USDC",
      percent: 0,
    },
    riskBreakdown: [
      {
        key: "contract",
        label: "Input unresolved",
        score: 72,
        severity: "high",
        finding: "No live contract, liquidity, news or social scan was run because the token input could not be resolved.",
      },
    ],
    analysisChecks: unavailableCheckLabels.map((label) => ({
      key: label.toLowerCase().replaceAll(" ", "_"),
      label,
      status: "unavailable" as const,
      score: null,
      value: "?",
      reason: "This check could not run because the token input was unresolved.",
    })),
    sources,
    dataQuality,
    riskReport: {
      id: `risk_unresolved_${scannedAt.replace(/[^0-9]/g, "")}`,
      chain: normalizedInput.chain,
      symbol: query.trim().slice(0, 16).toUpperCase() || "UNKNOWN",
      buyRisk: 72,
      confidence: 0.18,
      verdict: "manual_review",
      summary: "Bu input desteklenen contract veya DexScreener linki olarak cozumlenemedi. Mock risk skoru uretilmedi; manuel inceleme gerekli.",
      topReasons: [
        "Input valid EVM contract address degil.",
        "Input desteklenen DexScreener token veya pair URL'i degil.",
        "Canli kaynak calismadigi icin alim guvenli kabul edilemez.",
      ],
      input: normalizedInput,
      agentCards: [],
      sources: [
        {
          label: "Input normalization",
          status: "unavailable",
          detail: "Input could not be resolved as an EVM contract address or DexScreener pair/token URL.",
        },
      ],
      missingData: [
        {
          field: "token identity",
          reason: "Contract address or DexScreener identity could not be resolved.",
          impact: "high",
          requiredFor: "risk report",
          canRetry: true,
          fallbackUsed: false,
        },
      ],
      createdAt: scannedAt,
    },
    scannedAt,
  };
}

export async function runTokenScan(query: string, chain?: string, walletAddress?: string): Promise<TokenScanResult> {
  const normalized = await normalizeTokenInput(query, chain);

  if (!normalized) {
    return buildUnresolvedTokenScan(query, chain);
  }

  const [onchainResult, newsResult, socialResult, portfolioResult] = await Promise.all([
    runAgentSafely("onchain", () =>
      runOnchainAgent({
        chain: normalized.chain,
        contractAddress: normalized.contractAddress,
        symbol: normalized.symbol,
        issuer: normalized.issuer,
        assetKey: normalized.assetKey,
        assetType: normalized.assetType,
      }),
    ),
    runAgentSafely("news", () =>
      runNewsAgent({
        symbol: normalized.symbol,
        tokenName: normalized.name,
        contractAddress: normalized.contractAddress,
      }),
    ),
    runAgentSafely("social", () =>
      runSocialAgent({
        symbol: normalized.symbol,
        tokenName: normalized.name,
        query: normalized.symbol ?? normalized.name ?? normalized.contractAddress,
        websiteUrl: normalized.links?.websiteUrl,
        twitterUrl: normalized.links?.twitterUrl,
        telegramUrl: normalized.links?.telegramUrl,
      }),
    ),
    runAgentSafely("portfolio", () =>
      runPortfolioAgent(walletAddress, {
        contractAddress: normalized.contractAddress,
        symbol: normalized.symbol,
      }),
    ),
  ]);
  const targetExposure = typeof portfolioResult.rawSignals?.targetTokenExposurePercent === "number" ? portfolioResult.rawSignals.targetTokenExposurePercent : 0;
  const includePortfolioContext = Boolean(walletAddress && targetExposure > 0 && portfolioResult.sources.some((source) => source.status === "connected"));
  const specialistResults = includePortfolioContext ? [onchainResult, newsResult, socialResult, portfolioResult] : [onchainResult, newsResult, socialResult];
  const stableReserve = portfolioResult.rawSignals?.portfolioRisk as { stableReservePercent?: unknown } | undefined;
  const establishedAsset = isVerifiedEstablishedAsset(normalized.symbol, normalized.chain, normalized.contractAddress);
  const decisionResult = runDecisionAgent({
    results: specialistResults,
    context: {
      mode: "token_scan",
      walletAddress,
      tokenSymbol: normalized.symbol,
      establishedAsset,
      userAlreadyOwnsToken: Boolean(walletAddress && targetExposure > 0),
      holdingAllocationPercent: targetExposure,
      stableReservePercent: typeof stableReserve?.stableReservePercent === "number" ? stableReserve.stableReservePercent : undefined,
    },
  });
  const overallRiskScore = decisionResult.score;
  const executionPreview = await buildExecutionPreview({
    action: decisionResult.recommendedAction,
    fromToken: normalized.symbol ?? "TOKEN",
    toToken: "USDC",
    percent: decisionResult.recommendedAction === "reduce_exposure" || decisionResult.recommendedAction === "swap_to_stable" ? 30 : 0,
    riskScore: overallRiskScore,
    network: normalized.chain,
    quoteAvailable: false,
    simulationStatus: overallRiskScore >= 50 ? "pending" : "not_required",
  });
  const combinedFindings = [
    ...decisionResult.findings,
    ...onchainResult.findings,
    ...newsResult.findings,
    ...socialResult.findings,
    ...(includePortfolioContext ? portfolioResult.findings : []),
  ];
  const riskBreakdown = combinedFindings.map(mapFindingToBreakdown);

  const sources: TokenScanResult["sources"] = [
    {
      label: "Input normalization",
      status: "connected",
      detail: `Parsed as ${normalized.source}${normalized.pairAddress ? ` from pair ${normalized.pairAddress}` : ""}.`,
    },
    ...onchainResult.sources.map((source) => ({
      label: source.label,
      status: source.status,
      detail: source.detail ?? "",
    })),
    ...newsResult.sources.map((source) => ({
      label: source.label,
      status: source.status,
      detail: source.detail ?? "",
    })),
    ...socialResult.sources.map((source) => ({
      label: source.label,
      status: source.status,
      detail: source.detail ?? "",
    })),
    ...(includePortfolioContext
      ? portfolioResult.sources.map((source) => ({
          label: source.label,
          status: source.status,
          detail: source.detail ?? "",
        }))
      : []),
    ...decisionResult.sources.map((source) => ({
      label: source.label,
      status: source.status,
      detail: source.detail ?? "",
    })),
  ];
  const dataQuality = getDataQuality(sources);
  const scannedAt = onchainResult.createdAt;
  const riskReport = buildRiskReport({
    query,
    requestedChain: chain,
    normalized,
    results: [onchainResult, newsResult, socialResult, ...(includePortfolioContext ? [portfolioResult] : []), decisionResult],
    decision: decisionResult,
    dataQuality,
    executionPreview,
    createdAt: scannedAt,
  });

  return {
    symbol: normalized.symbol ?? "TOKEN",
    tokenAddress: normalized.contractAddress,
    chain: normalized.chain,
    normalizedInput: riskReport.input,
    market: normalized.market,
    overallRiskScore,
    opportunityScore: Math.max(0, 100 - overallRiskScore),
    verdict: verdictFromScore(overallRiskScore),
    summary: `${decisionResult.summary} ${onchainResult.summary} ${newsResult.summary} ${socialResult.summary}${includePortfolioContext ? ` ${portfolioResult.summary}` : ""}`,
    reasons: combinedFindings.map((finding) => finding.detail).slice(0, 10),
    suggestedAction: suggestedActionFromDecision(decisionResult),
    riskBreakdown: riskBreakdown.length > 0
      ? riskBreakdown
      : [
          {
            key: "contract",
            label: "Token security",
            score: overallRiskScore,
            severity: riskLevel(overallRiskScore),
            finding: `${decisionResult.summary} ${onchainResult.summary} ${newsResult.summary} ${socialResult.summary}`,
          },
        ],
    analysisChecks: getChainFamily(normalized.chain) === "stellar"
      ? buildStellarAnalysisChecks(onchainResult)
      : buildAnalysisChecks(onchainResult, establishedAsset),
    sources,
    dataQuality,
    riskReport,
    scannedAt,
  };
}
