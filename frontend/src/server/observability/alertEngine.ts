import type {
  Alert,
  AlertDelivery,
  AlertObservation,
  AlertObservationDirection,
  AlertRule,
  AlertTriggerType,
} from "@/server/types";
import {
  createAlert,
  createAlertDelivery,
  listAlertObservations,
  listAlertRules,
  listAlerts,
  updateAlert,
  updateAlertDelivery,
} from "@/server/storage";
import { buildSanitizedAlertPayload } from "@/server/observability/alertSanitize";
import { deliverAlertToChannel } from "@/server/observability/alertDeliveries";

export type AlertEvaluation =
  | { outcome: "no_match"; reason: "rule_disabled" | "trigger_mismatch" | "key_mismatch" | "wallet_mismatch" | "cooldown" | "dedupe" | "below_threshold" | "no_history" | "incomplete_data"; observation: AlertObservation; rule: AlertRule; previousAlert?: Alert }
  | { outcome: "recovered"; observation: AlertObservation; rule: AlertRule; previousAlert: Alert; alert: Alert; deliveries: AlertDelivery[] }
  | { outcome: "deteriorated"; observation: AlertObservation; rule: AlertRule; previousAlert: Alert; alert: Alert }
  | { outcome: "triggered"; observation: AlertObservation; rule: AlertRule; alert: Alert; deliveries: AlertDelivery[] };

export type AlertEvaluationOutcome = AlertEvaluation["outcome"];

/**
 * Wallet-scope guard. Alert rules never cross wallets: a rule created
 * for wallet A is invisible to wallet B's observations. Returns true only
 * when both sides match (case-insensitive).
 */
export function ruleAppliesToObservation(
  rule: AlertRule,
  observation: Pick<AlertObservation, "walletAddress">,
): boolean {
  return rule.walletAddress.toLowerCase() === observation.walletAddress.toLowerCase();
}

/**
 * Stable 32-bit djb2-style hash for evidence objects. Used to fix the
 * before/after snapshot in storage so the UI can later attest to immutability.
 */
export function hashEvidence(evidence: AlertObservation["evidence"]): string {
  const payload = JSON.stringify(evidence, Object.keys(evidence).sort());
  let hash = 5381;

  for (let index = 0; index < payload.length; index += 1) {
    hash = (hash * 33) ^ payload.charCodeAt(index);
  }

  return `evh_${(hash >>> 0).toString(16)}`;
}

/**
 * Direction-aware threshold evaluation.
 *  - high_is_bad: bad when value >= threshold; recovered when value < threshold - hysteresis
 *  - low_is_bad: bad when value <= threshold; recovered when value > threshold + hysteresis
 *
 * Boundary values are intentionally treated as "still in the band" so that
 * hysteresis provides a true buffer zone.
 */
export function evaluateObservationVsRule(
  rule: Pick<AlertRule, "threshold" | "hysteresis" | "direction">,
  observation: Pick<AlertObservation, "value" | "direction">,
): { isBad: boolean; isRecovered: boolean } {
  const direction: AlertObservationDirection = rule.direction ?? observation.direction;
  const threshold = Number(rule.threshold);
  const hysteresis = Number.isFinite(rule.hysteresis) ? Math.max(0, rule.hysteresis) : 0;

  if (!Number.isFinite(threshold) || !Number.isFinite(observation.value)) {
    return { isBad: false, isRecovered: false };
  }

  if (direction === "low_is_bad") {
    return {
      isBad: observation.value <= threshold,
      isRecovered: observation.value > threshold + hysteresis,
    };
  }

  return {
    isBad: observation.value >= threshold,
    isRecovered: observation.value < Math.max(0, threshold - hysteresis),
  };
}

/**
 * Stable evidence fingerprint for dedupe decisions.
 */
function evidenceFingerprint(observation: AlertObservation): string {
  const sourceLabels = observation.evidence.sourceLabels ?? [];
  const meta = observation.evidence.meta
    ? JSON.stringify(observation.evidence.meta, Object.keys(observation.evidence.meta).sort())
    : "";

  return `${observation.evidence.runId}|${observation.evidence.label}|${sourceLabels.join("|")}|${meta}`;
}

function activeAlertFor(alerts: Alert[], ruleId: string, observationKey: string): Alert | undefined {
  return alerts.find(
    (alert) =>
      alert.ruleId === ruleId &&
      alert.observationKey === observationKey &&
      (alert.status === "triggered" || alert.status === "acknowledged"),
  );
}

