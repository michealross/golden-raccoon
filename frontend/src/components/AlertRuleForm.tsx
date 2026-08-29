"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import type { AlertRule, AlertSeverity, AlertTriggerType } from "@/server/types";
import { useWalletSession } from "@/hooks/useWalletSession";

const triggerOptions: Array<{ value: AlertTriggerType; label: string; description: string; direction: "high_is_bad" | "low_is_bad" }> = [
  { value: "critical_risk", label: "Critical risk", description: "Trigger when AgentResult.riskScore ≥ threshold.", direction: "high_is_bad" },
  { value: "liquidity_drop", label: "Liquidity drop", description: "Trigger when onchain pair liquidity ≤ threshold USD.", direction: "low_is_bad" },
  { value: "holder_concentration_change", label: "Holder concentration", description: "Trigger when top-5 holder % ≥ threshold.", direction: "high_is_bad" },
  { value: "tax_control_change", label: "Tax / control change", description: "Trigger when privileged control flags ≥ threshold.", direction: "high_is_bad" },
  { value: "phishing_detected", label: "Phishing", description: "Trigger on critical phishing signal.", direction: "high_is_bad" },
  { value: "exploit_news", label: "Exploit news", description: "Trigger on matching exploit/hack news.", direction: "high_is_bad" },
  { value: "portfolio_concentration", label: "Portfolio concentration", description: "Trigger when largest holding % ≥ threshold.", direction: "high_is_bad" },
  { value: "stable_reserve_change", label: "Stable reserve drop", description: "Trigger when verified stables % ≤ threshold.", direction: "low_is_bad" },
  { value: "stellar_issuer_auth", label: "Stellar issuer auth", description: "Trigger when issuer auth flags are restrictive.", direction: "high_is_bad" },
  { value: "stellar_clawback", label: "Stellar clawback", description: "Trigger when clawback flag is set on issuer.", direction: "high_is_bad" },
  { value: "stellar_trustline", label: "Stellar trustline risk", description: "Trigger when trustline is revocable.", direction: "high_is_bad" },
  { value: "stellar_contract_ttl", label: "Stellar contract TTL", description: "Trigger when ledger TTL buffer < threshold.", direction: "high_is_bad" },
  { value: "rpc_degradation", label: "Source degradation", description: "Trigger when the number of unavailable providers ≥ threshold.", direction: "high_is_bad" },
];

const severityOptions: Array<{ value: AlertSeverity; label: string; tone: string }> = [
  { value: "low", label: "Low", tone: "border-emerald-300/30 bg-emerald-300/8 text-emerald-200" },
  { value: "medium", label: "Medium", tone: "border-[#d9a441]/35 bg-[#d9a441]/10 text-[#f2c86d]" },
  { value: "high", label: "High", tone: "border-orange-300/35 bg-orange-300/10 text-orange-200" },
  { value: "critical", label: "Critical", tone: "border-red-300/35 bg-red-400/8 text-red-200" },
];

type FormState = {
  triggerType: AlertTriggerType;
  observationKey: string;
  threshold: number;
  hysteresis: number;
  cooldownMinutes: number;
  severity: AlertSeverity;
  enabled: boolean;
  direction: "high_is_bad" | "low_is_bad";
};

function getDefaultState(trigger: AlertTriggerType): FormState {
  const meta = triggerOptions.find((option) => option.value === trigger) ?? triggerOptions[0];

  return {
    triggerType: trigger,
    observationKey: "",
    threshold: meta.direction === "low_is_bad" ? 25_000 : 75,
    hysteresis: meta.direction === "low_is_bad" ? 5_000 : 5,
    cooldownMinutes: 60,
    severity: meta.value === "critical_risk" || meta.value === "tax_control_change" || meta.value === "phishing_detected" || meta.value === "stellar_clawback" ? "critical" : meta.value === "rpc_degradation" ? "high" : "medium",
    enabled: true,
    direction: meta.direction,
  };
}

