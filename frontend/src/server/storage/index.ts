import type {
  AgentResult,
  AgentRunRecord,
  Alert,
  AlertDelivery,
  AlertDeliveryChannel,
  AlertObservation,
  AlertRule,
  DiscoveryAlert,
  RecommendationRecord,
  StorageCounts,
  StorageHealth,
  TransactionRecord,
  UserApprovalRecord,
  UserRule,
  WatchlistEntry,
  WatchlistEntryInput,
  WatchlistScanRun,
  X402PaymentReceipt,
  AgentSource,
  AgentMissingData,
  DiscoveryClassification,
  RiskLevel,
} from "@/server/types";
import { getDefaultRules } from "@/server/rules/defaultRules";
import { validateAgentResult } from "@/server/agents/schema";
import {
  getPostgresStorageAdapter,
  mirrorAlertDeliveryUpdate,
  mirrorAlertDeliveryWrite,
  mirrorAlertObservationWrite,
  mirrorAlertRuleWrite,
  mirrorAlertUpdate,
  mirrorAlertWrite,
} from "@/server/storage/postgresAdapter";

/**
 * Hydration gate. When the Postgres adapter has rows on disk, this
 * promise merges them back into the in-memory stores on first import.
 * Audit finding #38: writes were mirrored to SQL but reads never
 * re-hydrated from SQL after a restart, so alert history looked empty.
 *
 * The gate uses a single bootPromise stored on globalThis: cold starts
 * kick off the hydrate; subsequent re-evaluations (HMR, route reloads)
 * await the same promise so the hydrate runs at most once per process.
 */
  type GoldenRaccoonMemoryGlobal = typeof globalThis & {
  __goldenRaccoonAlertRules?: AlertRule[];
  __goldenRaccoonAlertObservations?: AlertObservation[];
  __goldenRaccoonAlerts?: Alert[];
  __goldenRaccoonAlertDeliveries?: AlertDelivery[];
  __goldenRaccoonAgentRuns?: AgentRunRecord[];
  __goldenRaccoonRecommendations?: RecommendationRecord[];
  __goldenRaccoonTransactions?: TransactionRecord[];
  __goldenRaccoonApprovals?: UserApprovalRecord[];
  __goldenRaccoonUserRules?: UserRule[];
  __goldenRaccoonX402PaymentReceipts?: X402PaymentReceipt[];
  __goldenRaccoonWatchlistEntries?: WatchlistEntry[];
  __goldenRaccoonWatchlistScanRuns?: WatchlistScanRun[];
  __goldenRaccoonDiscoveryAlerts?: DiscoveryAlert[];
  __goldenRaccoonHydrationStarted?: boolean;
  __goldenRaccoonHydrationPromise?: Promise<{ tried: boolean; hydrated: number; skipped: number; detail: string }>;
  __goldenRaccoonLastHydration?: { tried: boolean; hydrated: number; skipped: number; detail: string; at: string };
};

const memoryStore = globalThis as GoldenRaccoonMemoryGlobal;

export function ensureStorageReady(): Promise<{ tried: boolean; hydrated: number; skipped: number; detail: string }> {
  const store = memoryStore as GoldenRaccoonMemoryGlobal;

  if (store.__goldenRaccoonHydrationPromise) return store.__goldenRaccoonHydrationPromise;

  store.__goldenRaccoonHydrationStarted = true;
  store.__goldenRaccoonHydrationPromise = (async () => {
    const adapter = getPostgresStorageAdapter();

    if (!adapter.isConfigured()) {
      const result = { tried: false, hydrated: 0, skipped: 0, detail: "no DATABASE_URL configured" };
      store.__goldenRaccoonLastHydration = { ...result, at: new Date().toISOString() };

      return result;
    }

    try {
      const hydrate = await adapter.hydrateAlertTables({
        rules: getAlertRulesStore(),
        observations: getAlertObservationsStore(),
        alerts: getAlertsStore(),
        deliveries: getAlertDeliveriesStore(),
      });
      const result = { tried: true, hydrated: hydrate.hydrated, skipped: hydrate.skipped, detail: "ok" };
      store.__goldenRaccoonLastHydration = { ...result, at: new Date().toISOString() };

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = { tried: true, hydrated: 0, skipped: 0, detail: message };
      store.__goldenRaccoonLastHydration = { ...result, at: new Date().toISOString() };

      return result;
    }
  })();

  return store.__goldenRaccoonHydrationPromise;
}