function lastResolvedAlertFor(alerts: Alert[], ruleId: string, observationKey: string): Alert | undefined {
  return alerts.find(
    (alert) =>
      alert.ruleId === ruleId &&
      alert.observationKey === observationKey &&
      (alert.status === "recovered" || alert.status === "acknowledged"),
  );
}

function isInCooldown(rule: AlertRule, lastResolved: Alert | undefined, now: Date): boolean {
  if (!lastResolved) return false;
  // Cooldown is anchored to recovery or acknowledgement, never to the
  // original trigger. Worsening observations on an active alert therefore
  // remain free to deteriorate even within the cooldown window.
  const lastChange = [lastResolved.recoveredAt, lastResolved.acknowledgedAt]
    .filter((value): value is string => typeof value === "string")
    .map((value) => new Date(value).getTime())
    .reduce<number>((latest, current) => (current > latest ? current : latest), 0);

  if (!Number.isFinite(lastChange)) return false;

  const cooldownMs = Math.max(0, rule.cooldownMinutes) * 60_000;

  return now.getTime() - lastChange < cooldownMs;
}

function shouldDeteriorate(
  rule: Pick<AlertRule, "direction">,
  observation: Pick<AlertObservation, "value" | "direction">,
  previousAfter: number,
): boolean {
  if (!Number.isFinite(previousAfter) || !Number.isFinite(observation.value)) return false;

  const direction: AlertObservationDirection = rule.direction ?? observation.direction;

  if (direction === "low_is_bad") {
    return observation.value < previousAfter;
  }

  return observation.value > previousAfter;
}

function labelForTrigger(trigger: AlertTriggerType): string {
  switch (trigger) {
    case "critical_risk": return "Critical risk";
    case "liquidity_drop": return "Liquidity drop";
    case "holder_concentration_change": return "Holder concentration";
    case "tax_control_change": return "Tax / control change";
    case "phishing_detected": return "Phishing signal";
    case "exploit_news": return "Exploit news";
    case "portfolio_concentration": return "Portfolio concentration";
    case "stable_reserve_change": return "Stable reserve drop";
    case "stellar_issuer_auth": return "Stellar issuer auth";
    case "stellar_clawback": return "Stellar clawback enabled";
    case "stellar_trustline": return "Stellar trustline risk";
    case "stellar_contract_ttl": return "Stellar contract TTL risk";
    case "rpc_degradation": return "Source degradation";
    default: return "Risk signal";
  }
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  if (Math.abs(value) >= 10_000) return Math.round(value).toLocaleString("en-US");
  if (Number.isInteger(value)) return String(value);

  return value.toFixed(2);
}

export function buildAlertMessage(
  rule: Pick<AlertRule, "triggerType">,
  observation: Pick<AlertObservation, "observationKey" | "value">,
  direction: AlertObservationDirection,
): string {
  const base = labelForTrigger(rule.triggerType);

  if (direction === "low_is_bad") {
    return `${base} dropped to ${formatNumber(observation.value)} (${observation.observationKey}).`;
  }

  return `${base} reached ${formatNumber(observation.value)} (${observation.observationKey}).`;
}

type EngineDecision =
  | "rule_disabled"
  | "trigger_mismatch"
  | "key_mismatch"
  | "wallet_mismatch"
  | "recovered"
  | "below_threshold"
  | "dedupe"
  | "deteriorate"
  | "cooldown"
  | "trigger"
  | "incomplete_data";

export type DecisionResult = {
  decision: EngineDecision;
  activeAlert?: Alert;
  lastResolved?: Alert;
  reasoning: string;
};

/**
 * Pure decision function: returns a single next action for the persistence
 * layer to apply. No storage side-effects.
 */
