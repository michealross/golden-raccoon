import Link from "next/link";
import { AlertCard } from "@/components/AlertCard";
import { scanDiscoveryCandidate } from "@/server/discovery/pipeline";
import { rescanWatchlistEntry } from "@/server/discovery/watchlist";
import { listDiscoveryAlerts, listWatchlistEntries, listWatchlistScanRuns } from "@/server/storage";
import type { DiscoveryAlert, DiscoveryClassification, DiscoveryScanResult, RiskLevel, WatchlistEntry, WatchlistScanRun } from "@/server/types";

export const dynamic = "force-dynamic";

const DEFAULT_WALLET = "0xDemoWallet";

const classificationTone: Record<DiscoveryClassification, string> = {
  watch: "border-sky-500/60 bg-sky-500/5 text-sky-300",
  risky: "border-amber-500/60 bg-amber-500/5 text-amber-300",
  scam: "border-rose-500/60 bg-rose-500/5 text-rose-300",
  early_opportunity: "border-emerald-500/60 bg-emerald-500/5 text-emerald-300",
};

const severityTone: Record<RiskLevel, string> = {
  low: "text-sky-300",
  medium: "text-amber-300",
  high: "text-orange-300",
  critical: "text-rose-400",
};

type ScanPageSearchParams = {
  chain?: string;
  address?: string;
  assetKey?: string;
  symbol?: string;
  name?: string;
  source?: string;
  issuer?: string;
  entryId?: string;
  wallet?: string;
  rescan?: string;
};

async function runScanForParams(params: ScanPageSearchParams): Promise<{
  scan: DiscoveryScanResult | undefined;
  alerts: DiscoveryAlert[];
  entry: WatchlistEntry | undefined;
  newRun: WatchlistScanRun | undefined;
  previousRunId: string | undefined;
  error?: string;
}> {
  const wallet = (params.wallet ?? DEFAULT_WALLET).trim().toLowerCase();

  if (params.rescan === "1" && params.entryId) {
    const result = await rescanWatchlistEntry(params.entryId, { walletAddress: wallet });

    if (!result.ok) {
      return { scan: undefined, alerts: [], entry: undefined, newRun: undefined, previousRunId: undefined, error: result.error };
    }

    const alerts = "alerts" in result && Array.isArray(result.alerts) ? result.alerts : [];

    return {
      scan: result.scan,
      alerts,
      entry: result.entry,
      newRun: result.newRun,
      previousRunId: result.previousRun?.id,
    };
  }

  if (!params.chain) {
    return { scan: undefined, alerts: [], entry: undefined, newRun: undefined, previousRunId: undefined, error: "Chain is required." };
  }

  const scan = await scanDiscoveryCandidate({
    id: `adhoc_${Date.now().toString(36)}`,
    chain: params.chain,
    contractAddress: params.address || undefined,
    assetKey: params.assetKey || undefined,
    issuer: params.issuer || undefined,
    symbol: params.symbol || undefined,
    tokenName: params.name || undefined,
    source: (params.source as "dexscreener" | "stellar_market" | "manual" | undefined) ?? "manual",
    assetType: params.chain.startsWith("stellar") ? "classic" : "contract",
    discoveredAt: new Date().toISOString(),
    metrics: {},
    raw: { origin: "/discovery/scan inline" },
  });

  return {
    scan,
    alerts: listDiscoveryAlerts(wallet).slice(0, 5),
    entry: undefined,
    newRun: undefined,
    previousRunId: undefined,
  };
}

function priorRuns(entryId: string | undefined) {
  if (!entryId) return [];

  return listWatchlistScanRuns(entryId).slice(0, 8);
}

