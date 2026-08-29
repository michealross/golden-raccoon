import Link from "next/link";
import { AlertCard } from "@/components/AlertCard";
import { listDiscoveryCandidates } from "@/server/discovery/pipeline";
import { fetchLiveDiscoveryCandidates, isOfflineSnapshot } from "@/server/discovery/sources";
import { listWatchlist } from "@/server/discovery/watchlist";
import { listDiscoveryAlerts, listWatchlistScanRuns } from "@/server/storage";
import type { DiscoveryAlert, DiscoveryClassification, DiscoveryCandidate, RiskLevel, WatchlistEntry, WatchlistScanRun } from "@/server/types";

const DEFAULT_WALLET = "0xDemoWallet";

export const dynamic = "force-dynamic";

type ViewAlert = Pick<DiscoveryAlert, "id" | "kind" | "title" | "detail" | "severity" | "sourceLabel" | "acknowledged" | "createdAt">;

type ViewScanRun = Pick<WatchlistScanRun, "id" | "entryId" | "classification" | "score" | "confidence" | "status" | "scannedAt" | "classificationReasons">;

type ViewWatchlistEntry = Pick<WatchlistEntry, "id" | "chain" | "source" | "symbol" | "tokenName" | "contractAddress" | "assetKey" | "issuer" | "createdAt" | "lastScannedAt" | "latestClassification" | "latestScore" | "latestStatus"> & {
  scanRunCount: number;
};

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

async function safeListCandidates(): Promise<{ candidates: DiscoveryCandidate[]; origin: "live" | "offline" }> {
  try {
    const fetched = await listDiscoveryCandidates();
    const offline = fetched.some((candidate) => isOfflineSnapshot(candidate));

    return { candidates: fetched, origin: offline ? "offline" : "live" };
  } catch {
    return { candidates: [], origin: "offline" };
  }
}

function fallbackMessage(origin: "live" | "offline") {
  return origin === "live"
    ? "Live DexScreener and Stellar Expert candidate feed."
    : "Live sources are unreachable. Surfacing the offline candidate snapshot.";
}

function statusTone(status?: WatchlistScanRun["status"]) {
  if (status === "stale") return "text-amber-300";
  if (status === "failed") return "text-rose-300";
  if (status === "partial") return "text-orange-300";

  return "text-emerald-300";
}

async function loadWatchlistView(wallet: string): Promise<ViewWatchlistEntry[]> {
  try {
    const entries = listWatchlist(wallet);

    return entries.slice(0, 8).map((entry) => ({
      id: entry.id,
      chain: entry.chain,
      source: entry.source,
      symbol: entry.symbol,
      tokenName: entry.tokenName,
      contractAddress: entry.contractAddress,
      assetKey: entry.assetKey,
      issuer: entry.issuer,
      createdAt: entry.createdAt,
      lastScannedAt: entry.lastScannedAt,
      latestClassification: entry.latestClassification,
      latestScore: entry.latestScore,
      latestStatus: entry.latestStatus,
      scanRunCount: listWatchlistScanRuns(entry.id).length,
    }));
  } catch {
    return [];
  }
}

async function loadRecentAlertsView(wallet: string): Promise<ViewAlert[]> {
  try {
    return listDiscoveryAlerts(wallet).slice(0, 8).map((alert) => ({
      id: alert.id,
      kind: alert.kind,
      title: alert.title,
      detail: alert.detail,
      severity: alert.severity,
      sourceLabel: alert.sourceLabel,
      acknowledged: alert.acknowledged,
      createdAt: alert.createdAt,
    }));
  } catch {
    return [];
  }
}

async function loadRecentScanRunsView(wallet: string): Promise<ViewScanRun[]> {
  try {
    return listWatchlistScanRuns()
      .filter((run) => run.walletAddress.toLowerCase() === wallet.toLowerCase())
      .slice(0, 8)
      .map((run) => ({
        id: run.id,
        entryId: run.entryId,
        classification: run.classification,
        score: run.score,
        confidence: run.confidence,
        status: run.status,
        scannedAt: run.scannedAt,
        classificationReasons: run.classificationReasons,
      }));
  } catch {
    return [];
  }
}

