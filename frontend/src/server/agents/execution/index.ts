import type { AgentRecommendedAction, AgentResult, PortfolioSnapshot, StellarSwapQuote, TransactionPreview, UserRule } from "@/server/types";
import { buildAgentResult } from "@/server/agents/shared";
import { buildExecutionPolicy, evaluateExecutionPolicy } from "@/server/agents/execution/policy";
import { getChainFamily } from "@/lib/chainIdentity";
import { buildTrustlinePreview, type TrustlineCheckInput } from "@/server/stellar/trustline";
import { getStellarSwapQuote } from "@/server/stellar/swap";

type ExecutionAgentInput = {
  action?: AgentRecommendedAction | string;
  walletAddress?: string;
  decisionId?: string;
  fromToken?: string;
  toToken?: string;
  percent?: number;
  riskScore?: number;
  estimatedValueUsd?: number;
  network?: string;
  slippageBps?: number;
  priceImpactBps?: number;
  gasEstimateUsd?: number;
  quoteAvailable?: boolean;
  expectedOutputAmount?: number;
  simulationStatus?: NonNullable<TransactionPreview["simulation"]>["status"];
  simulationRevertReason?: string;
  rules?: UserRule;
  // Stellar-specific input fields
  stellarAssetCode?: string;
  stellarIssuer?: string;
  stellarFromIssuer?: string;
  stellarToIssuer?: string;
  stellarSwapAmount?: number;
  stellarQuoteStatus?: "fresh" | "stale" | "unavailable" | "simulated";
};

function clampPercent(percent?: number) {
  if (typeof percent !== "number" || !Number.isFinite(percent)) {
    return 0;
  }

  return Math.min(100, Math.max(0, percent));
}

function normalizeAction(action?: string): AgentRecommendedAction {
  if (action === "swap_to_stablecoin") {
    return "swap_to_stable";
  }

  if (
    action === "hold" ||
    action === "watch" ||
    action === "reduce_exposure" ||
    action === "swap_to_stable" ||
    action === "avoid" ||
    action === "manual_review" ||
    action === "prepare_transaction" ||
    action === "create_trustline" ||
    action === "no_action"
  ) {
    return action;
  }

  return "no_action";
}

function getActionPlan(action: AgentRecommendedAction) {
  if (action === "hold") return { txAction: "no_action" as const, title: "Hold position", requiresTrade: false, detail: "No transaction is required for hold." };
  if (action === "watch") return { txAction: "watchlist" as const, title: "Add to watchlist/log", requiresTrade: false, detail: "Watch creates an audit/log action only." };
  if (action === "reduce_exposure") return { txAction: "swap" as const, title: "Reduce exposure", requiresTrade: true, detail: "Prepare a partial sell/swap route." };
  if (action === "swap_to_stable") return { txAction: "swap" as const, title: "Swap to stablecoin", requiresTrade: true, detail: "Prepare a stablecoin route." };
  if (action === "avoid") return { txAction: "no_action" as const, title: "Avoid token", requiresTrade: false, detail: "No buy transaction should be prepared." };
  if (action === "manual_review") return { txAction: "no_action" as const, title: "Manual review required", requiresTrade: false, detail: "Manual review blocks transaction preparation." };
  if (action === "prepare_transaction") return { txAction: "swap" as const, title: "Prepare transaction", requiresTrade: true, detail: "Prepare a user-approved transaction preview." };
  if (action === "create_trustline") return { txAction: "trustline" as const, title: "Create trustline", requiresTrade: false, detail: "Prepare a trustline transaction for a Stellar asset." };

  return { txAction: "no_action" as const, title: "No action", requiresTrade: false, detail: "No transaction is required." };
}

function estimateProjectedRisk(currentRiskScore: number, percent: number) {
  const reduction = Math.round(percent * 0.6);

  return Math.max(0, currentRiskScore - reduction);
}

function getSimulationPlan(input: {
  requiresTrade: boolean;
  isStellar?: boolean;
  simulationStatus?: NonNullable<TransactionPreview["simulation"]>["status"];
  revertReason?: string;
}): NonNullable<TransactionPreview["simulation"]> {
  if (!input.requiresTrade) {
    return {
      provider: "not_required",
      status: "not_required",
      checks: ["No blockchain transaction required for this action."],
      detail: "Simulation is not required.",
    };
  }

  if (input.isStellar) {
    return {
      provider: "stellar_soroban",
      status: input.simulationStatus ?? "pending",
      checks: ["Soroban swap simulation", "Classic path payment simulation", "Footprint verification", "Fee estimation"],
      revertReason: input.revertReason,
      detail:
        input.simulationStatus === "failed"
          ? input.revertReason ?? "Stellar swap simulation failed."
          : "Stellar swap simulation via Soroban RPC is planned before confirmation.",
    };
  }

  return {
    provider: "planned_tenderly",
    status: input.simulationStatus ?? "pending",
    checks: ["Approval simulation", "Sell/swap simulation", "Revert reason capture", "Slippage and tax sanity check"],
    revertReason: input.revertReason,
    detail:
      input.simulationStatus === "failed"
        ? input.revertReason ?? "Simulation failed."
        : "Tenderly or equivalent simulation is planned before confirmation. Pending simulation blocks unsafe confidence but still allows preview display.",
  };
}

