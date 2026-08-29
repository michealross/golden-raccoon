"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Check } from "lucide-react";
import { useWalletSession } from "@/hooks/useWalletSession";
import type { Alert, AlertSeverity } from "@/server/types";

type AlertResponse = {
  alerts: Array<Alert & { deliverySummary?: { delivered?: string[]; failed?: Array<{ channel: string; error: string }>; skipped?: Array<{ channel: string; reason: string }> } }>;
};

const severityTone: Record<AlertSeverity, { wrapper: string; icon: string }> = {
  low: { wrapper: "border-emerald-300/25 bg-emerald-300/8", icon: "text-emerald-200" },
  medium: { wrapper: "border-[#d9a441]/30 bg-[#d9a441]/8", icon: "text-[#f2c86d]" },
  high: { wrapper: "border-orange-300/25 bg-orange-300/8", icon: "text-orange-200" },
  critical: { wrapper: "border-red-300/30 bg-red-400/8", icon: "text-red-200" },
};

export function AlertCard() {
  const { address, isConnected } = useWalletSession();
  const [latest, setLatest] = useState<Alert | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acking, setAcking] = useState(false);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;

    fetch(`/api/alerts/alerts?walletAddress=${encodeURIComponent(address)}&status=triggered&limit=1`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Failed")))
      .then((payload: AlertResponse) => {
        if (cancelled) return;
        const head = payload.alerts[0];
        setLatest(head ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Latest alert unavailable.");
      });

    return () => {
      cancelled = true;
    };
  }, [address]);

  async function acknowledge() {
    if (!latest || !address) return;
    setAcking(true);
    setError(null);
    const response = await fetch(`/api/alerts/alerts/${latest.id}/acknowledge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress: address }),
    });
    setAcking(false);
    if (!response.ok) {
      setError("Could not acknowledge.");
      return;
    }
    setLatest(null);
  }

  if (!isConnected || !address) {
    return (
      <section className="rounded-[28px] border border-white/10 bg-black/40 p-6 text-sm text-white/46">
        Connect a wallet to see risk alerts in this space. Alert history lives at /alerts.
      </section>
    );
  }

  if (!latest) {
    return (
      <section className="rounded-[28px] border border-emerald-300/25 bg-emerald-300/8 p-6">
        <div className="flex items-start gap-4">
          <div className="rounded-full bg-emerald-300/12 p-3 text-emerald-200">
            <Check className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">No active alerts</h2>
            <p className="mt-1 text-sm text-white/58">No triggered alerts on the wallet right now. Visit the <a href="/alerts" className="underline">alerts page</a> to tune rules.</p>
          </div>
        </div>
      </section>
    );
  }

  const severity = latest.severity;
  const tone = severityTone[severity];

  return (
    <section className={`rounded-[28px] border p-6 ${tone.wrapper}`}>
      <div className="flex items-start gap-4">
        <div className={`rounded-full bg-white/8 p-3 ${tone.icon}`}>
          <AlertTriangle className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">Latest alert — {severity}</h2>
            <a href="/alerts" className="text-xs underline">Manage alerts</a>
          </div>
          <p className="mt-2 text-sm leading-6 text-white/78">{latest.message}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-white/62">
            <span>Trigger: {latest.triggerType}</span>
            <span>·</span>
            <span>{latest.observationKey || "catch-all"}</span>
            <span>·</span>
            <span>{new Date(latest.triggeredAt).toLocaleString()}</span>
          </div>
          {error ? <div className="mt-2 text-xs text-red-200">{error}</div> : null}
          <button
            type="button"
            disabled={acking}
            onClick={acknowledge}
            className="mt-4 inline-flex h-9 items-center gap-2 rounded-full border border-white/15 bg-black/30 px-4 text-xs font-semibold text-white/84 transition hover:text-white"
          >
            <Check className="h-3.5 w-3.5" />
            {acking ? "Acknowledging…" : "Acknowledge"}
          </button>
        </div>
      </div>
    </section>
  );
}