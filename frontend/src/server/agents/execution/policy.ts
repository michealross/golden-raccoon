import type { AgentRecommendedAction, UserRule } from "@/server/types";
import { getDefaultRules } from "@/server/rules/defaultRules";
import { getChainFamily } from "@/lib/chainIdentity";

export type StellarPolicyOverrides = {
  allowedIssuers?: string[];
  blockClawbackIssuers: boolean;
  blockRevocableIssuers: boolean;
  maxTrustlineReserveXlm: number;
  minXlmReserve: number;
};

export type ExecutionPolicy = {
  autoExecute: false;
  maxTradePercent: number;
  maxRiskScoreForTrade: number;
  maxMemeExposurePercent: number;
  maxDailyTransactionValueUsd: number;
  maxSlippageBps: number;
  allowedChains: string[];
  blockedTokens: string[];
  allowedActions: Set<AgentRecommendedAction>;
  walletAddress: string;
  stellar: StellarPolicyOverrides;
};

export type ExecutionPolicyInput = {
  action: AgentRecommendedAction;
  percent: number;
  riskScore: number;
  network?: string;
  fromToken?: string;
  toToken?: string;
  estimatedValueUsd?: number;
  slippageBps?: number;
  simulationStatus?: "not_required" | "pending" | "passed" | "failed" | "unavailable";
  // Stellar-specific trustline fields
  stellarIssuer?: string;
  stellarIssuerClawback?: boolean;
  stellarIssuerRevocable?: boolean;
  stellarReserveRequiredXlm?: number;
  stellarCurrentXlmBalance?: number;
  stellarQuoteStatus?: "fresh" | "stale" | "unavailable" | "simulated";
};

function uniqueStrings(values: string[] | undefined, fallback: string[]) {
  return Array.from(new Set((values?.length ? values : fallback).map((value) => value.trim()).filter(Boolean)));
}

function getDefaultStellarPolicy(): StellarPolicyOverrides {
  return {
    allowedIssuers: undefined,
    blockClawbackIssuers: true,
    blockRevocableIssuers: true,
    maxTrustlineReserveXlm: 5,
    minXlmReserve: 1.5,
  };
}

export function buildExecutionPolicy(rules?: UserRule): ExecutionPolicy {
  const safeRules = rules ?? getDefaultRules();
  const defaultRules = getDefaultRules(safeRules.walletAddress);

  return {
    autoExecute: false,
    maxTradePercent: safeRules.maxTradePercent,
    maxRiskScoreForTrade: safeRules.maxRiskScore,
    maxMemeExposurePercent: safeRules.maxMemeExposurePercent,
    maxDailyTransactionValueUsd: safeRules.maxDailyTransactionValueUsd ?? defaultRules.maxDailyTransactionValueUsd ?? 1_000,
    maxSlippageBps: safeRules.maxSlippageBps ?? defaultRules.maxSlippageBps ?? 100,
    allowedChains: uniqueStrings(safeRules.allowedChains, defaultRules.allowedChains ?? ["GOAT Network"]),
    blockedTokens: uniqueStrings(safeRules.blockedTokens, []),
    allowedActions: new Set(safeRules.allowedActions ?? defaultRules.allowedActions ?? ["reduce_exposure", "swap_to_stable", "prepare_transaction", "create_trustline", "watch", "hold", "no_action"]),
    walletAddress: safeRules.walletAddress,
    stellar: getDefaultStellarPolicy(),
  };
}

function normalized(value?: string) {
  return value?.trim().toLowerCase();
}

function isStellarChain(chain?: string) {
  return getChainFamily(chain) === "stellar";
}