export function getLastHydrationSummary() {
  return memoryStore.__goldenRaccoonLastHydration
    ? { ...memoryStore.__goldenRaccoonLastHydration }
    : null;
}

// Eager hydration on module init. Subsequent reads (SSR pages, API
// routes, fixtures) see the same globalThis.__goldenRaccoon* arrays
// already populated from SQL where available. Errors are absorbed by
// `ensureStorageReady()` and surfaced via `getStorageHealth()`.
void ensureStorageReady();

/**
 * Mirror alert-table writes to Postgres so the SQL contract in
 * `schema.sql` is actually populated. The in-memory store remains the
 * synchronous source of truth; mirror failures are surfaced via
 * `getStorageHealth()` and never block the caller.
 */
function mirrorAlertRuleWriteDeferred(input: AlertRule) {
  mirrorAlertRuleWrite(input);
}
function mirrorAlertObservationWriteDeferred(input: AlertObservation) {
  mirrorAlertObservationWrite(input);
}
function mirrorAlertWriteDeferred(input: Alert) {
  mirrorAlertWrite(input);
}
function mirrorAlertDeliveryWriteDeferred(input: AlertDelivery) {
  mirrorAlertDeliveryWrite(input);
}
function mirrorAlertUpdateDeferred(input: Alert) {
  mirrorAlertUpdate(input);
}
function mirrorAlertDeliveryUpdateDeferred(input: AlertDelivery) {
  mirrorAlertDeliveryUpdate(input);
}

type CreateAgentRunInput = {
  walletAddress: string;
  mode?: AgentRunRecord["mode"];
  inputSnapshot?: Record<string, unknown>;
  targetToken?: AgentRunRecord["targetToken"];
  results: AgentResult[];
  userAction?: AgentRunRecord["userAction"];
};

export const storageSchemaContract = {
  tables: [
    "wallets",
    "agent_runs",
    "agent_results",
    "recommendations",
    "user_rules",
    "approvals",
    "transactions",
    "x402_payment_receipts",
    "token_identities",
    "source_snapshots",
    "alert_rules",
    "alert_observations",
    "alerts",
    "alert_deliveries",
    "watchlist_entries",
    "watchlist_scan_runs",
    "discovery_alerts",
  ],
  adapterApi: [
    "listAgentRunRecords",
    "getAgentRunRecord",
    "createAgentRunRecord",
    "listRecommendationRecords",
    "createRecommendationRecord",
    "listTransactionRecords",
    "createTransactionRecord",
    "listApprovalRecords",
    "createApprovalRecord",
    "listX402PaymentReceipts",
    "getX402PaymentReceiptByHeaderHash",
    "createX402PaymentReceipt",
    "getUserRuleRecord",
    "upsertUserRuleRecord",
    "listAlertRules",
    "getAlertRule",
    "upsertAlertRule",
    "deleteAlertRule",
    "listAlertObservations",
    "createAlertObservation",
    "listAlerts",
    "getAlert",
    "createAlert",
    "updateAlert",
    "listAlertDeliveries",
    "createAlertDelivery",
    "updateAlertDelivery",
    "ensureAlertRulesForWallet",
    "listWatchlistEntries",
    "getWatchlistEntry",
    "addWatchlistEntry",
    "removeWatchlistEntry",
    "listWatchlistScanRuns",
    "addWatchlistScanRun",
    "listDiscoveryAlerts",
    "acknowledgeDiscoveryAlert",
    "createDiscoveryAlert",
    "updateWatchlistEntryLatestScan",
  ],
  migration: "frontend/src/server/storage/schema.sql",
};