export function decideObservation(
  observation: AlertObservation,
  rule: AlertRule,
  now: Date = new Date(),
): DecisionResult {
  const matchesKey = !rule.observationKey || rule.observationKey === observation.observationKey;

  if (!rule.enabled) return { decision: "rule_disabled", reasoning: "Rule disabled." };
  if (rule.triggerType !== observation.triggerType) return { decision: "trigger_mismatch", reasoning: "Trigger type mismatch." };
  if (!ruleAppliesToObservation(rule, observation)) return { decision: "wallet_mismatch", reasoning: "Wallet scope mismatch." };
  if (!matchesKey) return { decision: "key_mismatch", reasoning: "Observation key mismatch." };

  // Risk observations derived from agent results with unavailable providers
  // are tagged `incompleteData: true` at extraction time. Even when their
  // raw signal crosses a threshold, they must never promote to alerts
  // because the underlying data is missing. The `rpc_degradation`
  // observation is the canonical signal for that condition and is the
  // sole observation allowed to flow through when complete data is
  // unavailable.
  if (observation.incompleteData && observation.triggerType !== "rpc_degradation") {
    return { decision: "incomplete_data", reasoning: "Observation derived from an incomplete result (unavailable provider)." };
  }

  const evaluation = evaluateObservationVsRule(rule, observation);
  const walletAlerts = listAlerts(observation.walletAddress);
  const activeAlert = activeAlertFor(walletAlerts, rule.id, observation.observationKey);
  const lastResolved = lastResolvedAlertFor(walletAlerts, rule.id, observation.observationKey);

  if (activeAlert && evaluation.isRecovered) {
    return { decision: "recovered", activeAlert, ...(lastResolved ? { lastResolved } : {}), reasoning: "Active alert cleared hysteresis." };
  }
  if (!evaluation.isBad) {
    return { decision: "below_threshold", ...(activeAlert ? { activeAlert } : {}), reasoning: "Observation below threshold." };
  }
  if (activeAlert) {
    const sameEvidence = activeAlert.evidenceAfter
      ? evidenceFingerprint(observation) === evidenceFingerprint({ ...observation, evidence: activeAlert.evidenceAfter, id: activeAlert.id } as AlertObservation)
      : false;
    const sameValue = activeAlert.afterValue === observation.value;
    const deteriorates = shouldDeteriorate(rule, observation, activeAlert.afterValue);

    if ((sameEvidence || sameValue) && !deteriorates) {
      return { decision: "dedupe", activeAlert, reasoning: "Identical evidence/value pair; dedupe." };
    }
    if (!deteriorates) {
      return { decision: "dedupe", activeAlert, reasoning: "Value still bad but evidence value pair seen before." };
    }

    return { decision: "deteriorate", activeAlert, reasoning: "Worsening evidence for active alert." };
  }
  if (isInCooldown(rule, lastResolved, now)) {
    return { decision: "cooldown", ...(lastResolved ? { lastResolved } : {}), reasoning: "Cooldown window still active." };
  }

  return { decision: "trigger", reasoning: "New trigger outside cooldown." };
}

/**
 * Persist the engine's decision. Updates an active alert (recovery /
 * deterioration) or creates a fresh alert + delivery rows.
 *
 * Immutability contract:
 *  - On trigger: alert is born with `evidenceBefore` from the prior
 *    observation (or a "no prior" placeholder) and `evidenceAfter` from
 *    the current observation. Both observation IDs and hashes are stored
 *    on the alert row.
 *  - On deterioration: `evidenceBefore` is NEVER overwritten. We append
 *    the new observation to `deteriorationObservationIds`, refresh only
 *    the latest snapshot (`evidenceAfter`) so the UI can render the
 *    current "After" view, and update `afterValue` / hashes.
 *  - On recovery: status flips to recovered; chain remains intact.
 */
