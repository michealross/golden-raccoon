import { z } from "zod";

export const riskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
export const agentStatusSchema = z.enum([
  "idle",
  "running",
  "complete",
  "partial",
  "warning",
  "error",
  "unavailable",
  "blocked",
  "manual_review_required",
]);
export const agentRecommendedActionSchema = z.enum([
  "hold",
  "watch",
  "reduce_exposure",
  "swap_to_stable",
  "avoid",
  "manual_review",
  "prepare_transaction",
  "create_trustline",
  "no_action",
]);

export const agentSourceSchema = z.object({
  label: z.string().min(1),
  url: z.string().optional(),
  status: z.enum(["mock", "connected", "unavailable"]),
  detail: z.string().optional(),
  checkedAt: z.string().optional(),
  latencyMs: z.number().optional(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
  provider: z.string().optional(),
  fallbackRank: z.number().optional(),
  cache: z
    .object({
      policy: z.string(),
      ttlSeconds: z.number(),
      hit: z.boolean().optional(),
      freshnessSeconds: z.number().optional(),
    })
    .optional(),
  reliability: z.number().min(0).max(1).optional(),
});

export const agentFindingSchema = z.object({
  label: z.string().min(1),
  severity: riskLevelSchema,
  detail: z.string().min(1),
  scoreImpact: z.number().min(0).max(100).optional(),
  weight: z.number().optional(),
  sourceLabel: z.string().min(1).optional(),
  raw: z.string().optional(),
  interpretation: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const agentMissingDataSchema = z.object({
  field: z.string().min(1),
  reason: z.string().min(1),
  impact: z.enum(["low", "medium", "high"]),
  requiredFor: z.string().optional(),
  canRetry: z.boolean().optional(),
  fallbackUsed: z.boolean().optional(),
});

export const agentBlockingReasonSchema = z.object({
  category: z.enum(["critical", "policy", "identity", "provider_coverage", "simulation"]),
  severity: riskLevelSchema,
  detail: z.string().min(1),
  sourceLabel: z.string().optional(),
});

export const sourceDataQualitySchema = z.object({
  mode: z.enum(["live", "partial", "unavailable", "stale", "conflicting"]),
  connectedSources: z.number(),
  unavailableSources: z.number(),
  mockSources: z.number(),
  sourceCount: z.number(),
  reliability: z.number(),
  lastCheckedAt: z.string().optional(),
  freshnessSeconds: z.number().optional(),
  averageLatencyMs: z.number().optional(),
  conflictCount: z.number().optional(),
  providerErrors: z.array(z.object({ label: z.string(), code: z.string().optional(), detail: z.string().optional() })).optional(),
  cache: z.object({ policy: z.string(), hitCount: z.number(), missCount: z.number(), staleCount: z.number() }).optional(),
  detail: z.string(),
});

export const agentResultSchema = z.object({
  agent: z.enum(["portfolio", "news", "social", "onchain", "decision", "execution"]),
  status: agentStatusSchema,
  riskScore: z.number().min(0).max(100),
  score: z.number().min(0).max(100),
  riskLevel: riskLevelSchema,
  verdict: z.string().min(1),
  summary: z.string().min(1),
  findings: z.array(agentFindingSchema),
  sources: z.array(agentSourceSchema),
  dataQuality: sourceDataQualitySchema,
  confidence: z.number().min(0).max(1),
  recommendedAction: agentRecommendedActionSchema,
  blockingReasons: z.array(z.string()),
  blockingReasonDetails: z.array(agentBlockingReasonSchema).optional(),
  missingData: z.array(agentMissingDataSchema),
  rawSignals: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string(),
});

export function validateAgentResult(value: unknown) {
  return agentResultSchema.safeParse(value);
}
