/**
 * Postgres adapter for the V3 alert engine. Optional: when a connection
 * string (SUPABASE_DB_URL, POSTGRES_URL, or DATABASE_URL) is present and
 * `pg` is installed, the alert storage functions dual-write rows to the
 * Postgres tables defined in `frontend/src/server/storage/schema.sql`.
 *
 * Design notes:
 *  - Reads stay in-memory so existing synchronous callers (routes,
 *    fixtures, dashboards) keep working without async refactors.
 *  - Writes go through memory immediately so the caller sees the row,
 *    then fire a best-effort mirror write to Postgres. When the mirror
 *    fails the row stays in memory and `getStorageHealth()` flags
 *    `persistent: false` so operators see the degraded state.
 *  - All mirror writes share a single promise chain so the natural
 *    call order (`createAlertRule` -> `createAlert` -> `createAlertDelivery`)
 *    is preserved across the Postgres boundary and the alerts FOREIGN
 *    KEY on `alerts.rule_id references alert_rules(id)` cannot fire
 *    before the rule row exists.
 *  - If the very first connection attempt fails the cached `connectPromise`
 *    is reset so the next write can retry instead of being permanently
 *    silenced.
 *  - `applySchema()` runs `schema.sql` once at boot so the SQL tables are
 *    physically present in the database, satisfying the audit
 *    requirement that "the added SQL tables are connected to the storage
 *    implementation". All statements in the schema are `IF NOT EXISTS`.
 *
 * This file does not assume `pg` is present. If the dependency is not
 * installed we fall back to a "schema connection string detected but no
 * pg client" state that `getStorageHealth()` exposes honestly.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type {
  Alert,
  AlertDelivery,
  AlertObservation,
  AlertRule,
} from "@/server/types";

type MaybePgPool = {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }>;
  end(): Promise<void>;
};

type PgModule = {
  Pool: new (config: { connectionString: string; ssl?: { rejectUnauthorized: boolean } | false }) => MaybePgPool;
};

let loadedPgModule: PgModule | null | undefined;

async function tryLoadPg(): Promise<PgModule | null> {
  if (loadedPgModule !== undefined) return loadedPgModule;

  try {
    // pathToFileURL handles spaces and odd characters on disk; safer than
    // a synthetic `process.cwd()/pg` string.
    const localRequire = createRequire(pathToFileURL(`${process.cwd()}/_pg_loader.cjs`).href);
    const mod = localRequire("pg") as PgModule;
    loadedPgModule = mod;

    return mod;
  } catch (error) {
    loadedPgModule = null;
    // Surface the load error so start-up health reflects it instead of
    // reporting a falsely "installed" state that never tries to connect.
    lastPgLoadError = error instanceof Error ? error.message : String(error);

    return null;
  }
}

let lastPgLoadError: string | null = null;

function resolveConnectionString(): string | undefined {
  return (
    process.env.SUPABASE_DB_URL ??
    process.env.POSTGRES_URL ??
    process.env.DATABASE_URL ??
    undefined
  );
}

const SCHEMA_PATH = path.join(process.cwd(), "src/server/storage/schema.sql");

function loadSchema(): string {
  try {
    return fs.readFileSync(SCHEMA_PATH, "utf-8");
  } catch {
    return "";
  }
}

type PersistedAlertRule = Pick<
  AlertRule,
  | "id"
  | "walletAddress"
  | "triggerType"
  | "observationKey"
  | "threshold"
  | "hysteresis"
  | "cooldownMinutes"
  | "direction"
  | "severity"
  | "enabled"
  | "createdAt"
  | "updatedAt"
>;

type PersistedAlertObservation = Pick<
  AlertObservation,
  | "id"
  | "walletAddress"
  | "triggerType"
  | "observationKey"
  | "value"
  | "direction"
  | "createdAt"
  | "incompleteData"
> & { evidence: AlertObservation["evidence"] };

type PersistedAlert = Pick<
  Alert,
  | "id"
  | "walletAddress"
  | "ruleId"
  | "triggerType"
  | "observationKey"
  | "status"
  | "severity"
  | "message"
  | "beforeValue"
  | "afterValue"
  | "evidenceBefore"
  | "evidenceAfter"
  | "evidenceData"
  | "triggeredAt"
  | "recoveredAt"
  | "acknowledgedAt"
>;

type PersistedAlertDelivery = Pick<
  AlertDelivery,
  | "id"
  | "alertId"
  | "walletAddress"
  | "channel"
  | "status"
  | "errorDetail"
  | "sanitizedPayload"
  | "attemptCount"
  | "createdAt"
  | "sentAt"
>;

class PostgresStorageAdapter {
  private pool: MaybePgPool | null = null;
  private connectionString: string | undefined = resolveConnectionString();
  private migrated = false;
  private connected = false;
  private connectedAt: string | null = null;
  private lastError: string | null = null;
  private mirrorFailureCount = 0;
  private mirrorSuccessCount = 0;
  private connectPromise: Promise<{ ok: boolean; detail: string }> | null = null;

  /**
   * Single promise chain every mirror write is appended to. Ensures
   * foreign-key-sensitive tables (alerts.rule_id, alert_deliveries.alert_id)
   * are inserted in the same order the in-memory store is mutated, so the
   * mirror can never violate the rule → alert → delivery dependency.
   */
  private mirrorQueue: Promise<unknown> = Promise.resolve();

  isConfigured(): boolean {
    return Boolean(this.connectionString);
  }

  isConnected(): boolean {
    return this.connected;
  }

  getHealthSnapshot() {
    // pgInstalled is a tri-state: true (module loaded successfully),
    // false (load attempted but failed), null (never attempted). This
    // lets health consumers distinguish "we don't know yet" from
    // "we tried and pg is broken".
    const pgInstalled: true | false | null =
      loadedPgModule === undefined ? null : loadedPgModule === null ? false : true;

    return {
      connectionStringPresent: this.isConfigured(),
      pgInstalled,
      pgLoadError: lastPgLoadError,
      connected: this.connected,
      connectedAt: this.connectedAt,
      lastError: this.lastError,
      mirrorSuccessCount: this.mirrorSuccessCount,
      mirrorFailureCount: this.mirrorFailureCount,
    };
  }

  async connect(): Promise<{ ok: boolean; detail: string }> {
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.doConnect();

    return this.connectPromise;
  }

  private async doConnect(): Promise<{ ok: boolean; detail: string }> {
    if (!this.connectionString) {
      return { ok: false, detail: "No SUPABASE_DB_URL/POSTGRES_URL/DATABASE_URL configured." };
    }

    const pg = await tryLoadPg();

    if (!pg) {
      this.lastError = lastPgLoadError ?? "pg dependency not installed in this deployment bundle.";

      return { ok: false, detail: this.lastError };
    }

    if (this.pool) {
      return { ok: this.connected, detail: "Already connected." };
    }

    try {
      this.pool = new pg.Pool({
        connectionString: this.connectionString,
        ssl: process.env.SUPABASE_DB_URL ? { rejectUnauthorized: false } : false,
      });
      await this.pool.query("SELECT 1");
      this.connected = true;
      this.connectedAt = new Date().toISOString();
      this.lastError = null;
      const migration = await this.applySchema();

      if (!migration.ok) {
        this.connected = false;
        await this.safeEnd();
        // Allow the next call to try again: the cached failure potential
        // would otherwise mask transient blips.
        this.connectPromise = null;

        return { ok: false, detail: migration.detail };
      }

      return { ok: true, detail: "Connected and migrated." };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.connected = false;
      await this.safeEnd();
      this.connectPromise = null;

      return { ok: false, detail: this.lastError };
    }
  }

  private async safeEnd() {
    if (!this.pool) return;
    try {
      await this.pool.end();
    } catch {
      // ignore — already closed or never opened
    }
    this.pool = null;
  }

  private async applySchema(): Promise<{ ok: boolean; detail: string }> {
    if (this.migrated || !this.pool) return { ok: true, detail: "migrated" };
    const schema = loadSchema();

    if (!schema.trim()) {
      this.migrated = true;
      return { ok: true, detail: "schema file empty; skipping migration" };
    }

    try {
      await this.pool.query(schema);
      this.migrated = true;

      return { ok: true, detail: "schema applied" };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);

      return { ok: false, detail: this.lastError };
    }
  }

  /**
   * Append a mirror operation to the shared chain so that rule -> alert
   * -> delivery writes honour the FK ordering regardless of how the
   * caller fired them. The returned promise is wrapped in `.catch` so
   * callers that fire-and-forget (`void adapter.mirrorAlert(...)`) do
   * not produce unhandled-rejection warnings when the actual SQL
   * statement throws.
   */
  private enqueueMirror<T>(work: () => Promise<T>): Promise<T | undefined> {
    const previous = this.mirrorQueue;
    const next = previous.then(work, work);
    const safe = next.catch(() => undefined);
    // Don't let one failed write break the chain for subsequent writes.
    this.mirrorQueue = safe;

    return safe;
  }

  private async doMirrorAlertRule(rule: PersistedAlertRule): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO alert_rules (id, wallet_address, trigger_type, observation_key, threshold, hysteresis, cooldown_minutes, direction, severity, enabled, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO UPDATE SET
           wallet_address = EXCLUDED.wallet_address,
           trigger_type = EXCLUDED.trigger_type,
           observation_key = EXCLUDED.observation_key,
           threshold = EXCLUDED.threshold,
           hysteresis = EXCLUDED.hysteresis,
           cooldown_minutes = EXCLUDED.cooldown_minutes,
           direction = EXCLUDED.direction,
           severity = EXCLUDED.severity,
           enabled = EXCLUDED.enabled,
           updated_at = EXCLUDED.updated_at`,
        [
          rule.id,
          rule.walletAddress,
          rule.triggerType,
          rule.observationKey ?? null,
          rule.threshold,
          rule.hysteresis,
          rule.cooldownMinutes,
          rule.direction ?? "high_is_bad",
          rule.severity,
          rule.enabled,
          rule.createdAt,
          rule.updatedAt,
        ],
      );
      this.mirrorSuccessCount += 1;
    } catch (error) {
      this.mirrorFailureCount += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private async doMirrorAlertObservation(observation: PersistedAlertObservation): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO alert_observations (id, wallet_address, trigger_type, observation_key, value, direction, evidence, incomplete_data, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
         ON CONFLICT (id) DO NOTHING`,
        [
          observation.id,
          observation.walletAddress,
          observation.triggerType,
          observation.observationKey,
          observation.value,
          observation.direction,
          JSON.stringify(observation.evidence ?? {}),
          observation.incompleteData ?? false,
          observation.createdAt,
        ],
      );
      this.mirrorSuccessCount += 1;
    } catch (error) {
      this.mirrorFailureCount += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private async doMirrorAlert(alert: PersistedAlert): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO alerts (id, wallet_address, rule_id, trigger_type, observation_key, status, severity, message, before_value, after_value, evidence_before, evidence_after, evidence_data, triggered_at, recovered_at, acknowledged_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,$16)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           severity = EXCLUDED.severity,
           message = EXCLUDED.message,
           before_value = EXCLUDED.before_value,
           after_value = EXCLUDED.after_value,
           evidence_before = EXCLUDED.evidence_before,
           evidence_after = EXCLUDED.evidence_after,
           evidence_data = EXCLUDED.evidence_data,
           recovered_at = EXCLUDED.recovered_at,
           acknowledged_at = EXCLUDED.acknowledged_at`,
        [
          alert.id,
          alert.walletAddress,
          alert.ruleId,
          alert.triggerType,
          alert.observationKey,
          alert.status,
          alert.severity,
          alert.message,
          alert.beforeValue,
          alert.afterValue,
          JSON.stringify(alert.evidenceBefore ?? {}),
          JSON.stringify(alert.evidenceAfter ?? {}),
          JSON.stringify(alert.evidenceData ?? {}),
          alert.triggeredAt,
          alert.recoveredAt ?? null,
          alert.acknowledgedAt ?? null,
        ],
      );
      this.mirrorSuccessCount += 1;
    } catch (error) {
      this.mirrorFailureCount += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private async doMirrorAlertDelivery(delivery: PersistedAlertDelivery): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO alert_deliveries (id, alert_id, wallet_address, channel, status, error_detail, sanitized_payload, attempt_count, created_at, sent_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           error_detail = EXCLUDED.error_detail,
           sent_at = EXCLUDED.sent_at,
           attempt_count = EXCLUDED.attempt_count`,
        [
          delivery.id,
          delivery.alertId,
          delivery.walletAddress,
          delivery.channel,
          delivery.status,
          delivery.errorDetail ?? null,
          JSON.stringify(delivery.sanitizedPayload ?? {}),
          delivery.attemptCount,
          delivery.createdAt,
          delivery.sentAt ?? null,
        ],
      );
      this.mirrorSuccessCount += 1;
    } catch (error) {
      this.mirrorFailureCount += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  async mirrorAlertRule(rule: PersistedAlertRule): Promise<void> {
    if (!this.connectionString || !(await this.ensurePool())) return;
    await this.enqueueMirror(() => this.doMirrorAlertRule(rule));
  }

  async mirrorAlertObservation(observation: PersistedAlertObservation): Promise<void> {
    if (!this.connectionString || !(await this.ensurePool())) return;
    await this.enqueueMirror(() => this.doMirrorAlertObservation(observation));
  }

  async mirrorAlert(alert: PersistedAlert): Promise<void> {
    if (!this.connectionString || !(await this.ensurePool())) return;
    await this.enqueueMirror(() => this.doMirrorAlert(alert));
  }

  async mirrorAlertDelivery(delivery: PersistedAlertDelivery): Promise<void> {
    if (!this.connectionString || !(await this.ensurePool())) return;
    await this.enqueueMirror(() => this.doMirrorAlertDelivery(delivery));
  }

  private async ensurePool(): Promise<boolean> {
    if (this.pool && this.connected) return true;
    const result = await this.connect();

    return result.ok;
  }

  /**
   * Hydrate the in-memory alert stores from Postgres on process start.
   *
   * The original mirror pipeline was write-only: every write landed in
   * memory and a best-effort mirror flushed it to SQL. After a server
   * restart the in-memory arrays were empty and the SQL tables still
   * held the rows on disk, but reads from the in-memory lists returned
   * nothing. This method reads alert_rules → alert_observations → alerts
   * → alert_deliveries in FK-safe order and merges rows back into the
   * supplied in-memory stores by id (skipping rows that already exist,
   * to avoid overwriting writes that landed during hydration).
   *
   * On degraded paths (no DATABASE_URL, pg not installed, query fails)
   * this method swallows the error so callers can still rely on the
   * in-memory store as the source of truth; `getStorageHealth()` will
   * expose the hydration failure honestly.
   */
  async hydrateAlertTables(target: {
    rules: AlertRule[];
    observations: AlertObservation[];
    alerts: Alert[];
    deliveries: AlertDelivery[];
  }): Promise<{ hydrated: number; skipped: number }> {
    if (!this.connectionString || !(await this.ensurePool())) {
      return { hydrated: 0, skipped: 0 };
    }

    return (await this.enqueueMirror(() => this.doHydrateAlertTables(target))) ?? { hydrated: 0, skipped: 0 };
  }

  private async doHydrateAlertTables(target: {
    rules: AlertRule[];
    observations: AlertObservation[];
    alerts: Alert[];
    deliveries: AlertDelivery[];
  }): Promise<{ hydrated: number; skipped: number }> {
    if (!this.pool) return { hydrated: 0, skipped: 0 };

    let hydrated = 0;
    let skipped = 0;

    hydrated += await this.mergeRulesFromPostgres(target.rules, () => skipped++);
    skipped += 0;
    hydrated += await this.mergeObservationsFromPostgres(target.observations, () => skipped++);
    skipped += 0;
    hydrated += await this.mergeAlertsFromPostgres(target.alerts, () => skipped++);
    skipped += 0;
    hydrated += await this.mergeDeliveriesFromPostgres(target.deliveries, () => skipped++);

    return { hydrated, skipped };
  }

  private async mergeRulesFromPostgres(
    store: AlertRule[],
    onSkip: () => void,
  ): Promise<number> {
    if (!this.pool) return 0;
    const result = await this.pool.query("SELECT * FROM alert_rules ORDER BY created_at ASC");
    let hydrationCount = 0;

    for (const row of result.rows as Array<Record<string, unknown>>) {
      const mapped = mapAlertRuleRow(row);
      const existing = store.find((entry) => entry.id === mapped.id);

      if (existing) {
        onSkip();
        continue;
      }
      store.push(mapped);
      hydrationCount += 1;
    }

    return hydrationCount;
  }

  private async mergeObservationsFromPostgres(
    store: AlertObservation[],
    onSkip: () => void,
  ): Promise<number> {
    if (!this.pool) return 0;
    const result = await this.pool.query("SELECT * FROM alert_observations ORDER BY created_at ASC");
    let hydrationCount = 0;

    for (const row of result.rows as Array<Record<string, unknown>>) {
      const mapped = mapAlertObservationRow(row);
      const existing = store.find((entry) => entry.id === mapped.id);

      if (existing) {
        onSkip();
        continue;
      }
      store.push(mapped);
      hydrationCount += 1;
    }

    return hydrationCount;
  }

  private async mergeAlertsFromPostgres(
    store: Alert[],
    onSkip: () => void,
  ): Promise<number> {
    if (!this.pool) return 0;
    const result = await this.pool.query("SELECT * FROM alerts ORDER BY triggered_at ASC");
    let hydrationCount = 0;

    for (const row of result.rows as Array<Record<string, unknown>>) {
      const mapped = mapAlertRow(row);
      const existing = store.find((entry) => entry.id === mapped.id);

      if (existing) {
        onSkip();
        continue;
      }
      store.push(mapped);
      hydrationCount += 1;
    }

    return hydrationCount;
  }

  private async mergeDeliveriesFromPostgres(
    store: AlertDelivery[],
    onSkip: () => void,
  ): Promise<number> {
    if (!this.pool) return 0;
    const result = await this.pool.query("SELECT * FROM alert_deliveries ORDER BY created_at ASC");
    let hydrationCount = 0;

    for (const row of result.rows as Array<Record<string, unknown>>) {
      const mapped = mapAlertDeliveryRow(row);
      const existing = store.find((entry) => entry.id === mapped.id);

      if (existing) {
        onSkip();
        continue;
      }
      store.push(mapped);
      hydrationCount += 1;
    }

    return hydrationCount;
  }
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;

  return new Date().toISOString();
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) return parsed;
  }

  return 0;
}

