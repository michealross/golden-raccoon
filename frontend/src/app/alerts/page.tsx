import { Bell } from "lucide-react";
import { cookies } from "next/headers";
import { AppShell } from "@/components/AppShell";
import { AlertRuleForm } from "@/components/AlertRuleForm";
import { AlertHistoryList } from "@/components/AlertHistoryList";
import { ensureDefaultRulesForWallet } from "@/server/observability/alertIngestion";
import { ensureStorageReady, listAlertRules } from "@/server/storage";
import { decodeWalletCookie } from "@/server/security/walletSession";

// The page renders per-wallet alert rules + history. Reads MUST come
// from the server-controlled HttpOnly session cookie (audit #38:
// reliance on `searchParams.walletAddress` allowed any caller to pick
// an arbitrary wallet). The route is dynamic so `cookies()` returns
// the request-scoped store.
export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  const cookieJar = await cookies();
  const session = cookieJar.get("gr_wallet_session");
  const wallet = session ? decodeWalletCookie(session.value)?.toLowerCase() : undefined;

  // Hydrate alerts/alerts_rules/observations/deliveries from Postgres
  // before serving the page so a restart surface that has rows on disk
  // does not serve an empty list.
  await ensureStorageReady();

  if (wallet) ensureDefaultRulesForWallet(wallet);
  const rules = wallet ? listAlertRules(wallet) : [];

  return (
    <AppShell>
      <div className="space-y-5">
        <header className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[#d9a441]/35 bg-[#d9a441]/10 text-[#f2c86d]">
            <Bell className="h-5 w-5" />
          </div>
          <div>
            <div className="text-xs uppercase tracking-[0.18em] text-[#d9a441]">Alerts</div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">Alert rules + history</h1>
            <p className="mt-1 text-sm text-white/46">Decide which signals matter. Default rules activate on first read; tune thresholds below.</p>
          </div>
        </header>

        <section className="grid gap-5 lg:grid-cols-[1.05fr_.95fr]">
          <div className="space-y-4">
            <AlertRuleForm />
            <article className="glass-panel rounded-lg border border-white/10 p-5">
              <h2 className="text-xl font-semibold">Active rules ({rules.length})</h2>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {rules.length === 0 ? (
                  <p className="text-sm text-white/46">No rules yet. Connect your wallet and the defaults will seed themselves.</p>
                ) : null}
                {rules.map((rule) => (
                  <div key={rule.id} className={`rounded-2xl border p-3 text-sm ${rule.enabled ? "border-[#d9a441]/30 bg-[#d9a441]/6" : "border-white/10 bg-white/4 opacity-60"}`}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-semibold text-white">{labelForTrigger(rule.triggerType)}</span>
                      <span className="text-xs uppercase tracking-[0.18em] text-[#d9a441]">{rule.severity}</span>
                    </div>
                    <div className="mt-1 text-xs text-white/58">{rule.observationKey ? `Scoped to ${rule.observationKey}` : "Catch-all (every observation key)"}</div>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-[11px] text-white/62">
                      <div>
                        <div className="opacity-55">Threshold</div>
                        <div className="font-semibold text-white/86">{rule.threshold}</div>
                      </div>
                      <div>
                        <div className="opacity-55">Hysteresis</div>
                        <div className="font-semibold text-white/86">{rule.hysteresis}</div>
                      </div>
                      <div>
                        <div className="opacity-55">Cooldown</div>
                        <div className="font-semibold text-white/86">{rule.cooldownMinutes} min</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </article>
          </div>
          <div className="space-y-4">
            <AlertHistoryList />
          </div>
        </section>
      </div>
    </AppShell>
  );
}

function labelForTrigger(trigger: string): string {
  return trigger.replaceAll("_", " ");
}