function getAgentRuns() {
  memoryStore.__goldenRaccoonAgentRuns ??= [];

  return memoryStore.__goldenRaccoonAgentRuns;
}

function getRecommendations() {
  memoryStore.__goldenRaccoonRecommendations ??= [];

  return memoryStore.__goldenRaccoonRecommendations;
}

function getTransactions() {
  memoryStore.__goldenRaccoonTransactions ??= [];

  return memoryStore.__goldenRaccoonTransactions;
}

function getApprovals() {
  memoryStore.__goldenRaccoonApprovals ??= [];

  return memoryStore.__goldenRaccoonApprovals;
}

function getUserRules() {
  memoryStore.__goldenRaccoonUserRules ??= [];

  return memoryStore.__goldenRaccoonUserRules;
}

function getX402PaymentReceipts() {
  memoryStore.__goldenRaccoonX402PaymentReceipts ??= [];

  return memoryStore.__goldenRaccoonX402PaymentReceipts;
}

function getAlertRulesStore() {
  memoryStore.__goldenRaccoonAlertRules ??= [];

  return memoryStore.__goldenRaccoonAlertRules;
}

function getAlertObservationsStore() {
  memoryStore.__goldenRaccoonAlertObservations ??= [];

  return memoryStore.__goldenRaccoonAlertObservations;
}

function getAlertsStore() {
  memoryStore.__goldenRaccoonAlerts ??= [];

  return memoryStore.__goldenRaccoonAlerts;
}

function getAlertDeliveriesStore() {
  memoryStore.__goldenRaccoonAlertDeliveries ??= [];

  return memoryStore.__goldenRaccoonAlertDeliveries;
}

function getWatchlistEntries() {
  memoryStore.__goldenRaccoonWatchlistEntries ??= [];

  return memoryStore.__goldenRaccoonWatchlistEntries;
}

function getWatchlistScanRuns() {
  memoryStore.__goldenRaccoonWatchlistScanRuns ??= [];

  return memoryStore.__goldenRaccoonWatchlistScanRuns;
}

function getDiscoveryAlerts() {
  memoryStore.__goldenRaccoonDiscoveryAlerts ??= [];

  return memoryStore.__goldenRaccoonDiscoveryAlerts;
}

function createId() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function createRecordId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function createAlertId() {
  return `alert_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export function hashSourceSnapshot(value: unknown) {
  const serialized = stableStringify(value);
  let hash = 5381;

  for (let index = 0; index < serialized.length; index += 1) {
    hash = (hash * 33) ^ serialized.charCodeAt(index);
  }

  return `snap_${(hash >>> 0).toString(16)}`;
}

export function getStorageHealth(): StorageHealth {
  const adapter = getPostgresStorageAdapter();
  const snapshot = adapter.getHealthSnapshot();

  if (snapshot.connectionStringPresent) {
    const detail = snapshot.connected
      ? `Postgres adapter connected (since ${snapshot.connectedAt}). ${snapshot.mirrorSuccessCount} mirror writes succeeded, ${snapshot.mirrorFailureCount} failed.`
      : snapshot.pgInstalled
        ? `Postgres connection string present but adapter has not connected yet (${snapshot.lastError ?? "no attempt yet"}). The in-memory store stays the source of truth at runtime; mirror writes resume once the connection succeeds.`
        : `Postgres connection string is configured but the \`pg\` client is not installed in this deployment. Run \`npm install pg\` to enable durable persistence; the runtime currently uses the in-memory store and the schema contract is fixed for adapter parity.`;

    return {
      provider: "supabase_postgres",
      persistent: snapshot.connected,
      detail,
      schema: storageSchemaContract,
    };
  }

  return {
    provider: "memory",
    persistent: false,
    detail: "Using in-memory MVP storage. Records reset when the server process restarts. Set SUPABASE_DB_URL/POSTGRES_URL/DATABASE_URL plus `pg` to make alert storage durable.",
    schema: storageSchemaContract,
  };
}