export function evaluateExecutionPolicy(input: ExecutionPolicyInput, policy: ExecutionPolicy) {
  const violations: string[] = [];
  const tradeAction = input.action === "swap_to_stable" || input.action === "reduce_exposure" || input.action === "prepare_transaction";

  if (policy.autoExecute) {
    violations.push("Auto-execute is disabled. User wallet approval is mandatory.");
  }

  if (!policy.allowedActions.has(input.action)) {
    violations.push(`Action ${input.action} is not allowed by execution policy.`);
  }

  if (input.action === "avoid" || input.action === "manual_review") {
    violations.push(`Action ${input.action.replaceAll("_", " ")} cannot prepare a transaction until the user reviews the risk.`);
  }

  if (input.percent > policy.maxTradePercent) {
    violations.push(`Requested ${input.percent}% exceeds max trade percent ${policy.maxTradePercent}%.`);
  }

  if (tradeAction && input.riskScore > policy.maxRiskScoreForTrade) {
    violations.push(`Risk score ${input.riskScore} exceeds max trade risk threshold ${policy.maxRiskScoreForTrade}.`);
  }

  if (typeof input.estimatedValueUsd === "number" && input.estimatedValueUsd > policy.maxDailyTransactionValueUsd) {
    violations.push(`Estimated value $${Math.round(input.estimatedValueUsd).toLocaleString("en-US")} exceeds daily transaction value limit $${policy.maxDailyTransactionValueUsd.toLocaleString("en-US")}.`);
  }

  if (typeof input.slippageBps === "number" && input.slippageBps > policy.maxSlippageBps) {
    violations.push(`Slippage ${input.slippageBps} bps exceeds max slippage ${policy.maxSlippageBps} bps.`);
  }

  if (input.network && policy.allowedChains.length > 0 && !policy.allowedChains.map(normalized).includes(normalized(input.network))) {
    violations.push(`Network ${input.network} is not in allowed chains.`);
  }

  const blockedTokens = policy.blockedTokens.map(normalized);
  for (const token of [input.fromToken, input.toToken]) {
    if (token && blockedTokens.includes(normalized(token))) {
      violations.push(`Token ${token} is blocked by user policy.`);
    }
  }

  if (input.simulationStatus === "failed") {
    violations.push("Simulation failed. Confirmation is blocked until the issue is resolved.");
  }

  // Stellar-specific policy checks
  if (isStellarChain(input.network)) {
    // Trustline creation is only allowed for Stellar chains
    if (input.action === "create_trustline") {
      if (typeof input.stellarIssuer === "string") {
        const allowedIssuers = policy.stellar.allowedIssuers;

        if (allowedIssuers && allowedIssuers.length > 0) {
          const normalizedIssuer = input.stellarIssuer.trim().toUpperCase();

          if (!allowedIssuers.map((i) => i.trim().toUpperCase()).includes(normalizedIssuer)) {
            violations.push(`Issuer ${input.stellarIssuer} is not in the allowed issuer list.`);
          }
        }

        if (input.stellarIssuerClawback === true && policy.stellar.blockClawbackIssuers) {
          violations.push(`Issuer ${input.stellarIssuer} has clawback enabled, which is blocked by policy.`);
        }

        if (input.stellarIssuerRevocable === true && policy.stellar.blockRevocableIssuers) {
          violations.push(`Issuer ${input.stellarIssuer} has revocable authorization, which is blocked by policy.`);
        }
      }

      if (typeof input.stellarReserveRequiredXlm === "number") {
        if (input.stellarReserveRequiredXlm > policy.stellar.maxTrustlineReserveXlm) {
          violations.push(`Trustline reserve ${input.stellarReserveRequiredXlm} XLM exceeds max trustline reserve ${policy.stellar.maxTrustlineReserveXlm} XLM.`);
        }

        if (typeof input.stellarCurrentXlmBalance === "number") {
          const availableXlm = input.stellarCurrentXlmBalance - input.stellarReserveRequiredXlm;

          if (availableXlm < policy.stellar.minXlmReserve) {
            violations.push(`Insufficient XLM reserve: ${availableXlm.toFixed(2)} XLM available after trustline, needs at least ${policy.stellar.minXlmReserve} XLM.`);
          }
        }
      }
    }

    // For Stellar swaps, require a fresh quote
    if (input.action === "swap_to_stable" || input.action === "reduce_exposure" || input.action === "prepare_transaction") {
      if (input.stellarQuoteStatus === "unavailable") {
        violations.push("Stellar swap requires a fresh quote before execution preparation.");
      }

      if (input.stellarQuoteStatus === "stale") {
        violations.push("The Stellar swap quote is stale. A fresh quote must be obtained.");
      }
    }
  } else if (input.action === "create_trustline") {
    violations.push("Trustline creation is only supported on Stellar networks.");
  }

  return {
    allowed: violations.length === 0,
    violations,
  };
}

export function getBlockedReason(action: AgentRecommendedAction, percent: number, riskScore: number, policy: ExecutionPolicy) {
  return evaluateExecutionPolicy({ action, percent, riskScore }, policy).violations[0];
}
