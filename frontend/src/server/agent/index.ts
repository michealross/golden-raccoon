import type { AgentDecision, AgentStep, PortfolioSnapshot, TransactionPreview } from "../types";
import { analyzePortfolio } from "./analyze";
import { decideAction } from "./decide";
import { observePortfolio, observeDiscoveryCandidates } from "./observe";
import { planTransaction } from "./plan";

export type AgentAnalysisResult = {
  steps: AgentStep[];
  decision: AgentDecision;
  preview: TransactionPreview;
};

export function runGoldRaccoonAgent(portfolio: PortfolioSnapshot): AgentAnalysisResult {
  const observeStep = observePortfolio(portfolio);
  const discoveryStep = observeDiscoveryCandidates();
  const analyzeStep = analyzePortfolio(portfolio);
  const { step: decideStep, decision } = decideAction(portfolio);
  const { step: planStep, preview } = planTransaction(portfolio, decision);

  return {
    steps: [
      observeStep,
      ...(discoveryStep ? [discoveryStep] : []),
      analyzeStep,
      decideStep,
      planStep,
      {
        key: "act",
        label: "Act",
        status: "pending",
        detail: "Waiting for explicit wallet approval. Auto-execute is disabled in MVP.",
      },
    ],
    decision,
    preview,
  };
}

export function getMockDecisionHistory(walletAddress = "0xDemoWallet"): AgentDecision[] {
  return [
    {
      walletAddress,
      summary: "Reduced MEME exposure recommendation.",
      riskScore: 87,
      decision: "Move 30% MEME exposure into USDC.",
      reasoning: ["Whale selling high.", "Liquidity falling.", "Negative sentiment detected."],
      suggestedAction: {
        type: "swap_to_stablecoin",
        fromToken: "MEME",
        toToken: "USDC",
        percent: 30,
      },
      confidence: 0.78,
      status: "approved",
      txHash: "0x9f3a...d21c",
      createdAt: new Date(Date.now() - 1000 * 60 * 38).toISOString(),
    },
    {
      walletAddress,
      summary: "Held GOAT position after stable liquidity read.",
      riskScore: 34,
      decision: "Hold current GOAT allocation.",
      reasoning: ["Liquidity stable.", "No major whale exits.", "Portfolio exposure remains acceptable."],
      suggestedAction: {
        type: "hold",
        fromToken: "GOAT",
        toToken: "USDC",
        percent: 0,
      },
      confidence: 0.69,
      status: "rejected",
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 7).toISOString(),
    },
  ];
}