export function getStorageCounts(): StorageCounts {
  return {
    agentRuns: getAgentRuns().length,
    recommendations: getRecommendations().length,
    transactions: getTransactions().length,
    approvals: getApprovals().length,
    userRules: getUserRules().length,
    x402PaymentReceipts: getX402PaymentReceipts().length,
    alertRules: getAlertRulesStore().length,
    alertObservations: getAlertObservationsStore().length,
    alerts: getAlertsStore().length,
    alertDeliveries: getAlertDeliveriesStore().length,
  };
}

function normalizeWallet(walletAddress?: string | null): string | undefined {
  return walletAddress?.trim().toLowerCase() || undefined;
}

function withNormalizedWallet<T extends { walletAddress: string }>(walletAddress?: string) {
  const normalized = normalizeWallet(walletAddress);

  return (record: T) => !normalized || record.walletAddress === normalized;
}

// ---------------- Alert Engine Storage ----------------

export function ensureAlertRulesForWallet(walletAddress?: string) {
  const normalized = normalizeWallet(walletAddress);

  if (!normalized) return [];

  return [...ensureAlertRulesForWalletRaw().filter((rule) => rule.walletAddress === normalized)];
}

function ensureAlertRulesForWalletRaw() {
  // The store holds every wallet's rules. Filters are applied on read.
  return getAlertRulesStore();
}

