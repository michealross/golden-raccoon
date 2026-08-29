import type {
  AgentResult,
  AgentRunRecord,
  AlertObservation,
  AlertObservationDirection,
  AlertTriggerType,
} from "@/server/types";

/**
 * Direction semantics attached to observations.
 * - high_is_bad: trigger when value >= threshold (risk, concentration, score).
 * - low_is_bad: trigger when value <= threshold (liquidity, stable reserve).
 */
const triggerDirection: Record<AlertTriggerType, AlertObservationDirection> = {
  critical_risk: "high_is_bad",
  liquidity_drop: "low_is_bad",
  holder_concentration_change: "high_is_bad",
  tax_control_change: "high_is_bad",
  phishing_detected: "high_is_bad",
  exploit_news: "high_is_bad",
  portfolio_concentration: "high_is_bad",
  stable_reserve_change: "low_is_bad",
  stellar_issuer_auth: "high_is_bad",
  stellar_clawback: "high_is_bad",
  stellar_trustline: "high_is_bad",
  stellar_contract_ttl: "high_is_bad",
  rpc_degradation: "high_is_bad",
};

export function getAlertTriggerDirection(trigger: AlertTriggerType): AlertObservationDirection {
  return triggerDirection[trigger];
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getRawSignals(result: AgentResult): Record<string, unknown> {
  return result.rawSignals ?? {};
}

function getObservationKeyForResult(result: AgentResult, index: number) {
  if (result.agent === "portfolio") return `portfolio:${result.agent}`;
  const target = getString(getRawSignals(result), "target") ?? getString(getRawSignals(result), "assetKey") ?? getString(getRawSignals(result), "symbol");

  return target ? `${result.agent}:${target.toLowerCase()}` : `${result.agent}:${index}`;
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];

  return typeof value === "string" ? value : undefined;
}

function getNumberField(record: Record<string, unknown>, key: string): number | undefined {
  return getNumber(record[key]);
}

function getCriticalCount(result: AgentResult) {
  return result.findings.filter((finding) => finding.severity === "critical").length;
}

function getSourceLabels(result: AgentResult) {
  return result.sources.map((source) => source.label);
}

function getUnavailableLabels(result: AgentResult): string[] {
  return result.sources.filter((source) => source.status === "unavailable").map((source) => source.label);
}

function isResultIncomplete(result: AgentResult): boolean {
  return result.sources.some((source) => source.status === "unavailable");
}