export default async function DiscoveryScanPage({ searchParams }: { searchParams: Promise<ScanPageSearchParams> }) {
  const params = await searchParams;
  const wallet = (params.wallet ?? DEFAULT_WALLET).trim().toLowerCase();
  const { scan, alerts, entry, newRun, previousRunId, error } = await runScanForParams(params);

  const priorRunsList = priorRuns(params.entryId);
  const watchlistEntries = listWatchlistEntries(wallet).slice(0, 6);

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-2">
        <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Golden Raccoon · V3 · Discovery scan</p>
        <h1 className="text-3xl font-semibold text-white">
          {entry ? `Rescan · ${entry.symbol ?? entry.tokenName ?? entry.identityKey}` : `Adhoc scan · ${params.symbol ?? params.name ?? params.address ?? params.assetKey ?? "candidate"}`}
        </h1>
        <p className="max-w-3xl text-sm text-slate-300">
          The scan runs the full onchain, news, social and portfolio context through the Decision Agent. The server never prepares or signs a transaction. Results below are deterministic and auditable.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
          <Link
            href={{ pathname: "/discovery", query: { wallet } }}
            className="rounded border border-slate-700 px-2 py-1 text-slate-300 hover:border-emerald-400 hover:text-emerald-200"
          >
            ← Back to Discovery
          </Link>
          {newRun ? (
            <span className="text-slate-400">Run id <code>{newRun.id}</code> · previous <code>{previousRunId ?? "—"}</code></span>
          ) : null}
        </div>
      </header>

      {error ? (
        <section className="rounded-2xl border border-rose-500/40 bg-rose-500/5 p-6 text-sm text-rose-200">
          Scan could not run: {error}
        </section>
      ) : null}

      {scan ? (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-medium text-white">
                {scan.candidate.symbol ?? scan.candidate.tokenName ?? scan.candidate.id}{" "}
                <span className="text-xs font-normal text-slate-400">on {scan.candidate.chain}</span>
              </h2>
              <p className="text-xs text-slate-500">
                Identity confidence {scan.identity.confidenceLabel} ({Math.round(scan.identity.confidence * 100)}%) · scanned {scan.scannedAt}
              </p>
            </div>
            <span className={`rounded border px-2 py-0.5 text-xs ${classificationTone[scan.classification]}`}>
              {scan.classification}
            </span>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-xs text-slate-300 md:grid-cols-4">
            <div>
              <dt className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Decision score</dt>
              <dd className="mt-1 text-lg font-semibold text-white">{scan.decision.score}/100</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Confidence</dt>
              <dd className="mt-1 text-lg font-semibold text-white">{Math.round(scan.confidence * 100)}%</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Source coverage</dt>
              <dd className="mt-1 text-lg font-semibold text-white">{scan.sourceLineage.filter((s) => s.status === "connected").length}/{scan.sourceLineage.length}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Recommended action</dt>
              <dd className="mt-1 text-sm font-semibold text-white">{scan.decision.recommendedAction.replaceAll("_", " ")}</dd>
            </div>
          </dl>

          <h3 className="mt-6 text-sm font-medium text-white">Classification reasons</h3>
          <ul className="mt-2 space-y-1 text-xs text-slate-300">
            {scan.classificationReasons.map((reason) => (
              <li key={reason}>• {reason}</li>
            ))}
          </ul>

          <h3 className="mt-6 text-sm font-medium text-white">Source lineage</h3>
          <ul className="mt-2 space-y-1 text-xs text-slate-300">
            {scan.sourceLineage.map((source) => (
              <li key={source.label} className="flex items-center justify-between">
                <span>{source.label}</span>
                <span className={severityTone[source.status === "connected" ? "low" : source.status === "mock" ? "medium" : "high"]}>{source.status}</span>
              </li>
            ))}
          </ul>

          {scan.missingData.length > 0 ? (
            <>
              <h3 className="mt-6 text-sm font-medium text-white">Missing data</h3>
              <ul className="mt-2 space-y-1 text-xs text-slate-300">
                {scan.missingData.slice(0, 5).map((item) => (
                  <li key={item.field}>
                    <span className="font-medium text-slate-100">{item.field}</span> · {item.reason}{" "}
                    <span className={severityTone[item.impact] ?? severityTone.low}>({item.impact})</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}

      {alerts.length > 0 ? (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <h2 className="text-lg font-medium text-white">Triggered alerts</h2>
          <div className="mt-3 space-y-3">
            {alerts.map((alert) => (
              <AlertCard
                key={alert.id}
                title={alert.title}
                detail={alert.detail}
                severity={alert.severity}
                sourceLabel={alert.sourceLabel ?? alert.kind}
              />
            ))}
          </div>
        </section>
      ) : null}

      {entry ? (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <h2 className="text-lg font-medium text-white">Entry state</h2>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-xs text-slate-300 md:grid-cols-4">
            <div>
              <dt className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Latest classification</dt>
              <dd className="mt-1 text-sm font-semibold text-white">{entry.latestClassification ?? "no classification"}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Latest status</dt>
              <dd className="mt-1 text-sm font-semibold text-white">{entry.latestStatus ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Latest score</dt>
              <dd className="mt-1 text-sm font-semibold text-white">{entry.latestScore ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Successful scans</dt>
              <dd className="mt-1 text-sm font-semibold text-white">{entry.successfulScanRunIds?.length ?? 0}</dd>
            </div>
          </dl>
        </section>
      ) : null}

      {priorRunsList.length > 0 ? (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <h2 className="text-lg font-medium text-white">Prior rescan history ({priorRunsList.length})</h2>
          <ul className="mt-3 space-y-2 text-xs text-slate-300">
            {priorRunsList.map((run) => (
              <li key={run.id} className="rounded border border-slate-800 bg-slate-950/50 p-3">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-white">{run.classification}</span>
                  <span className="text-slate-500">
                    {run.status} · score {run.score}/100 · {new Date(run.scannedAt).toISOString()}
                  </span>
                </div>
                <ul className="mt-1 list-disc pl-4 text-[11px] text-slate-400">
                  {run.classificationReasons.slice(0, 3).map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {watchlistEntries.length > 0 ? (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <h2 className="text-lg font-medium text-white">Other watchlist entries ({watchlistEntries.length})</h2>
          <ul className="mt-3 space-y-1 text-xs text-slate-300">
            {watchlistEntries.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between">
                <span>{entry.symbol ?? entry.tokenName ?? entry.identityKey}</span>
                <span className={classificationTone[entry.latestClassification ?? "watch"]}>{entry.latestClassification ?? "no scan"}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