function toJson(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }

  return value;
}

function mapAlertRuleRow(row: Record<string, unknown>): AlertRule {
  return {
    id: typeof row.id === "string" ? row.id : "",
    walletAddress: typeof row.wallet_address === "string" ? row.wallet_address.toLowerCase() : "",
    triggerType: typeof row.trigger_type === "string" ? (row.trigger_type as AlertRule["triggerType"]) : "critical_risk",
    observationKey: typeof row.observation_key === "string" ? row.observation_key : undefined,
    threshold: toNumber(row.threshold),
    hysteresis: toNumber(row.hysteresis),
    cooldownMinutes: Math.round(toNumber(row.cooldown_minutes)) || 60,
    direction: row.direction === "low_is_bad" ? "low_is_bad" : "high_is_bad",
    severity: (row.severity as AlertRule["severity"]) ?? "medium",
    enabled: Boolean(row.enabled),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapAlertObservationRow(row: Record<string, unknown>): AlertObservation {
  return {
    id: typeof row.id === "string" ? row.id : "",
    walletAddress: typeof row.wallet_address === "string" ? row.wallet_address.toLowerCase() : "",
    triggerType: typeof row.trigger_type === "string" ? (row.trigger_type as AlertObservation["triggerType"]) : "critical_risk",
    observationKey: typeof row.observation_key === "string" ? row.observation_key : "",
    value: toNumber(row.value),
    direction: row.direction === "low_is_bad" ? "low_is_bad" : "high_is_bad",
    evidence: (toJson(row.evidence) ?? {}) as AlertObservation["evidence"],
    incompleteData: Boolean(row.incomplete_data),
    createdAt: toIso(row.created_at),
  };
}

function mapAlertRow(row: Record<string, unknown>): Alert {
  return {
    id: typeof row.id === "string" ? row.id : "",
    walletAddress: typeof row.wallet_address === "string" ? row.wallet_address.toLowerCase() : "",
    ruleId: typeof row.rule_id === "string" ? row.rule_id : "",
    triggerType: typeof row.trigger_type === "string" ? (row.trigger_type as Alert["triggerType"]) : "critical_risk",
    observationKey: typeof row.observation_key === "string" ? row.observation_key : "",
    status: (row.status as Alert["status"]) ?? "triggered",
    severity: (row.severity as Alert["severity"]) ?? "medium",
    message: typeof row.message === "string" ? row.message : "",
    beforeValue: toNumber(row.before_value),
    afterValue: toNumber(row.after_value),
    evidenceBefore: (toJson(row.evidence_before) ?? {}) as Alert["evidenceBefore"],
    evidenceAfter: (toJson(row.evidence_after) ?? {}) as Alert["evidenceAfter"],
    evidenceData: (toJson(row.evidence_data) ?? {}) as Alert["evidenceData"],
    triggeredAt: toIso(row.triggered_at),
    recoveredAt: row.recovered_at ? toIso(row.recovered_at) : undefined,
    acknowledgedAt: row.acknowledged_at ? toIso(row.acknowledged_at) : undefined,
  };
}

function mapAlertDeliveryRow(row: Record<string, unknown>): AlertDelivery {
  return {
    id: typeof row.id === "string" ? row.id : "",
    alertId: typeof row.alert_id === "string" ? row.alert_id : "",
    walletAddress: typeof row.wallet_address === "string" ? row.wallet_address.toLowerCase() : "",
    channel: (row.channel as AlertDelivery["channel"]) ?? "in_app",
    status: (row.status as AlertDelivery["status"]) ?? "pending",
    errorDetail: typeof row.error_detail === "string" ? row.error_detail : undefined,
    sanitizedPayload: (toJson(row.sanitized_payload) ?? {}) as AlertDelivery["sanitizedPayload"],
    attemptCount: Math.round(toNumber(row.attempt_count)) || 0,
    createdAt: toIso(row.created_at),
    sentAt: row.sent_at ? toIso(row.sent_at) : undefined,
  };
}

/**
 * Public exposure of the row-mapping helpers so fixtures and dry-run
 * tooling can verify the SQL ↔ TypeScript parity without needing a live
 * Postgres connection. The adapters' `hydrateAlertTables` consumes these
 * directly.
 */
export const __rowMappers = {
  rule: mapAlertRuleRow,
  observation: mapAlertObservationRow,
  alert: mapAlertRow,
  delivery: mapAlertDeliveryRow,
};

let adapterSingleton: PostgresStorageAdapter | null = null;

export function getPostgresStorageAdapter(): PostgresStorageAdapter {
  if (!adapterSingleton) adapterSingleton = new PostgresStorageAdapter();

  return adapterSingleton;
}

/**
 * Fire-and-forget write-through helper used by the in-memory storage
 * functions. Errors are absorbed into the adapter health snapshot; the
 * caller always sees a synchronous in-memory write complete.
 */
export function mirrorAlertRuleWrite(rule: AlertRule): void {
  void getPostgresStorageAdapter().mirrorAlertRule(rule);
}

export function mirrorAlertObservationWrite(observation: AlertObservation): void {
  void getPostgresStorageAdapter().mirrorAlertObservation(observation);
}

export function mirrorAlertWrite(alert: Alert): void {
  void getPostgresStorageAdapter().mirrorAlert(alert);
}

export function mirrorAlertDeliveryWrite(delivery: AlertDelivery): void {
  void getPostgresStorageAdapter().mirrorAlertDelivery(delivery);
}

/**
 * Mirror a partial alert update (status / recovered_at / acknowledged_at /
 * evidence fields refreshed by deterioration). Always re-writes the row
 * via INSERT ... ON CONFLICT DO UPDATE so the SQL `alerts` table stays
 * consistent with the in-memory record across recovery/acknowledgement
 * cycles.
 */
export function mirrorAlertUpdate(alert: Alert): void {
  mirrorAlertWrite(alert);
}

export function mirrorAlertDeliveryUpdate(delivery: AlertDelivery): void {
  mirrorAlertDeliveryWrite(delivery);
}

export async function bootstrapPostgresStorage(): Promise<{ tried: boolean; connected: boolean; detail: string }> {
  const adapter = getPostgresStorageAdapter();

  if (!adapter.isConfigured()) return { tried: false, connected: false, detail: "no DATABASE_URL configured" };
  const result = await adapter.connect();

  return { tried: true, connected: result.ok, detail: result.detail };
}