function getQuotePlan(input: {
  requiresTrade: boolean;
  isStellar?: boolean;
  fromToken: string;
  toToken: string;
  estimatedValueUsd: number;
  slippageBps: number;
  priceImpactBps: number;
  gasEstimateUsd: number;
  quoteAvailable?: boolean;
  expectedOutputAmount?: number;
}): NonNullable<TransactionPreview["quote"]> | undefined {
  if (!input.requiresTrade) {
    return undefined;
  }

  return {
    provider: input.isStellar ? "stellar_aggregator" : "planned_dex_aggregator",
    route: [input.fromToken, input.toToken],
    expectedOutputToken: input.toToken,
    expectedOutputAmount: input.expectedOutputAmount,
    estimatedValueUsd: input.estimatedValueUsd,
    priceImpactBps: input.priceImpactBps,
    slippageBps: input.slippageBps,
    gasEstimateUsd: input.gasEstimateUsd,
    status: input.quoteAvailable ? (input.isStellar ? "fresh" : "planned") : "unavailable",
    detail: input.quoteAvailable
      ? input.isStellar
        ? "Stellar DEX aggregator quote is fresh for user review."
        : "DEX aggregator quote fields are present for user review."
      : "No live quote provider result is available; this plan is not executable.",
  };
}

export async function buildExecutionPreview(input: ExecutionAgentInput): Promise<TransactionPreview> {
  const executionPolicy = buildExecutionPolicy(input.rules);
  const action = normalizeAction(input.action);
  const plan = getActionPlan(action);
  const percent = clampPercent(input.percent ?? (plan.requiresTrade ? 20 : 0));
  const currentRiskScore = Math.min(100, Math.max(0, Math.round(input.riskScore ?? 0)));
  const fromToken = input.fromToken ?? "TOKEN";
  const toToken = input.toToken ?? "USDC";
  const estimatedValueUsd = input.estimatedValueUsd ?? 0;
  const slippageBps = input.slippageBps ?? executionPolicy.maxSlippageBps;
  const priceImpactBps = input.priceImpactBps ?? (estimatedValueUsd > 5_000 ? 180 : estimatedValueUsd > 1_000 ? 75 : 25);
  const gasEstimateUsd = input.gasEstimateUsd ?? (plan.requiresTrade ? 3.5 : 0);
  const isStellar = getChainFamily(input.network) === "stellar";

  const simulation = getSimulationPlan({
    requiresTrade: plan.requiresTrade,
    isStellar,
    simulationStatus: input.simulationStatus,
    revertReason: input.simulationRevertReason,
  });
  const policyStatus = evaluateExecutionPolicy(
    {
      action,
      percent,
      riskScore: currentRiskScore,
      network: input.network,
      fromToken,
      toToken,
      estimatedValueUsd,
      slippageBps,
      simulationStatus: simulation.status,
    },
    executionPolicy,
  );
  const quote = getQuotePlan({
    requiresTrade: plan.requiresTrade,
    isStellar,
    fromToken,
    toToken,
    estimatedValueUsd,
    slippageBps,
    priceImpactBps,
    gasEstimateUsd,
    quoteAvailable: input.quoteAvailable,
    expectedOutputAmount: input.expectedOutputAmount,
  });
  const trustlineAction = action === "create_trustline";
  let stellarTrustlinePreview = undefined;
  let stellarSwapQuote: StellarSwapQuote | undefined = undefined;

  // Wire in Stellar trustline preview for trustline actions
  if (trustlineAction && isStellar && input.walletAddress && input.stellarAssetCode && input.stellarIssuer) {
    try {
      const tlInput: TrustlineCheckInput = {
        chain: input.network ?? "",
        assetCode: input.stellarAssetCode,
        issuer: input.stellarIssuer,
        walletAddress: input.walletAddress,
      };
      const tlResult = await buildTrustlinePreview(tlInput);
      stellarTrustlinePreview = tlResult.preview;
    } catch {
      // Trustline preview unavailable, continue with generic preview
    }
  }

  // Wire in Stellar swap quote for trade actions on Stellar
  if (!trustlineAction && plan.requiresTrade && isStellar && input.walletAddress && input.fromToken && input.toToken && input.stellarSwapAmount) {
    try {
      const quoteResult = await getStellarSwapQuote({
        chain: input.network ?? "stellar-testnet",
        walletAddress: input.walletAddress,
        fromAsset: input.fromToken,
        toAsset: input.toToken,
        fromIssuer: input.stellarFromIssuer,
        toIssuer: input.stellarToIssuer,
        amount: input.stellarSwapAmount,
        slippageBps: input.slippageBps,
      });
      if (quoteResult.quote) {
        stellarSwapQuote = quoteResult.quote;
      }
    } catch {
      // Stellar quote unavailable, continue with generic quote plan
    }
  }

  const quoteMissing = !trustlineAction && plan.requiresTrade && quote?.status !== "planned" && quote?.status !== "fresh";
  const blockedReason = policyStatus.violations[0] ?? (
    (input.stellarQuoteStatus === "unavailable" && !stellarSwapQuote && !trustlineAction)
      ? "Live Stellar swap quote is required before preparing an executable transaction."
      : quoteMissing
        ? "Live quote provider result is required before preparing an executable transaction."
        : undefined
  );
  const executionReady = plan.requiresTrade && policyStatus.allowed && !quoteMissing;
  const idempotencyKey = input.decisionId ? `${input.walletAddress ?? "unknown"}:${input.decisionId}:${action}:${fromToken}:${toToken}:${percent}` : undefined;
  const preview: TransactionPreview = {
    title: blockedReason
      ? "Transaction blocked by policy"
      : trustlineAction
        ? `Create trustline for ${input.stellarAssetCode ?? fromToken}:${input.stellarIssuer ?? ""}`
        : plan.requiresTrade
          ? `${plan.title}: ${percent}% ${fromToken} to ${toToken}`
          : plan.title,
    action: trustlineAction ? "trustline" : plan.txAction,
    fromToken,
    toToken,
    percent,
    estimatedValueUsd,
    currentRiskScore,
    projectedRiskScore: plan.requiresTrade && executionReady ? estimateProjectedRisk(currentRiskScore, percent) : currentRiskScore,
    requiresApproval: trustlineAction ? executionReady : executionReady,
    executionReady,
    network: input.network ?? "GOAT Network",
    slippageBps,
    priceImpactBps,
    gasEstimateUsd,
    policy: {
      maxTradePercent: executionPolicy.maxTradePercent,
      maxRiskScore: executionPolicy.maxRiskScoreForTrade,
      maxMemeExposurePercent: executionPolicy.maxMemeExposurePercent,
      maxDailyTransactionValueUsd: executionPolicy.maxDailyTransactionValueUsd,
      maxSlippageBps: executionPolicy.maxSlippageBps,
      allowedChains: executionPolicy.allowedChains,
      blockedTokens: executionPolicy.blockedTokens,
      allowedActions: Array.from(executionPolicy.allowedActions),
      autoExecute: false,
    },
    policyStatus,
    quote,
    simulation,
    stellarTrustline: stellarTrustlinePreview,
    stellarQuote: stellarSwapQuote,
    approvalRisk: {
      infiniteApprovalWarning: plan.requiresTrade && !trustlineAction,
      existingAllowanceCheck: plan.requiresTrade && !trustlineAction ? "required" : "not_required",
      revokeSuggestion: plan.requiresTrade && !trustlineAction ? `Review and revoke unused ${fromToken} allowance after execution.` : undefined,
      permitSupport: trustlineAction ? "unsupported" : "planned",
      permit2Support: trustlineAction ? "unsupported" : "planned",
    },
    lifecycle: {
      status: blockedReason ? "expired" : "prepared",
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      idempotencyKey,
    },
    audit: {
      approvalRequired: executionReady,
      serverCanSign: false,
      userRuleWallet: executionPolicy.walletAddress,
      userApproved: false,
      decisionId: input.decisionId,
    },
    approvalSteps: trustlineAction
      ? ["Review issuer risk and clawback flags", "Review reserve requirements", "Approve trustline creation in connected wallet", "Save transaction hash after broadcast"]
      : plan.requiresTrade
        ? ["Review agent reasoning", "Review quote and policy status", "Run/confirm simulation", "Approve in connected wallet", "Save transaction hash after broadcast"]
        : [plan.detail],
  };

  if (blockedReason) {
    preview.blockedReason = blockedReason;
  }

  return preview;
}