export function listAlertRules(walletAddress?: string) {
  return [...getAlertRulesStore()]
    .filter(withNormalizedWallet(walletAddress))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

export function getAlertRule(id: string) {
  return getAlertRulesStore().find((rule) => rule.id === id);
}

export function upsertAlertRule(input: AlertRule) {
  const now = new Date().toISOString();
  const normalized: AlertRule = {
    ...input,
    observationKey: input.observationKey?.trim() || undefined,
    hysteresis: Number.isFinite(input.hysteresis) ? Math.max(0, input.hysteresis) : 0,
    cooldownMinutes: Number.isFinite(input.cooldownMinutes) ? Math.max(0, Math.round(input.cooldownMinutes)) : 60,
    updatedAt: now,
    createdAt: input.createdAt ?? now,
    walletAddress: input.walletAddress.trim().toLowerCase(),
  };
  const existingIndex = getAlertRulesStore().findIndex((rule) => rule.id === normalized.id && rule.walletAddress === normalized.walletAddress);

  if (existingIndex >= 0) {
    getAlertRulesStore()[existingIndex] = normalized;
  } else {
    getAlertRulesStore().unshift(normalized);
  }
  mirrorAlertRuleWriteDeferred(normalized);

  return normalized;
}

export function deleteAlertRule(id: string, walletAddress?: string) {
  const store = getAlertRulesStore();
  const normalized = normalizeWallet(walletAddress);
  const targetIndex = store.findIndex((rule) => rule.id === id && (!normalized || rule.walletAddress === normalized));

  if (targetIndex < 0) return false;

  store.splice(targetIndex, 1);

  return true;
}

export function listAlertObservations(walletAddress?: string, limit = 200) {
  return [...getAlertObservationsStore()]
    .filter(withNormalizedWallet(walletAddress))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .slice(0, limit);
}

export function createAlertObservation(input: Omit<AlertObservation, "id" | "createdAt">) {
  const observation: AlertObservation = {
    id: createRecordId("obs"),
    createdAt: new Date().toISOString(),
    ...input,
    walletAddress: input.walletAddress.trim().toLowerCase(),
  };

  getAlertObservationsStore().unshift(observation);
  mirrorAlertObservationWriteDeferred(observation);

  return observation;
}

export function listAlerts(walletAddress?: string, status?: Alert["status"], limit = 200) {
  const normalizedWallet = normalizeWallet(walletAddress);

  return [...getAlertsStore()]
    .filter((alert) => !normalizedWallet || alert.walletAddress === normalizedWallet)
    .filter((alert) => !status || alert.status === status)
    .sort((left, right) => new Date(right.triggeredAt).getTime() - new Date(left.triggeredAt).getTime())
    .slice(0, limit);
}

export function getAlert(id: string, walletAddress?: string) {
  const alert = getAlertsStore().find((record) => record.id === id);

  if (!alert) return undefined;
  if (walletAddress && alert.walletAddress !== normalizeWallet(walletAddress)) return undefined;

  return alert;
}

export function createAlert(input: Omit<Alert, "id" | "triggeredAt">) {
  const alert: Alert = {
    id: createAlertId(),
    triggeredAt: new Date().toISOString(),
    ...input,
    walletAddress: input.walletAddress.trim().toLowerCase(),
  };

  getAlertsStore().unshift(alert);
  mirrorAlertWriteDeferred(alert);

  return alert;
}

export function updateAlert(id: string, walletAddress: string, patch: Partial<Alert>) {
  const store = getAlertsStore();
  const normalized = normalizeWallet(walletAddress);
  const index = store.findIndex((record) => record.id === id && record.walletAddress === normalized);

  if (index < 0) return undefined;

  store[index] = { ...store[index], ...patch };
  mirrorAlertUpdateDeferred(store[index]);

  return store[index];
}

export function listAlertDeliveries(alertId?: string, walletAddress?: string) {
  return [...getAlertDeliveriesStore()]
    .filter((delivery) => !alertId || delivery.alertId === alertId)
    .filter(withNormalizedWallet(walletAddress))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

export function createAlertDelivery(input: Omit<AlertDelivery, "id" | "createdAt">) {
  const delivery: AlertDelivery = {
    id: createRecordId("delivery"),
    createdAt: new Date().toISOString(),
    ...input,
    walletAddress: input.walletAddress.trim().toLowerCase(),
  };

  getAlertDeliveriesStore().unshift(delivery);
  mirrorAlertDeliveryWriteDeferred(delivery);

  return delivery;
}

export function updateAlertDelivery(id: string, walletAddress: string, patch: Partial<AlertDelivery>) {
  const store = getAlertDeliveriesStore();
  const index = store.findIndex((record) => record.id === id && record.walletAddress === walletAddress.toLowerCase());

  if (index < 0) return undefined;

  store[index] = { ...store[index], ...patch };
  mirrorAlertDeliveryUpdateDeferred(store[index]);

  return store[index];
}

export function summarizeDeliveries(deliveries: AlertDelivery[]) {
  const deliverableByChannel: Record<AlertDeliveryChannel, string> = {
    in_app: "delivered",
    email: "no_env",
    telegram: "no_env",
    discord: "no_env",
  };

  return {
    delivered: deliveries.filter((delivery) => delivery.status === "delivered").map((delivery) => delivery.channel),
    failed: deliveries
      .filter((delivery) => delivery.status === "failed")
      .map((delivery) => ({ channel: delivery.channel, error: delivery.errorDetail ?? "delivery failed" })),
    skipped: [
      ...deliveries
        .filter((delivery) => delivery.status === "skipped")
        .map((delivery) => ({ channel: delivery.channel, reason: delivery.errorDetail ?? "skipped" })),
      ...(["in_app", "email", "telegram", "discord"] as AlertDeliveryChannel[])
        .filter((channel) => !deliveries.some((delivery) => delivery.channel === channel))
        .map((channel) => ({ channel, reason: deliverableByChannel[channel] === "delivered" ? "in-app inbox is always available" : "delivery channel is not configured" })),
    ],
  };
}

export function listAgentRunRecords(walletAddress?: string) {
  const normalizedWallet = walletAddress?.toLowerCase();

  return getAgentRuns()
    .filter((record) => !normalizedWallet || record.walletAddress.toLowerCase() === normalizedWallet)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

export function getAgentRunRecord(id: string) {
  return getAgentRuns().find((record) => record.id === id);
}

export function createAgentRunRecord(input: CreateAgentRunInput): AgentRunRecord {
  for (const result of input.results) {
    const parsed = validateAgentResult(result);

    if (!parsed.success) {
      throw new Error(`Invalid AgentResult cannot be stored for ${result.agent}: ${parsed.error.message}`);
    }
  }

  const decision = [...input.results].reverse().find((result) => result.agent === "decision");
  const failed = input.results.some((result) => result.status === "error" || result.status === "unavailable");
  const completed = input.results.some((result) => result.agent === "decision");
  const sourceStatuses = input.results.map((result) => ({
    agent: result.agent,
    connected: result.sources.filter((source) => source.status === "connected").length,
    unavailable: result.sources.filter((source) => source.status === "unavailable").length,
    mock: result.sources.filter((source) => source.status === "mock").length,
  }));
  const resultSnapshots = input.results.map((result) => ({
    agent: result.agent,
    rawSignals: result.rawSignals ?? {},
    sources: result.sources,
    sourceSnapshotHash: hashSourceSnapshot({
      agent: result.agent,
      sources: result.sources,
      rawSignals: result.rawSignals ?? {},
    }),
    immutable: true,
    decisionExplanation: result.agent === "decision" ? result.rawSignals?.explanation : undefined,
  }));
  const record: AgentRunRecord = {
    id: createId(),
    walletAddress: input.walletAddress,
    mode: input.mode,
    targetToken: input.targetToken,
    status: completed ? (failed ? "partial" : "completed") : "failed",
    recommendation: decision?.recommendedAction ?? "manual_review",
    decisionScore: decision?.score ?? Math.max(...input.results.map((result) => result.score), 50),
    confidence: decision?.confidence ?? 0.28,
    summary: decision?.summary ?? "Agent run ended before a final decision was produced.",
    results: input.results,
    sourceStatuses,
    inputSnapshot: {
      ...(input.inputSnapshot ?? {}),
      resultSnapshots,
    },
    userAction: input.userAction ?? "pending",
    createdAt: new Date().toISOString(),
  };

  getAgentRuns().unshift(record);
  createRecommendationRecord({
    runId: record.id,
    walletAddress: record.walletAddress,
    action: record.recommendation,
    decisionScore: record.decisionScore,
    confidence: record.confidence,
    summary: record.summary,
  });

  return record;
}

export function listRecommendationRecords(walletAddress?: string) {
  const normalizedWallet = walletAddress?.toLowerCase();

  return getRecommendations()
    .filter((record) => !normalizedWallet || record.walletAddress.toLowerCase() === normalizedWallet)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

export function createRecommendationRecord(input: Omit<RecommendationRecord, "id" | "createdAt">) {
  const record: RecommendationRecord = {
    id: createRecordId("rec"),
    createdAt: new Date().toISOString(),
    ...input,
  };

  getRecommendations().unshift(record);

  return record;
}

export function listTransactionRecords(walletAddress?: string) {
  const normalizedWallet = walletAddress?.toLowerCase();

  return getTransactions()
    .filter((record) => !normalizedWallet || record.walletAddress?.toLowerCase() === normalizedWallet)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

export function getTransactionRecord(hash: string) {
  return getTransactions().find((record) => record.hash.toLowerCase() === hash.toLowerCase());
}

export function createTransactionRecord(input: Omit<TransactionRecord, "createdAt"> & { createdAt?: string }) {
  const existingIndex = getTransactions().findIndex((record) => record.hash.toLowerCase() === input.hash.toLowerCase());
  const record: TransactionRecord = {
    ...input,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };

  if (existingIndex >= 0) {
    getTransactions()[existingIndex] = record;
  } else {
    getTransactions().unshift(record);
  }

  return record;
}

export function listApprovalRecords(walletAddress?: string) {
  const normalizedWallet = walletAddress?.toLowerCase();

  return getApprovals()
    .filter((record) => !normalizedWallet || record.walletAddress.toLowerCase() === normalizedWallet)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

export function createApprovalRecord(input: Omit<UserApprovalRecord, "id" | "createdAt" | "status" | "autoExecuted">) {
  const record: UserApprovalRecord = {
    id: createRecordId("approval"),
    ...input,
    status: "confirmed",
    autoExecuted: false,
    createdAt: new Date().toISOString(),
  };

  getApprovals().unshift(record);

  return record;
}

export function getUserRuleRecord(walletAddress = "0xDemoWallet") {
  const existing = getUserRules().find((rule) => rule.walletAddress.toLowerCase() === walletAddress.toLowerCase());

  return {
    ...getDefaultRules(walletAddress),
    ...existing,
    autoExecute: false,
  };
}

export function upsertUserRuleRecord(input: UserRule) {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const defaults = getDefaultRules(input.walletAddress);
  const record: UserRule = {
    ...defaults,
    ...input,
    autoExecute: false,
    createdAt,
  };
  const existingIndex = getUserRules().findIndex((rule) => rule.walletAddress.toLowerCase() === input.walletAddress.toLowerCase());

  if (existingIndex >= 0) {
    getUserRules()[existingIndex] = record;
  } else {
    getUserRules().unshift(record);
  }

  return record;
}

export function listX402PaymentReceipts() {
  return getX402PaymentReceipts().sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

export function getX402PaymentReceiptByHeaderHash(paymentHeaderHash: string) {
  return getX402PaymentReceipts().find((record) => record.paymentHeaderHash === paymentHeaderHash);
}

export function createX402PaymentReceipt(input: Omit<X402PaymentReceipt, "id" | "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }) {
  const existing =  getX402PaymentReceiptByHeaderHash(input.paymentHeaderHash);

  if (existing) {
    return {
      ...existing,
      verificationStatus: "duplicate" as const,
      updatedAt: new Date().toISOString(),
    };
  }

  const createdAt = input.createdAt ?? new Date().toISOString();
  const record: X402PaymentReceipt = {
    id: createRecordId("x402"),
    ...input,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
  };

  getX402PaymentReceipts().unshift(record);

  return record;
}
type CreateWatchlistInput = WatchlistEntryInput & {
  identityKey: string;
};

export function listWatchlistEntries(walletAddress?: string) {
  const normalizedWallet = walletAddress?.toLowerCase();

  return getWatchlistEntries()
    .filter((entry) => !normalizedWallet || entry.walletAddress.toLowerCase() === normalizedWallet)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

export function getWatchlistEntry(id: string) {
  return getWatchlistEntries().find((entry) => entry.id === id);
}

export type AddWatchlistEntryResult = {
  entry: WatchlistEntry;
  alreadyExisted: boolean;
};

export function addWatchlistEntry(input: CreateWatchlistInput): AddWatchlistEntryResult {
  const normalizedWallet = input.walletAddress.trim();
  const existing = getWatchlistEntries().find(
    (entry) =>
      entry.walletAddress.toLowerCase() === normalizedWallet.toLowerCase() &&
      entry.identityKey === input.identityKey,
  );

  if (existing) {
    return { entry: existing, alreadyExisted: true };
  }

  const entry: WatchlistEntry = {
    id: createRecordId("watch"),
    walletAddress: normalizedWallet,
    identityKey: input.identityKey,
    chain: input.chain,
    contractAddress: input.contractAddress,
    pairAddress: input.pairAddress,
    symbol: input.symbol,
    tokenName: input.tokenName,
    assetKey: input.assetKey,
    issuer: input.issuer,
    assetType: input.assetType,
    source: input.source,
    note: input.note,
    createdAt: new Date().toISOString(),
  };

  getWatchlistEntries().unshift(entry);

  return { entry, alreadyExisted: false };
}

export function removeWatchlistEntry(id: string) {
  const store = getWatchlistEntries();
  const remaining = store.filter((entry) => entry.id !== id);
  const removed = store.length - remaining.length;

  memoryStore.__goldenRaccoonWatchlistEntries = remaining;

  const runs = getWatchlistScanRuns().filter((run) => run.entryId !== id);
  memoryStore.__goldenRaccoonWatchlistScanRuns = runs;

  const alerts = getDiscoveryAlerts().filter((alert) => alert.entryId !== id);
  memoryStore.__goldenRaccoonDiscoveryAlerts = alerts;

  return removed > 0;
}

type AddWatchlistScanRunInput = {
  entryId: string;
  walletAddress: string;
  identityKey: string;
  classification: DiscoveryClassification;
  classificationReasons: string[];
  confidence: number;
  score: number;
  sourceLineage: AgentSource[];
  missingData: AgentMissingData[];
  riskReport?: WatchlistScanRun["riskReport"];
  agentRunId?: string;
  status?: WatchlistScanRun["status"];
};

export function addWatchlistScanRun(input: AddWatchlistScanRunInput): WatchlistScanRun {
  const previous = getWatchlistScanRuns()
    .filter((run) => run.entryId === input.entryId)
    .sort((left, right) => new Date(right.scannedAt).getTime() - new Date(left.scannedAt).getTime())[0];

  const run: WatchlistScanRun = {
    id: createRecordId("wscan"),
    entryId: input.entryId,
    walletAddress: input.walletAddress,
    identityKey: input.identityKey,
    agentRunId: input.agentRunId,
    classification: input.classification,
    classificationReasons: input.classificationReasons,
    confidence: input.confidence,
    score: input.score,
    sourceLineage: input.sourceLineage,
    missingData: input.missingData,
    riskReport: input.riskReport,
    status: input.status ?? "completed",
    previousRunId: previous?.id,
    scannedAt: new Date().toISOString(),
  };

  getWatchlistScanRuns().unshift(run);
  updateWatchlistEntryLatestScan(input.entryId, {
    scanRunId: run.id,
    classification: run.classification,
    score: run.score,
    scannedAt: run.scannedAt,
    status: run.status,
  });

  return run;
}

export function updateWatchlistEntryLatestScan(
  id: string,
  update: {
    scanRunId: string;
    classification: DiscoveryClassification;
    score: number;
    scannedAt: string;
    status: WatchlistScanRun["status"];
  },
) {
  const entry = getWatchlistEntries().find((candidate) => candidate.id === id);

  if (!entry) {
    return undefined;
  }

  entry.lastScannedAt = update.scannedAt;
  entry.latestScanRunId = update.scanRunId;
  entry.latestStatus = update.status === "failed" ? "stale" : update.status;

  if (update.status === "failed") {
    const hasPriorSuccess = entry.successfulScanRunIds && entry.successfulScanRunIds.length > 0;

    if (!hasPriorSuccess) {
      entry.latestStatus = "stale";
    }
  } else {
    entry.latestClassification = update.classification;
    entry.latestScore = update.score;
    entry.successfulScanRunIds = [update.scanRunId, ...(entry.successfulScanRunIds ?? [])].slice(0, 50);
  }

  return entry;
}

export function listWatchlistScanRuns(entryId?: string) {
  return getWatchlistScanRuns()
    .filter((run) => !entryId || run.entryId === entryId)
    .sort((left, right) => new Date(right.scannedAt).getTime() - new Date(left.scannedAt).getTime());
}

type CreateDiscoveryAlertInput = {
  walletAddress: string;
  entryId?: string;
  runId?: string;
  kind: DiscoveryAlert["kind"];
  title: string;
  detail: string;
  severity: RiskLevel;
  sourceLabel?: string;
};

export function createDiscoveryAlert(input: CreateDiscoveryAlertInput): DiscoveryAlert {
  const alert: DiscoveryAlert = {
    id: createRecordId("alert"),
    walletAddress: input.walletAddress,
    entryId: input.entryId,
    runId: input.runId,
    kind: input.kind,
    title: input.title,
    detail: input.detail,
    severity: input.severity,
    sourceLabel: input.sourceLabel,
    acknowledged: false,
    createdAt: new Date().toISOString(),
  };

  getDiscoveryAlerts().unshift(alert);

  return alert;
}

export function listDiscoveryAlerts(walletAddress?: string) {
  const normalizedWallet = walletAddress?.toLowerCase();

  return getDiscoveryAlerts()
    .filter((alert) => !normalizedWallet || alert.walletAddress.toLowerCase() === normalizedWallet)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

export function acknowledgeDiscoveryAlert(id: string) {
  const alert = getDiscoveryAlerts().find((candidate) => candidate.id === id);

  if (!alert) {
    return undefined;
  }

  alert.acknowledged = true;

  return alert;
}