export default async function DiscoveryPage({
  searchParams,
}: {
  searchParams: Promise<{ wallet?: string; chain?: string; status?: string }>;
}) {
  const params = await searchParams;
  const wallet = (params.wallet ?? DEFAULT_WALLET).trim().toLowerCase();
  const { candidates, origin } = await safeListCandidates();
  const watchlist = await loadWatchlistView(wallet);
  const alerts = await loadRecentAlertsView(wallet);
  const recentRuns = await loadRecentScanRunsView(wallet);
  const originLabel = origin === "live" ? "Live" : "Offline snapshot";
  const primaryCandidates = candidates.slice(0, 12);

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-2">
        <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Golden Raccoon · V3</p>
        <h1 className="text-3xl font-semibold text-white">Discovery candidates, scans, watchlists, and alerts</h1>
        <p className="max-w-3xl text-sm text-slate-300">
          {fallbackMessage(origin)} Identity is resolved before any scan. The server never prepares or signs a transaction. Critical risks stay visible regardless of market momentum.
        </p>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className={`rounded border px-2 py-1 ${origin === "live" ? "border-emerald-500/40 text-emerald-300" : "border-amber-500/40 text-amber-300"}`}>
            Source feed: {originLabel}
          </span>
          <span className="text-slate-400">Wallet: {wallet}</span>
          <Link href={`/discovery?wallet=${encodeURIComponent(wallet)}`} className="text-emerald-300 underline-offset-2 hover:underline">
            Refresh
          </Link>
        </div>
      </header>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-medium text-white">Discovery candidates</h2>
          <span className="text-xs text-slate-400">Top {primaryCandidates.length} of {candidates.length} fetched · identity is resolved before scanning.</span>
        </div>
        {primaryCandidates.length === 0 ? (
          <p className="rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-400">
            No candidates returned from the discovery source.
          </p>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {primaryCandidates.map((candidate) => (
              <li key={candidate.id} className="rounded-lg border border-slate-700 bg-slate-900/70 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-white">{candidate.symbol ?? candidate.tokenName ?? candidate.id}</span>
                  <span className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-400">{candidate.chain}</span>
                </div>
                <p className="mt-2 text-xs text-slate-400">{candidate.tokenName ?? "Unnamed candidate"}</p>
                {candidate.contractAddress ? (
                  <p className="mt-1 truncate text-[11px] text-slate-500">{candidate.contractAddress}</p>
                ) : candidate.assetKey ? (
                  <p className="mt-1 truncate text-[11px] text-slate-500">{candidate.assetKey}</p>
                ) : null}
                <dl className="mt-3 grid grid-cols-2 gap-1 text-[11px] text-slate-400">
                  <div>Pair age: {candidate.metrics?.pairAgeDays ?? "?"} d</div>
                  <div>Liquidity: ${candidate.metrics?.liquidityUsd?.toLocaleString("en-US") ?? "?"}</div>
                  <div>Source: {candidate.source}</div>
                  <div>FDV/Liq: {candidate.metrics?.fdvLiquidityRatio?.toFixed(1) ?? "?"}x</div>
                </dl>
                <div className="mt-3 flex items-center justify-between">
                  <span className="text-[11px] text-slate-500">{new Date(candidate.discoveredAt).toISOString().slice(0, 10)}</span>
                  <Link
                    href={{
                      pathname: "/discovery/scan",
                      query: {
                        chain: candidate.chain,
                        address: candidate.contractAddress ?? "",
                        assetKey: candidate.assetKey ?? "",
                        symbol: candidate.symbol ?? "",
                        name: candidate.tokenName ?? "",
                        source: candidate.source,
                        issuer: candidate.issuer ?? "",
                        wallet,
                      },
                    }}
                    className="text-xs text-emerald-300 underline-offset-2 hover:underline"
                  >
                    Run scan →
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium text-white">Watchlist for {wallet}</h2>
            <Link href={`/discovery?wallet=${encodeURIComponent(wallet)}`} className="text-xs text-emerald-300 underline-offset-2 hover:underline">
              Refresh
            </Link>
          </div>
          {watchlist.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">
              No watchlist entries yet. Add a candidate from the list above using the API at <code className="text-xs text-slate-300">/api/watchlist</code>.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {watchlist.map((entry) => {
                const entryClass = entry.latestClassification
                  ? classificationTone[entry.latestClassification]
                  : "border-slate-700 bg-slate-950/60 text-slate-400";
                return (
                  <li key={entry.id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-white">
                        {entry.symbol ?? entry.tokenName ?? entry.assetKey ?? entry.contractAddress ?? entry.id}
                      </span>
                      <span className={`rounded border px-2 py-0.5 text-[11px] ${entryClass}`}>
                        {entry.latestClassification ?? "no scan"}
                      </span>
                    </div>
                    <dl className="mt-2 grid grid-cols-2 gap-1 text-[11px] text-slate-400">
                      <div>Chain: {entry.chain}</div>
                      <div>Score: {entry.latestScore ?? "—"}</div>
                      <div>Status: <span className={statusTone(entry.latestStatus)}>{entry.latestStatus ?? "—"}</span></div>
                      <div>Scans: {entry.scanRunCount}</div>
                    </dl>
                    <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                      <span>Added {new Date(entry.createdAt).toISOString().slice(0, 10)}</span>
                      <Link
                        href={{
                          pathname: "/discovery/scan",
                          query: {
                            entryId: entry.id,
                            chain: entry.chain,
                            address: entry.contractAddress ?? "",
                            assetKey: entry.assetKey ?? "",
                            symbol: entry.symbol ?? "",
                            name: entry.tokenName ?? "",
                            source: entry.source ?? "manual",
                            issuer: entry.issuer ?? "",
                            wallet,
                            rescan: "1",
                          },
                        }}
                        className="text-emerald-300 underline-offset-2 hover:underline"
                      >
                        Rescan →
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <h2 className="text-lg font-medium text-white">Recent alerts ({alerts.length})</h2>
          {alerts.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">
              No alerts logged for this wallet yet. Alerts are recorded when rescans detect a critical risk, a classification change, or significant source signals.
            </p>
          ) : (
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
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
        <h2 className="text-lg font-medium text-white">Recent rescan history</h2>
        {recentRuns.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">
            No scan history recorded. Trigger a rescan from a watchlist entry above to start the audit trail.
          </p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm text-slate-300">
            {recentRuns.map((run) => (
              <li key={run.id} className="rounded border border-slate-800 bg-slate-950/50 p-3">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-white">{run.classification}</span>
                  <span className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-400">
                    Score {run.score}/100 · status <span className={statusTone(run.status)}>{run.status}</span>
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  {new Date(run.scannedAt).toISOString()} · entry <code>{run.entryId}</code> · confidence {Math.round(run.confidence * 100)}%
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[11px] text-slate-400">
                  {run.classificationReasons.slice(0, 3).map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
        <h2 className="text-lg font-medium text-white">How classifications work</h2>
        <ul className="mt-3 space-y-2 text-sm text-slate-300">
          <li className="flex items-start gap-3">
            <span className={`inline-block min-w-[110px] rounded border px-2 py-0.5 text-xs ${classificationTone.watch}`}>watch</span>
            <span>Default classification when identity or coverage is incomplete.</span>
          </li>
          <li className="flex items-start gap-3">
            <span className={`inline-block min-w-[110px] rounded border px-2 py-0.5 text-xs ${classificationTone.risky}`}>risky</span>
            <span>Elevated score or non-critical blockers; manual review required.</span>
          </li>
          <li className="flex items-start gap-3">
            <span className={`inline-block min-w-[110px] rounded border px-2 py-0.5 text-xs ${classificationTone.scam}`}>scam</span>
            <span>Critical onchain, social, phishing or identity blocker observed.</span>
          </li>
          <li className="flex items-start gap-3">
            <span className={`inline-block min-w-[110px] rounded border px-2 py-0.5 text-xs ${classificationTone.early_opportunity}`}>early_opportunity</span>
            <span>Resolved identity, adequate coverage, score below 50, no blockers. Discovery still does not prepare a transaction.</span>
          </li>
        </ul>
        <div className="mt-4">
          <p className="text-[11px] text-slate-500">
            Source coverage legend: <span className={`${severityTone.low}`}>connected</span> · <span className={`${severityTone.medium}`}>partial</span> · <span className={`${severityTone.critical}`}>unavailable</span>.
          </p>
        </div>
      </section>
    </main>
  );
}