export function AlertRuleForm({ initialRule, onSaved }: { initialRule?: AlertRule; onSaved?: () => void }) {
  const router = useRouter();
  const { address, isConnected } = useWalletSession();
  const [state, setState] = useState<FormState>(initialRule ? {
    triggerType: initialRule.triggerType,
    observationKey: initialRule.observationKey ?? "",
    threshold: initialRule.threshold,
    hysteresis: initialRule.hysteresis,
    cooldownMinutes: initialRule.cooldownMinutes,
    severity: initialRule.severity,
    enabled: initialRule.enabled,
    direction: initialRule.direction ?? "high_is_bad",
  } : getDefaultState("critical_risk"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isConnected || !address) {
      setError("Connect your wallet to save an alert rule.");

      return;
    }
    setSaving(true);
    setError(null);
    setSavedAt(null);
    const response = await fetch("/api/alerts/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletAddress: address,
        triggerType: state.triggerType,
        observationKey: state.observationKey.trim() || undefined,
        threshold: state.threshold,
        hysteresis: state.hysteresis,
        cooldownMinutes: state.cooldownMinutes,
        direction: state.direction,
        severity: state.severity,
        enabled: state.enabled,
      }),
    });
    setSaving(false);

    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { error?: unknown };

      setError(typeof detail.error === "string" ? detail.error : "Could not save rule.");
      return;
    }
    setSavedAt(new Date().toISOString());
    onSaved?.();
    router.refresh();
  }

  const trigger = triggerOptions.find((option) => option.value === state.triggerType) ?? triggerOptions[0];

  return (
    <form onSubmit={submit} className="glass-panel rounded-lg border border-white/10 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xl font-semibold">New alert rule</h2>
        <span className="text-xs uppercase tracking-[0.18em] text-[#d9a441]">{state.severity} severity</span>
      </div>
      <p className="mt-1 text-sm text-white/46">{trigger.description}</p>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-sm text-white/64">Trigger</span>
          <select
            value={state.triggerType}
            onChange={(event) => {
              const next = event.target.value as AlertTriggerType;
              const defaults = getDefaultState(next);

              setState((current) => ({ ...current, ...defaults, triggerType: next }));
            }}
            className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/30 px-3 text-sm text-white outline-none focus:border-[#d9a441]/60"
          >
            {triggerOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label} ({option.direction === "low_is_bad" ? "lower bound" : "upper bound"})
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-sm text-white/64">Observation key (optional)</span>
          <input
            value={state.observationKey}
            onChange={(event) => setState((current) => ({ ...current, observationKey: event.target.value }))}
            placeholder="e.g. onchain:0xC02aaA…"
            className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/30 px-3 text-sm text-white outline-none placeholder:text-white/28 focus:border-[#d9a441]/60"
          />
        </label>

        <label className="block">
          <span className="flex items-center justify-between text-sm text-white/64">
            <span>Threshold</span>
            <span className="font-medium text-[#d9a441]">{state.threshold}</span>
          </span>
          <input
            type="range"
            min={state.direction === "low_is_bad" ? 0 : 0}
            max={state.direction === "low_is_bad" ? 5_000_000 : 100}
            step={state.direction === "low_is_bad" ? 5_000 : 1}
            value={state.threshold}
            onChange={(event) => setState((current) => ({ ...current, threshold: Number(event.target.value) }))}
            className="mt-3 w-full accent-[#d9a441]"
          />
        </label>

        <label className="block">
          <span className="flex items-center justify-between text-sm text-white/64">
            <span>Hysteresis</span>
            <span className="font-medium text-[#d9a441]">{state.hysteresis}</span>
          </span>
          <input
            type="range"
            min={0}
            max={state.direction === "low_is_bad" ? 500_000 : 25}
            step={state.direction === "low_is_bad" ? 5_000 : 0.5}
            value={state.hysteresis}
            onChange={(event) => setState((current) => ({ ...current, hysteresis: Number(event.target.value) }))}
            className="mt-3 w-full accent-[#d9a441]"
          />
        </label>

        <label className="block">
          <span className="flex items-center justify-between text-sm text-white/64">
            <span>Cooldown minutes</span>
            <span className="font-medium text-[#d9a441]">{state.cooldownMinutes}</span>
          </span>
          <input
            type="range"
            min={0}
            max={1440}
            step={5}
            value={state.cooldownMinutes}
            onChange={(event) => setState((current) => ({ ...current, cooldownMinutes: Number(event.target.value) }))}
            className="mt-3 w-full accent-[#d9a441]"
          />
        </label>

        <label className="block">
          <span className="text-sm text-white/64">Severity</span>
          <div className="mt-2 flex flex-wrap gap-2">
            {severityOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setState((current) => ({ ...current, severity: option.value }))}
                className={`rounded-full border px-3 py-1.5 text-xs transition ${state.severity === option.value ? option.tone : "border-white/10 bg-white/5 text-white/44 hover:text-white/72"}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </label>

        <label className="flex items-center gap-3 text-sm text-white/64">
          <input
            type="checkbox"
            checked={state.enabled}
            onChange={(event) => setState((current) => ({ ...current, enabled: event.target.checked }))}
            className="h-4 w-4 rounded border-white/20 bg-black/30 accent-[#d9a441]"
          />
          Rule is enabled
        </label>
      </div>

      <div className="mt-6 flex items-center gap-3">
        <button
          type="submit"
          disabled={saving || !isConnected}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-[#d9a441] px-6 text-sm font-semibold text-black transition hover:bg-[#f2c86d] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "Saving…" : initialRule ? "Save changes" : "Create rule"}
        </button>
        {error ? <span className="text-sm text-red-200">{error}</span> : null}
        {savedAt ? <span className="text-sm text-emerald-200">Saved {new Date(savedAt).toLocaleTimeString()}</span> : null}
      </div>
    </form>
  );
}
