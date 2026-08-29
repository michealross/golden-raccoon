import type { Alert, AlertDelivery, AlertObservation, AlertTriggerType } from "@/server/types";

const FORBIDDEN_KEY_PATTERNS: RegExp[] = [
  /private[_]?key/i,
  /mnemonic/i,
  /\bseed\b/i,
  /authorization/i,
  /bearer/i,
];

const VALUE_SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\b0x[0-9a-fA-F]{8,}\b/g,
  /\bapi[_-]?key\s*=\s*\S+/gi,
  /\bBEGIN (PRIVATE|EC|RSA) KEY\b/,
];

const TRUNCATED_FIELDS = new Set(["detail", "label", "message", "summary"]);

function isForbiddenKey(field: string): boolean {
  return FORBIDDEN_KEY_PATTERNS.some((pattern) => pattern.test(field));
}

function valueLeaksSecret(value: string): boolean {
  return VALUE_SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

function shouldKeep(field: string, value: unknown): boolean {
  if (isForbiddenKey(field)) return false;
  if (typeof value === "string" && valueLeaksSecret(value)) return false;

  return true;
}

function trimString(field: string, value: string): string {
  if (!TRUNCATED_FIELDS.has(field)) return value;

  return value.length > 240 ? `${value.slice(0, 237)}…` : value;
}

function sanitize(field: string, value: unknown): unknown {
  if (!shouldKeep(field, value)) return undefined;

  if (typeof value === "string") {
    return trimString(field, value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (value === null) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitize(field, entry)).filter((entry) => entry !== undefined);
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = sanitize(key, child);

      if (sanitized !== undefined) {
        out[key] = sanitized;
      }
    }

    return out;
  }

  return undefined;
}

/**
 * Produces a sanitized payload safe to send to in-app, email, Telegram,
 * or Discord channels. Wallet addresses are replaced with stable short
 * hints; secrets + tokens in object keys AND string values are stripped.
 */
export function buildSanitizedAlertPayload(
  alert: Pick<Alert, "triggerType" | "observationKey" | "severity" | "message" | "beforeValue" | "afterValue" | "triggeredAt">,
  observation: AlertObservation["evidence"] | undefined,
  options: { walletAddressHint?: string } = {},
): AlertDelivery["sanitizedPayload"] {
  const sanitizedEvidence = observation ? sanitize("evidence", observation) : {};
  const summary = alert.message;
  const evidenceLinks: string[] = [];
  const sourceLabels = Array.isArray((sanitizedEvidence as { sourceLabels?: unknown }).sourceLabels)
    ? ((sanitizedEvidence as { sourceLabels?: unknown }).sourceLabels as unknown[]).filter((entry): entry is string => typeof entry === "string")
    : [];

  if (observation?.sourceSnapshotHash) {
    evidenceLinks.push(`source-snapshot:${observation.sourceSnapshotHash}`);
  }
  if (observation?.runId) {
    evidenceLinks.push(`agent-run:${observation.runId}`);
  }

  const triggerType: AlertTriggerType = alert.triggerType;

  return {
    triggerType,
    severity: alert.severity,
    summary: trimString("summary", summary),
    beforeValue: alert.beforeValue,
    afterValue: alert.afterValue,
    observationKey: alert.observationKey,
    evidenceLinks,
    ...(sourceLabels.length > 0 ? { sourceLabels } : {}),
    ...(options.walletAddressHint ? { walletHint: shortWalletHint(options.walletAddressHint) } : {}),
  };
}

/**
 * Generate a short, non-reversible hint for a wallet address. The full
 * wallet address is never included in any outbound delivery payload.
 */
export function shortWalletHint(walletAddress: string): string {
  const trimmed = walletAddress.trim();
  const tail = trimmed.slice(-4);

  return `wallet:…${tail}`;
}

/**
 * Replace forbidden fields with a short hint inside structured evidence.
 */
export function redactWalletAddressInEvidence(evidence: AlertObservation["evidence"] | undefined): AlertObservation["evidence"] | undefined {
  if (!evidence) return undefined;
  const sanitized = sanitize("evidence", evidence) as AlertObservation["evidence"];

  return {
    ...sanitized,
    sourceLabels: Array.isArray(evidence.sourceLabels) ? evidence.sourceLabels.slice(0, 5) : [],
  };
}
