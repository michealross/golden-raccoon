import type { UserRule } from "../types";

export function getDefaultRules(walletAddress = "0xDemoWallet"): UserRule {
  return {
    walletAddress,
    maxRiskScore: 80,
    maxTradePercent: 20,
    maxMemeExposurePercent: 10,
    maxDailyTransactionValueUsd: 1_000,
    maxSlippageBps: 100,
    allowedChains: ["GOAT Network", "Base", "Ethereum", "Arbitrum", "Optimism", "Polygon", "BSC", "Stellar Testnet", "Stellar Pubnet"],
    blockedTokens: [],
    allowedActions: ["hold", "watch", "reduce_exposure", "swap_to_stable", "prepare_transaction", "no_action"],
    autoExecute: false,
    createdAt: new Date().toISOString(),
  };
}