export function evaluateAndPersistObservation(
  observation: AlertObservation,
  rule: AlertRule,
): AlertEvaluation {
  const now = new Date();
  const decision = decideObservation(observation, rule, now);

  switch (decision.decision) {
    case "rule_disabled":
      return { outcome: "no_match", reason: "rule_disabled", observation, rule };
    case "trigger_mismatch":
      return { outcome: "no_match", reason: "trigger_mismatch", observation, rule };
    case "wallet_mismatch":
      return { outcome: "no_match", reason: "wallet_mismatch", observation, rule };
    case "key_mismatch":
      return { outcome: "no_match", reason: "key_mismatch", observation, rule };
    case "below_threshold":
      return { outcome: "no_match", reason: "below_threshold", observation, rule, ...(decision.activeAlert ? { previousAlert: decision.activeAlert } : {}) };
    case "dedupe":
      return { outcome: "no_match", reason: "dedupe", observation, rule, previousAlert: decision.activeAlert as Alert };
    case "cooldown":
      return { outcome: "no_match", reason: "cooldown", observation, rule, ...(decision.lastResolved ? { previousAlert: decision.lastResolved } : {}) };
    case "incomplete_data":
      return { outcome: "no_match", reason: "incomplete_data", observation, rule };
    case "recovered":
    case "deteriorate":
    case "trigger":
      break;
  }

  if (decision.decision === "recovered") {
    const recoveredAlert = updateAlert(decision.activeAlert!.id, observation.walletAddress, {
      status: "recovered",
      recoveredAt: now.toISOString(),
    });

    if (!recoveredAlert) {
      return { outcome: "no_match", reason: "below_threshold", observation, rule, previousAlert: decision.activeAlert };
    }
    const deliveries = fanOutDeliveries(recoveredAlert, observation);

    return { outcome: "recovered", observation, rule, previousAlert: decision.activeAlert!, alert: recoveredAlert, deliveries };
  }

  if (decision.decision === "deteriorate") {
    const previous = decision.activeAlert!;
    const chain = [...(previous.evidenceData.deteriorationObservationIds ?? [])];
    if (!chain.includes(observation.id)) chain.push(observation.id);
    const afterHash = hashEvidence(observation.evidence);

    const updated = updateAlert(previous.id, observation.walletAddress, {
      afterValue: observation.value,
      evidenceAfter: observation.evidence,
      message: buildAlertMessage(rule, observation, observation.direction),
      evidenceData: {
        ...previous.evidenceData,
        evidenceAfterObservationId: observation.id,
        sourceSnapshotHashAfter: observation.evidence.sourceSnapshotHash ?? `obs_hash_${observation.id}`,
        evidenceAfterHash: afterHash,
        deteriorationObservationIds: chain,
      },
    });

    if (!updated) {
      return { outcome: "no_match", reason: "dedupe", observation, rule, previousAlert: previous };
    }

    return { outcome: "deteriorated", observation, rule, previousAlert: previous, alert: updated };
  }

  // decision === "trigger": build a fresh alert + fan out deliveries.
  const walletObservations = listAlertObservations(observation.walletAddress).filter(
    (stored) => stored.observationKey === observation.observationKey && stored.id !== observation.id,
  );
  const previousObservation = walletObservations[0];
  const beforeEvidence = previousObservation
    ? previousObservation.evidence
    : { ...observation.evidence, label: "no prior observation", detail: "first trigger" };
  const beforeObservationId = previousObservation?.id;
  const beforeHash = previousObservation ? hashEvidence(previousObservation.evidence) : hashEvidence(beforeEvidence);
  const afterHash = hashEvidence(observation.evidence);
  const alert = createAlert({
    walletAddress: observation.walletAddress,
    ruleId: rule.id,
    triggerType: rule.triggerType,
    observationKey: observation.observationKey,
    status: "triggered",
    severity: rule.severity,
    message: buildAlertMessage(rule, observation, observation.direction),
    beforeValue: previousObservation?.value ?? observation.value,
    afterValue: observation.value,
    evidenceBefore: beforeEvidence,
    evidenceAfter: observation.evidence,
    evidenceData: {
      runId: observation.evidence.runId,
      observationId: observation.id,
      evidenceBeforeObservationId: beforeObservationId,
      evidenceAfterObservationId: observation.id,
      sourceSnapshotHashAfter: observation.evidence.sourceSnapshotHash ?? `obs_hash_${observation.id}`,
      ...(previousObservation?.evidence.sourceSnapshotHash ? { sourceSnapshotHashBefore: previousObservation.evidence.sourceSnapshotHash } : {}),
      evidenceBeforeHash: beforeHash,
      evidenceAfterHash: afterHash,
      deteriorationObservationIds: [observation.id],
    },
  });
  const deliveries = fanOutDeliveries(alert, observation);

  return { outcome: "triggered", observation, rule, alert, deliveries };
}

/**
 * Fan-out delivery to every channel. Persists each delivery row, returning
 * the final state. UI helpers read from the storage layer.
 */
export function fanOutDeliveries(alert: Alert, observation: AlertObservation): AlertDelivery[] {
  const sanitized = buildSanitizedAlertPayload(alert, observation.evidence, { walletAddressHint: alert.walletAddress });
  const channels = ["in_app", "email", "telegram", "discord"] as const;
  const out: AlertDelivery[] = [];

  for (const channel of channels) {
    const created = createAlertDelivery({
      alertId: alert.id,
      walletAddress: alert.walletAddress,
      channel,
      status: "pending",
      sanitizedPayload: sanitized,
      attemptCount: 0,
    });
    const result = deliverAlertToChannel(channel, sanitized, alert);
    const updated = updateAlertDelivery(created.id, alert.walletAddress, {
      status: result.status,
      ...(result.errorDetail ? { errorDetail: result.errorDetail } : {}),
      ...(result.status === "delivered" ? { sentAt: new Date().toISOString() } : {}),
      attemptCount: result.attemptCount ?? 0,
    });

    out.push(updated ?? created);
  }

  return out;
}

export function listEnabledRulesForEvaluation(walletAddress?: string) {
  return listAlertRules(walletAddress).filter((rule) => rule.enabled);
}
