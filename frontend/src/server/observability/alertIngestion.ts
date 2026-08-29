import type { AgentRunRecord, AlertObservation, AlertRule } from "@/server/types";
import type { AlertEvaluation } from "@/server/observability/alertEngine";
import { extractObservationsForRun } from "@/server/observability/observations";
import { createAlertObservation, ensureStorageReady, upsertAlertRule } from "@/server/storage";
import { evaluateAndPersistObservation, listEnabledRulesForEvaluation } from "@/server/observability/alertEngine";
import { defaultAlertRuleDefinitions } from "@/server/observability/alertDefaults";

export type { AlertEvaluation };

export type IngestResult = {
  persistedObservationIds: string[];
  evaluations: AlertEvaluation[];
  skippedCount: number;
};

/**
 * Persist all observations for an AgentRunRecord under the wallet, then
 * evaluate and persist Alerts + Deliveries for each observation/rule pair.
 *
 * Designed to be fire-and-forget so the route handler can return quickly:
 * the caller schedules it via `Promise.resolve().then(...)` or `after()`.
 *
 * The method is async because it awaits the optional Postgres hydration gate
 * (`ensureStorageReady`) so that persisted rules, observations, alerts, and
 * deliveries from prior runs are loaded into memory before the current
 * batch is evaluated against them. Without this initial guard the engine
 * would see empty rule/alert stores after a restart, produce no alerts for
 * the first few ingests, and lose the durability guarantee.
 *
 * It also calls `ensureDefaultRulesForWallet` before rule lookup so that
 * a wallet that has never visited the alerts page still has rules seeded
 * and can receive degradation / risk alerts on its first agent run.
 */
export async function ingestAgentRunAlerts(record: AgentRunRecord): Promise<IngestResult> {
  if (!record || !record.walletAddress) {
    return { persistedObservationIds: [], evaluations: [], skippedCount: 0 };
  }

  const walletAddress = record.walletAddress.trim().toLowerCase();

  // Hydrate persisted data from Postgres before reading rules/observations.
  await ensureStorageReady();

  // Ensure default rules exist for this wallet before evaluating
  // observations. Without this, a wallet that has never visited the alerts
  // page would have no rules seeded, so all observations (including
  // rpc_degradation from unavailable providers) would silently produce no
  // alerts.
  ensureDefaultRulesForWallet(walletAddress);

  const observations: AlertObservation[] = extractObservationsForRun(record);
  const persistedObservationIds: string[] = [];
  const evaluations: AlertEvaluation[] = [];
  const rules = listEnabledRulesForEvaluation(walletAddress);

  for (const observation of observations) {
    const persisted = createAlertObservation({
      walletAddress,
      triggerType: observation.triggerType,
      observationKey: observation.observationKey,
      value: observation.value,
      direction: observation.direction,
      evidence: observation.evidence,
    });
    persistedObservationIds.push(persisted.id);

    for (const rule of rules) {
      const evaluation = evaluateAndPersistObservation(persisted, rule);
      evaluations.push(evaluation);
    }
  }

  return {
    persistedObservationIds,
    evaluations,
    skippedCount: observations.length === 0 ? 1 : 0,
  };
}

/**
 * Schedule run-side effect without blocking the caller. Used by route
 * handlers: drop the promise and let Node complete the chain asynchronously.
 */
export function scheduleIngestion(record: AgentRunRecord): void {
  void Promise.resolve().then(() => ingestAgentRunAlerts(record)).catch(() => undefined);
}

/**
 * Lazy default rule seeder. When a wallet has no rules yet, persist the
 * default rule set scoped to that wallet. Idempotent: if any rule already
 * exists for the wallet, skip.
 */
export function ensureDefaultRulesForWallet(walletAddress: string): AlertRule[] {
  const normalized = walletAddress.trim().toLowerCase();

  if (!normalized) return [];

  const existing = listEnabledRulesForEvaluation(normalized);

  if (existing.length > 0) return existing;

  const now = new Date().toISOString();
  const seeded: AlertRule[] = [];

  for (const definition of defaultAlertRuleDefinitions) {
    const idempotencyKey = `${normalized}::${definition.triggerType}`;
    const rule: AlertRule = {
      id: `default_${idempotencyKey}`,
      walletAddress: normalized,
      triggerType: definition.triggerType,
      observationKey: undefined,
      threshold: definition.threshold,
      hysteresis: definition.hysteresis,
      cooldownMinutes: definition.cooldownMinutes,
      direction: definition.direction,
      severity: definition.severity,
      enabled: definition.defaultEnabled,
      createdAt: now,
      updatedAt: now,
    };
    const persisted = upsertAlertRule(rule);
    seeded.push(persisted);
  }

  return seeded;
}