export async function buildExecutionPreviewFromPortfolio(portfolio: PortfolioSnapshot, input: ExecutionAgentInput): Promise<TransactionPreview> {
  const fromToken = input.fromToken ?? portfolio.holdings.find((holding) => holding.riskScore >= 70)?.symbol ?? portfolio.holdings[0]?.symbol ?? "TOKEN";
  const percent = clampPercent(input.percent ?? 30);
  const holding = portfolio.holdings.find((item) => item.symbol === fromToken);
  const estimatedValueUsd = input.estimatedValueUsd ?? (holding ? holding.valueUsd * (percent / 100) : 0);

  return buildExecutionPreview({
    ...input,
    fromToken,
    toToken: input.toToken ?? "USDC",
    percent,
    estimatedValueUsd,
    riskScore: input.riskScore ?? portfolio.riskScore,
    network: input.network ?? portfolio.holdings.find((item) => item.symbol === fromToken)?.chainName ?? "GOAT Network",
  });
}

export async function runExecutionAgent(input: ExecutionAgentInput): Promise<AgentResult> {
  const action = normalizeAction(input.action);
  const preview = await buildExecutionPreview(input);
  const blocked = Boolean(preview.blockedReason);
  const policyViolations = preview.policyStatus?.violations ?? [];
  const score = blocked ? 76 : preview.requiresApproval ? 38 : 18;

  return buildAgentResult({
    agent: "execution",
    score,
    verdict: blocked ? "Execution blocked by policy" : preview.requiresApproval ? "Approval required" : "No transaction required",
    summary: blocked
      ? preview.blockedReason ?? "Execution policy blocked this plan."
      : preview.requiresApproval
        ? `Prepared approval-only ${action.replaceAll("_", " ")} plan. Auto-execute is disabled.`
        : "No wallet transaction is required for this action.",
    findings: [
      {
        label: "Approval-only guard",
        severity: "low",
        detail: "Auto-execute is disabled. The server cannot sign; every blockchain action requires explicit user wallet approval.",
      },
      {
        label: "Policy evaluation",
        severity: policyViolations.length > 0 ? "high" : "low",
        detail: policyViolations.length > 0 ? policyViolations.join(" ") : "Action, trade size, risk score, chain, slippage and token policy checks passed.",
      },
      {
        label: "Quote provider plan",
        severity: preview.quote?.status === "unavailable" ? "high" : preview.quote ? "medium" : "low",
        detail: preview.quote?.detail ?? "No quote required for this action.",
      },
      {
        label: "Approval risk analysis",
        severity: preview.approvalRisk?.infiniteApprovalWarning ? "medium" : "low",
        detail: preview.approvalRisk?.infiniteApprovalWarning
          ? `${preview.approvalRisk.existingAllowanceCheck} allowance check. ${preview.approvalRisk.revokeSuggestion ?? ""} Permit support ${preview.approvalRisk.permitSupport}; Permit2 ${preview.approvalRisk.permit2Support}.`
          : "No token approval risk for this non-transaction action.",
        raw: JSON.stringify(preview.approvalRisk),
      },
      {
        label: "Transaction lifecycle",
        severity: preview.lifecycle?.status === "expired" || preview.lifecycle?.status === "failed" ? "medium" : "low",
        detail: `Lifecycle status ${preview.lifecycle?.status ?? "prepared"}; duplicate prepare key ${preview.lifecycle?.idempotencyKey ?? "not supplied"}.`,
        raw: JSON.stringify(preview.lifecycle),
      },
      {
        label: "Simulation plan",
        severity: preview.simulation?.status === "failed" ? "high" : preview.simulation?.status === "pending" ? "medium" : "low",
        detail: preview.simulation?.detail ?? "No simulation status available.",
      },
    ],
    sources: [
      {
        label: "Execution policy",
        status: "connected",
        detail: "Local approval-only policy loaded from user rules. No transaction is sent by the server.",
      },
      {
        label: "Quote provider",
        status: preview.quote ? "unavailable" : "connected",
        detail: preview.quote?.detail ?? "Quote provider not required for non-transaction action.",
      },
      {
        label: "Simulation provider",
        status: preview.simulation?.status === "not_required" ? "connected" : "unavailable",
        detail: preview.simulation?.detail ?? "Simulation provider status unavailable.",
      },
    ],
    confidence: blocked ? 0.7 : preview.requiresApproval ? 0.66 : 0.74,
    recommendedAction: preview.requiresApproval ? "prepare_transaction" : "no_action",
    blockingReasons: policyViolations,
    rawSignals: {
      preview,
      policyStatus: preview.policyStatus,
      quote: preview.quote,
      simulation: preview.simulation,
      approvalRisk: preview.approvalRisk,
      lifecycle: preview.lifecycle,
      approvalOnly: {
        autoExecute: false,
        serverCanSign: false,
        userWalletApprovalRequired: preview.requiresApproval,
      },
      semiAutoFuturePolicy: {
        autoBuy: false,
        sellReduceOnlyWithExplicitOptIn: true,
        dailyLimitRequired: true,
        allowlistRequired: true,
        emergencyPauseRequired: true,
        everyTransactionAudited: true,
      },
    },
  });
}