function buildObservation(input: {
  walletAddress: string;
  triggerType: AlertTriggerType;
  observationKey: string;
  value: number;
  evidence: AlertObservation["evidence"];
  incompleteData?: boolean;
}): AlertObservation {
  return {
    id: `obs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    walletAddress: input.walletAddress,
    triggerType: input.triggerType,
    observationKey: input.observationKey,
    value: input.value,
    direction: triggerDirection[input.triggerType],
    evidence: input.evidence,
    createdAt: new Date().toISOString(),
    incompleteData: input.incompleteData,
  };
}

function extractOnchainObservation(run: AgentRunRecord, result: AgentResult, key: string): AlertObservation[] {
  const observations: AlertObservation[] = [];
  const raw = getRawSignals(result);
  const sources = result.sources;
  const unavailableLabels = getUnavailableLabels(result);
  const incomplete = isResultIncomplete(result);

  // Provider degradation continues to fire even on otherwise complete
  // results (since the engine needs a dedicated signal that the upstream
  // source is failing). Risk observations derived from an incomplete
  // result must NOT promote to alerts; this stops missing data from
  // producing phantom risk-change alerts in the engine.
  if (unavailableLabels.length > 0) {
    observations.push(
      buildObservation({
        walletAddress: run.walletAddress,
        triggerType: "rpc_degradation",
        observationKey: `${key}:degradation`,
        value: unavailableLabels.length,
        evidence: {
          runId: run.id,
          agent: result.agent,
          label: "Provider unavailable for onchain check",
          detail: unavailableLabels.join(", "),
          sourceLabels: unavailableLabels,
          meta: { unavailableCount: unavailableLabels.length, totalSources: sources.length },
        },
      }),
    );

    if (incomplete) {
      // Refuse to emit risk observations for incomplete results.
      return observations;
    }
  }

  // Critical risk: any critical finding (only when not data-incomplete).
  if (getCriticalCount(result) > 0) {
    observations.push(
      buildObservation({
        walletAddress: run.walletAddress,
        triggerType: "critical_risk",
        observationKey: key,
        value: result.riskScore,
        evidence: {
          runId: run.id,
          agent: result.agent,
          label: "Critical onchain findings detected",
          detail: result.findings
            .filter((finding) => finding.severity === "critical")
            .map((finding) => finding.label)
            .join(", "),
          sourceLabels: getSourceLabels(result),
        },
      }),
    );
  }

  // Liquidity drop: an observable, low liquidity value.
  const market = raw.market as { bestPair?: { liquidityUsd?: number }; pairCount?: number } | undefined;
  const liquidityUsd = getNumberField(market?.bestPair ?? {}, "liquidityUsd");

  if (typeof liquidityUsd === "number") {
    observations.push(
      buildObservation({
        walletAddress: run.walletAddress,
        triggerType: "liquidity_drop",
        observationKey: key,
        value: liquidityUsd,
        evidence: {
          runId: run.id,
          agent: result.agent,
          label: "Onchain DEX liquidity",
          detail: `Best pair liquidity is $${Math.round(liquidityUsd).toLocaleString("en-US")}.`,
          sourceLabels: getSourceLabels(result),
          meta: { liquidityUsd, pairCount: market?.pairCount ?? 0 },
        },
      }),
    );
  }

  // Tax / control change: observed from GoPlus privileged function flags.
  const privileged = raw.privilegedFunctions as Array<{ key: string; flagged?: boolean }> | undefined;
  const flaggedPrivileged = Array.isArray(privileged) ? privileged.filter((flag) => flag.flagged).map((flag) => flag.key) : [];

  if (flaggedPrivileged.length > 0) {
    observations.push(
      buildObservation({
        walletAddress: run.walletAddress,
        triggerType: "tax_control_change",
        observationKey: key,
        value: flaggedPrivileged.length,
        evidence: {
          runId: run.id,
          agent: result.agent,
          label: "Privileged controls detected",
          detail: flaggedPrivileged.join(", "),
          sourceLabels: getSourceLabels(result),
          meta: { flaggedPrivilegeCount: flaggedPrivileged.length },
        },
      }),
    );
  }

  // Holder concentration change.
  const holders = raw.holders as { topHolderPercent?: number; top5Percent?: number; top10Percent?: number } | undefined;

  if (holders && typeof holders.top5Percent === "number") {
    observations.push(
      buildObservation({
        walletAddress: run.walletAddress,
        triggerType: "holder_concentration_change",
        observationKey: key,
        value: holders.top5Percent,
        evidence: {
          runId: run.id,
          agent: result.agent,
          label: "Top 5 holder concentration",
          detail: `Top 5 holders control ${holders.top5Percent.toFixed(2)}%.`,
          sourceLabels: getSourceLabels(result),
          meta: {
            topHolderPercent: holders.topHolderPercent ?? 0,
            top5Percent: holders.top5Percent,
            top10Percent: holders.top10Percent ?? 0,
          },
        },
      }),
    );
  }

  return observations;
}

function extractSocialObservation(run: AgentRunRecord, result: AgentResult, key: string): AlertObservation[] {
  const observations: AlertObservation[] = [];
  const raw = getRawSignals(result);
  const unavailableLabels = getUnavailableLabels(result);
  const incomplete = isResultIncomplete(result);

  if (unavailableLabels.length > 0) {
    observations.push(
      buildObservation({
        walletAddress: run.walletAddress,
        triggerType: "rpc_degradation",
        observationKey: `${key}:degradation`,
        value: unavailableLabels.length,
        evidence: {
          runId: run.id,
          agent: result.agent,
          label: "Social provider unavailable",
          detail: `Unavailable sources: ${unavailableLabels.join(", ")}.`,
          sourceLabels: unavailableLabels,
          meta: { unavailableCount: unavailableLabels.length, totalSources: result.sources.length },
        },
      }),
    );

    if (incomplete) return observations;
  }

  // Phishing detected: critical phishing finding with risky links.
  const phishingCritical = result.findings.some(
    (finding) => finding.severity === "critical" && /phishing|drainer|claim/i.test(`${finding.label} ${finding.detail}`),
  );

  if (phishingCritical) {
    observations.push(
      buildObservation({
        walletAddress: run.walletAddress,
        triggerType: "phishing_detected",
        observationKey: key,
        value: 1,
        evidence: {
          runId: run.id,
          agent: result.agent,
          label: "Phishing signal on official social channels",
          detail: result.findings
            .filter((finding) => /phishing|drainer|claim/i.test(`${finding.label} ${finding.detail}`))
            .map((finding) => finding.label)
            .join(", "),
          sourceLabels: getSourceLabels(result),
        },
      }),
    );
  }

  // Identity confidence collapse is treated as critical_risk only when risk is high.
  if (result.riskScore >= 75) {
    observations.push(
      buildObservation({
        walletAddress: run.walletAddress,
        triggerType: "critical_risk",
        observationKey: key,
        value: result.riskScore,
        evidence: {
          runId: run.id,
          agent: result.agent,
          label: "Social risk critical",
          detail: ((raw.identity as { warnings?: string[] })?.warnings)
            ? `${(raw.identity as { warnings?: string[] }).warnings?.join(" ") ?? "trust collapse"}`
            : result.summary,
          sourceLabels: getSourceLabels(result),
        },
      }),
    );
  }

  return observations;
}

function extractNewsObservation(run: AgentRunRecord, result: AgentResult, key: string): AlertObservation[] {
  const observations: AlertObservation[] = [];
  const raw = getRawSignals(result);
  const negativeCatalysts = raw.negativeCatalysts;
  const unavailableLabels = getUnavailableLabels(result);
  const incomplete = isResultIncomplete(result);

  if (unavailableLabels.length > 0) {
    observations.push(
      buildObservation({
        walletAddress: run.walletAddress,
        triggerType: "rpc_degradation",
        observationKey: `${key}:degradation`,
        value: unavailableLabels.length,
        evidence: {
          runId: run.id,
          agent: result.agent,
          label: "News provider unavailable",
          detail: unavailableLabels.join(", "),
          sourceLabels: unavailableLabels,
          meta: { unavailableCount: unavailableLabels.length, totalSources: result.sources.length },
        },
      }),
    );

    if (incomplete) return observations;
  }

  if (Array.isArray(negativeCatalysts) && negativeCatalysts.length > 0) {
    const exploit = negativeCatalysts.filter((event: { type?: string; severity?: string }) => event.type === "exploit_news" || event.severity === "critical" || event.severity === "high");

    if (exploit.length > 0) {
      observations.push(
        buildObservation({
          walletAddress: run.walletAddress,
          triggerType: "exploit_news",
          observationKey: key,
          value: exploit.length,
          evidence: {
            runId: run.id,
            agent: result.agent,
            label: "Exploit / hack news matched for identity",
            detail: exploit.map((event: { title?: string; label?: string }) => event.title ?? event.label ?? "exploit").join(" / "),
            sourceLabels: getSourceLabels(result),
            meta: { matchedCount: exploit.length, totalNegative: negativeCatalysts.length },
          },
        }),
      );
    }
  }

  return observations;
}

function extractPortfolioObservation(run: AgentRunRecord, result: AgentResult): AlertObservation[] {
  const observations: AlertObservation[] = [];
  const raw = getRawSignals(result);
  const portfolioRisk = raw.portfolioRisk as
    | {
        largestHoldingPercent?: number;
        top3HoldingPercent?: number;
        stableReservePercent?: number;
      }
    | undefined;
  const unavailableLabels = getUnavailableLabels(result);
  const incomplete = isResultIncomplete(result);

  if (unavailableLabels.length > 0) {
    observations.push(
      buildObservation({
        walletAddress: run.walletAddress,
        triggerType: "rpc_degradation",
        observationKey: `portfolio:degradation`,
        value: unavailableLabels.length,
        evidence: {
          runId: run.id,
          agent: result.agent,
          label: "Portfolio provider unavailable",
          detail: unavailableLabels.join(", "),
          sourceLabels: unavailableLabels,
          meta: { unavailableCount: unavailableLabels.length, totalSources: result.sources.length },
        },
      }),
    );

    if (incomplete) return observations;
  }

  if (portfolioRisk) {
    const key = "portfolio";

    if (typeof portfolioRisk.largestHoldingPercent === "number") {
      observations.push(
        buildObservation({
          walletAddress: run.walletAddress,
          triggerType: "portfolio_concentration",
          observationKey: key,
          value: portfolioRisk.largestHoldingPercent,
          evidence: {
            runId: run.id,
            agent: result.agent,
            label: "Largest holding concentration",
            detail: `Largest holding is ${portfolioRisk.largestHoldingPercent.toFixed(1)}% of wallet.`,
            sourceLabels: getSourceLabels(result),
            meta: { top3: portfolioRisk.top3HoldingPercent ?? 0 },
          },
        }),
      );
    }

    if (typeof portfolioRisk.stableReservePercent === "number") {
      observations.push(
        buildObservation({
          walletAddress: run.walletAddress,
          triggerType: "stable_reserve_change",
          observationKey: key,
          value: portfolioRisk.stableReservePercent,
          evidence: {
            runId: run.id,
            agent: result.agent,
            label: "Stable reserve percent",
            detail: `Verified stable reserve is ${portfolioRisk.stableReservePercent.toFixed(1)}%.`,
            sourceLabels: getSourceLabels(result),
          },
        }),
      );
    }
  }

  return observations;
}

function extractStellarObservation(run: AgentRunRecord, result: AgentResult, key: string): AlertObservation[] {
  const observations: AlertObservation[] = [];
  const raw = getRawSignals(result);
  const incomplete = isResultIncomplete(result);

  if (incomplete) {
    // Stellar-specific risk observations are also suppressed when the
    // underlying result has unavailable providers. The rpc_degradation
    // observation flows from the onchain extractor above.
    return observations;
  }

  const issuerControls = raw.issuerControls as
    | {
        authRequired?: boolean;
        authRevocable?: boolean;
        authClawback?: boolean;
        authImmutable?: boolean;
      }
    | undefined;
  const trustline = raw.trustline as { requireAuth?: boolean; revocable?: boolean } | undefined;
  const contractTTL = raw.contractTTL as { liveUntilLedgerSeq?: number; latestLedger?: number } | undefined;

  // Emit stellar_issuer_auth and stellar_clawback as independent
  // observations so both the authorisation/revocation signals and the
  // clawback risk get their own observable lifecycle in the alert
  // engine (separate thresholds, separate cooldowns, separate
  // deduplication). Audit finding #38: the previous ternary combined
  // them into a single trigger, skipping stellar_issuer_auth when
  // authClawback was also present.
  if (issuerControls && (issuerControls.authRequired || issuerControls.authRevocable)) {
    observations.push(
      buildObservation({
        walletAddress: run.walletAddress,
        triggerType: "stellar_issuer_auth",
        observationKey: key,
        value: (issuerControls.authRequired ? 1 : 0) + (issuerControls.authRevocable ? 1 : 0),
        evidence: {
          runId: run.id,
          agent: result.agent,
          label: "Stellar issuer authorization controls",
          detail: `Issuer flags: ${Object.entries(issuerControls)
            .filter(([, value]) => Boolean(value))
            .map(([flag]) => flag)
            .join(", ")}.`,
          sourceLabels: getSourceLabels(result),
          meta: {
            authRequired: !!issuerControls.authRequired,
            authRevocable: !!issuerControls.authRevocable,
            active: true,
          },
        },
      }),
    );
  }

  if (issuerControls && issuerControls.authClawback) {
    observations.push(
      buildObservation({
        walletAddress: run.walletAddress,
        triggerType: "stellar_clawback",
        observationKey: key,
        value: 1,
        evidence: {
          runId: run.id,
          agent: result.agent,
          label: "Stellar issuer clawback enabled",
          detail: `Issuer flag: authClawback=true (authRequired=${!!issuerControls.authRequired}, authRevocable=${!!issuerControls.authRevocable}).`,
          sourceLabels: getSourceLabels(result),
          meta: {
            authClawback: true,
            authRequired: !!issuerControls.authRequired,
            authRevocable: !!issuerControls.authRevocable,
            active: true,
          },
        },
      }),
    );
  }

  if (trustline && (trustline.requireAuth || trustline.revocable)) {
    observations.push(
      buildObservation({
        walletAddress: run.walletAddress,
        triggerType: "stellar_trustline",
        observationKey: key,
        value: trustline.revocable ? 1 : 0.5,
        evidence: {
          runId: run.id,
          agent: result.agent,
          label: "Stellar trustline configuration",
          detail: `Trustline requireAuth=${trustline.requireAuth}, revocable=${trustline.revocable}.`,
          sourceLabels: getSourceLabels(result),
          meta: { requireAuth: trustline.requireAuth ?? false, revocable: trustline.revocable ?? false },
        },
      }),
    );
  }

  if (contractTTL && typeof contractTTL.liveUntilLedgerSeq === "number" && typeof contractTTL.latestLedger === "number") {
    const ledgersToLive = contractTTL.liveUntilLedgerSeq - contractTTL.latestLedger;
    const ttlRisk = ledgersToLive < 50_000 ? 1 : ledgersToLive < 200_000 ? 0.66 : 0.33;

    observations.push(
      buildObservation({
        walletAddress: run.walletAddress,
        triggerType: "stellar_contract_ttl",
        observationKey: key,
        value: ttlRisk,
        evidence: {
          runId: run.id,
          agent: result.agent,
          label: "Stellar contract TTL nearing expiration",
          detail: `Contract liveUntilLedgerSeq=${contractTTL.liveUntilLedgerSeq}, latest=${contractTTL.latestLedger}, remaining=${ledgersToLive}.`,
          sourceLabels: getSourceLabels(result),
          meta: { liveUntilLedgerSeq: contractTTL.liveUntilLedgerSeq, latestLedger: contractTTL.latestLedger, ledgersToLive },
        },
      }),
    );
  }

  return observations;
}

export function extractObservationsForRun(run: AgentRunRecord): AlertObservation[] {
  if (!run.results || run.results.length === 0) return [];
  const observations: AlertObservation[] = [];
  const portfolioResults = run.results.filter((r) => r.agent === "portfolio");
  const specialistResults = run.results.filter((r) => r.agent !== "portfolio" && r.agent !== "decision" && r.agent !== "execution");

  for (const result of portfolioResults) {
    observations.push(...extractPortfolioObservation(run, result));
  }

  specialistResults.forEach((result, index) => {
    const key = getObservationKeyForResult(result, index);

    if (result.agent === "onchain") {
      // Stellar onchain agent may emit additional trustline/TTL observations.
      if (result.rawSignals?.stellarAssetIdentity) {
        observations.push(...extractStellarObservation(run, result, key));
      }

      observations.push(...extractOnchainObservation(run, result, key));
    } else if (result.agent === "social") {
      observations.push(...extractSocialObservation(run, result, key));
    } else if (result.agent === "news") {
      observations.push(...extractNewsObservation(run, result, key));
    }
  });

  observations.sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());

  return observations;
}
