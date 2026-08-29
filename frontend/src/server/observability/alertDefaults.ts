import type { AlertRule, AlertSeverity, AlertTriggerType } from "@/server/types";

export type AlertRuleDefault = {
  triggerType: AlertTriggerType;
  threshold: number;
  hysteresis: number;
  cooldownMinutes: number;
  direction: "high_is_bad" | "low_is_bad";
  severity: AlertSeverity;
  label: string;
  defaultEnabled: boolean;
};

/**
 * The Golden Raccoon default rule set. Defaults intentionally leave
 * `observationKey` undefined so they act as catch-alls for the trigger type
 * (e.g. every onchain:0x… key under the wallet will be evaluated against the
 * rule). Users can add narrower, observationKey-bound rules via the API.
 */
export const defaultAlertRuleDefinitions: AlertRuleDefault[] = [
  { triggerType: "critical_risk", threshold: 75, hysteresis: 5, cooldownMinutes: 30, direction: "high_is_bad", severity: "critical", label: "Critical risk score", defaultEnabled: true },
  { triggerType: "liquidity_drop", threshold: 50_000, hysteresis: 10_000, cooldownMinutes: 60, direction: "low_is_bad", severity: "high", label: "Onchain liquidity drop", defaultEnabled: true },
  { triggerType: "holder_concentration_change", threshold: 60, hysteresis: 5, cooldownMinutes: 120, direction: "high_is_bad", severity: "high", label: "Holder concentration spike", defaultEnabled: true },
  { triggerType: "tax_control_change", threshold: 1, hysteresis: 0.5, cooldownMinutes: 120, direction: "high_is_bad", severity: "critical", label: "Tax / privileged control change", defaultEnabled: true },
  { triggerType: "phishing_detected", threshold: 1, hysteresis: 0.5, cooldownMinutes: 240, direction: "high_is_bad", severity: "critical", label: "Phishing / drainer signal", defaultEnabled: true },
  { triggerType: "exploit_news", threshold: 1, hysteresis: 0.5, cooldownMinutes: 60, direction: "high_is_bad", severity: "high", label: "Exploit / hack news matched", defaultEnabled: true },
  { triggerType: "portfolio_concentration", threshold: 60, hysteresis: 5, cooldownMinutes: 120, direction: "high_is_bad", severity: "high", label: "Portfolio concentration", defaultEnabled: true },
  { triggerType: "stable_reserve_change", threshold: 5, hysteresis: 2, cooldownMinutes: 240, direction: "low_is_bad", severity: "medium", label: "Stable reserve drop", defaultEnabled: true },
  { triggerType: "stellar_issuer_auth", threshold: 1, hysteresis: 0.5, cooldownMinutes: 60, direction: "high_is_bad", severity: "high", label: "Stellar issuer auth flag", defaultEnabled: true },
  { triggerType: "stellar_clawback", threshold: 1, hysteresis: 0.5, cooldownMinutes: 60, direction: "high_is_bad", severity: "critical", label: "Stellar clawback enabled", defaultEnabled: true },
  { triggerType: "stellar_trustline", threshold: 0.5, hysteresis: 0.5, cooldownMinutes: 120, direction: "high_is_bad", severity: "high", label: "Stellar trustline risk", defaultEnabled: true },
  { triggerType: "stellar_contract_ttl", threshold: 0.66, hysteresis: 0.33, cooldownMinutes: 360, direction: "high_is_bad", severity: "medium", label: "Stellar contract TTL nearing expiry", defaultEnabled: true },
  { triggerType: "rpc_degradation", threshold: 1, hysteresis: 0.5, cooldownMinutes: 30, direction: "high_is_bad", severity: "high", label: "Source / RPC degradation", defaultEnabled: true },
];

export function getDefaultAlertRulesForSeeder(seed: () => string): AlertRule[] {
  const now = new Date().toISOString();

  return defaultAlertRuleDefinitions.map((definition) => ({
    id: seed(),
    walletAddress: "",
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
  }));
}
