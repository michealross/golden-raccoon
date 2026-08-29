-- Golden Raccoon production storage contract.
-- Target: Supabase Postgres. This file is intentionally idempotent so the
-- MVP can apply the schema in one clean migration.

create extension if not exists pgcrypto;
-- pgcrypto is preserved for backwards compatibility with deployments that
-- still hold legacy uuid alert tables; the active alert schema now uses
-- text primary keys so that string ids minted by the storage layer
-- (e.g. "alert_…") mirror directly without an implicit cast.

create table if not exists wallets (
  id uuid primary key default gen_random_uuid(),
  address text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists token_identities (
  id uuid primary key default gen_random_uuid(),
  identity_key text not null unique,
  wallet_address text,
  contract_address text,
  chain text,
  symbol text,
  token_name text,
  website_url text,
  twitter_url text,
  telegram_url text,
  coingecko_id text,
  dex_screener_pair_url text,
  confidence numeric not null default 0,
  warnings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists agent_runs (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  mode text check (mode in ('portfolio_review', 'token_scan', 'pre_buy_check', 'holding_review', 'execution_prepare', 'discovery_candidate')),
  input_snapshot jsonb not null default '{}'::jsonb,
  target_symbol text,
  target_name text,
  target_address text,
  target_chain text,
  status text not null check (status in ('completed', 'partial', 'failed')),
  recommendation text not null,
  decision_score integer not null,
  confidence numeric not null,
  summary text not null,
  source_statuses jsonb not null default '[]'::jsonb,
  user_action text not null default 'pending' check (user_action in ('pending', 'approved', 'rejected', 'adjusted', 'executed')),
  created_at timestamptz not null default now()
);

create table if not exists agent_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references agent_runs(id) on delete cascade,
  agent text not null,
  status text not null,
  risk_score integer not null,
  risk_level text not null,
  verdict text not null,
  summary text not null,
  findings jsonb not null default '[]'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  data_quality jsonb not null default '{}'::jsonb,
  confidence numeric not null,
  recommended_action text not null,
  blocking_reasons jsonb not null default '[]'::jsonb,
  missing_data jsonb not null default '[]'::jsonb,
  raw_signals jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists source_snapshots (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references agent_runs(id) on delete cascade,
  result_id uuid references agent_results(id) on delete cascade,
  agent text not null,
  label text not null,
  url text,
  status text not null,
  checked_at timestamptz,
  latency_ms integer,
  reliability numeric,
  error text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists recommendations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references agent_runs(id) on delete set null,
  wallet_address text not null,
  action text not null,
  decision_score integer not null,
  confidence numeric not null,
  summary text not null,
  decision_explanation jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists approvals (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  decision_id text,
  tx_hash text not null,
  network text,
  action text,
  asset text,
  value_usd numeric,
  status text not null default 'confirmed',
  auto_executed boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  decision_id text,
  decision_action text,
  tx_hash text not null unique,
  type text not null,
  asset text not null,
  value_usd numeric not null default 0,
  status text not null,
  lifecycle_status text not null check (lifecycle_status in ('prepared', 'user_rejected', 'submitted', 'confirmed', 'failed', 'replaced', 'expired', 'pending')),
  chain_family text not null default 'evm' check (chain_family in ('evm', 'stellar')),
  source_account text,
  expected_effects jsonb not null default '[]'::jsonb,
  idempotency_key text,
  explorer_url text,
  failure_reason text,
  submitted_at timestamptz,
  terminal_at timestamptz,
  last_polled_at timestamptz,
  network text not null,
  user_approved boolean not null default false,
  simulation_status text,
  policy_status jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Backfill (idempotent): for rows that pre-date the V2 columns, lift the legacy status into
-- the lifecycle_status column. Existing rows that already carry a curated lifecycle_status
-- value are left untouched.
update transactions
   set lifecycle_status = status
 where lifecycle_status not in ('prepared', 'user_rejected', 'submitted', 'confirmed', 'failed', 'replaced', 'expired', 'pending');

create unique index if not exists transactions_idempotency_wallet_idx
  on transactions(wallet_address, idempotency_key)
  where idempotency_key is not null;

create table if not exists transaction_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  transaction_hash text not null references transactions(tx_hash) on delete cascade,
  event text not null check (event in ('prepared', 'submitted', 'submission_failed', 'user_rejected', 'polled', 'confirmed', 'failed', 'replaced', 'expired', 'duplicate_rejected')),
  detail jsonb not null default '{}'::jsonb,
  provider text,
  provider_url text,
  occurred_at timestamptz not null default now()
);

create index if not exists transaction_lifecycle_events_hash_occurred_idx
  on transaction_lifecycle_events(transaction_hash, occurred_at desc);

create table if not exists x402_payment_receipts (
  id uuid primary key default gen_random_uuid(),
  request_id text not null,
  payment_header_hash text not null unique,
  wallet_address text,
  payer text,
  transaction_hash text,
  network text not null,
  asset text not null,
  amount text not null,
  price_usd text not null,
  pay_to text not null,
  facilitator_url text not null,
  protected_resource text not null,
  request_body_hash text not null,
  verification_status text not null check (verification_status in ('payment_required', 'verified', 'settled', 'failed', 'duplicate', 'expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists user_rules (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null unique,
  max_risk_score integer not null,
  max_trade_percent numeric not null,
  max_meme_exposure_percent numeric not null,
  max_daily_transaction_value_usd numeric not null default 1000,
  max_slippage_bps integer not null default 100,
  allowed_chains jsonb not null default '[]'::jsonb,
  blocked_tokens jsonb not null default '[]'::jsonb,
  allowed_actions jsonb not null default '[]'::jsonb,
  auto_execute boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists agent_runs_wallet_created_idx on agent_runs(wallet_address, created_at desc);
create index if not exists agent_results_run_agent_idx on agent_results(run_id, agent);
create index if not exists source_snapshots_run_agent_idx on source_snapshots(run_id, agent);
create index if not exists recommendations_wallet_created_idx on recommendations(wallet_address, created_at desc);
create index if not exists transactions_wallet_created_idx on transactions(wallet_address, created_at desc);
create index if not exists approvals_wallet_created_idx on approvals(wallet_address, created_at desc);
create index if not exists x402_payment_receipts_resource_created_idx on x402_payment_receipts(protected_resource, created_at desc);

-- Idempotent migration for the V3 alert engine. The original schema
-- declared alert_*.id as `uuid primary key default gen_random_uuid()`,
-- but the storage layer mints prefixed string ids (`alert_…`, `rule_…`)
-- for portability with downstream in-memory + Postgres parity. Existing
-- deployments created under the previous contract therefore need their
-- primary keys and the rule_id / alert_id reference columns widened
-- from `uuid` to `text` so the new mirror INSERTs succeed. The blocks
-- below are no-ops on a fresh deployment that already declares the
-- tables with text columns, because Postgres treats `text` and
-- `varchar` as already widened.
do $$
begin
  begin
    alter table alert_rules alter column id type text using id::text;
  exception when others then null;
  end;
  begin
    alter table alert_observations alter column id type text using id::text;
  exception when others then null;
  end;
  begin
    alter table alerts alter column id type text using id::text;
  exception when others then null;
  end;
  begin
    alter table alerts alter column rule_id type text using rule_id::text;
  exception when others then null;
  end;
  begin
    alter table alert_deliveries alter column id type text using id::text;
  exception when others then null;
  end;
  begin
    alter table alert_deliveries alter column alert_id type text using alert_id::text;
  exception when others then null;
  end;
  begin
    alter table alert_observations add column if not exists incomplete_data boolean default false;
  exception when others then null;
  end;
end $$;

-- V3 alert engine contract.
-- alert_rules: durable, scope-bound (wallet_address) alert definitions.
-- alert_observations: append-only typed signal observations extracted from agent runs.
-- alerts: persisted trigger/recovery lifecycle bound to a rule.
-- alert_deliveries: fan-out audit row per channel per alert (in_app, email, telegram, discord).
create table if not exists alert_rules (
  id text primary key,
  wallet_address text not null,
  trigger_type text not null check (trigger_type in (
    'critical_risk',
    'liquidity_drop',
    'holder_concentration_change',
    'tax_control_change',
    'phishing_detected',
    'exploit_news',
    'portfolio_concentration',
    'stable_reserve_change',
    'stellar_issuer_auth',
    'stellar_clawback',
    'stellar_trustline',
    'stellar_contract_ttl',
    'rpc_degradation'
  )),
  observation_key text,
  threshold numeric not null,
  hysteresis numeric not null default 0,
  cooldown_minutes integer not null default 60,
  direction text not null default 'high_is_bad' check (direction in ('high_is_bad', 'low_is_bad')),
  severity text not null default 'medium' check (severity in ('low', 'medium', 'high', 'critical')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists alert_observations (
  id text primary key,
  wallet_address text not null,
  trigger_type text not null,
  observation_key text not null,
  value numeric not null,
  direction text not null check (direction in ('high_is_bad', 'low_is_bad')),
  evidence jsonb not null default '{}'::jsonb,
  incomplete_data boolean default false,
  created_at timestamptz not null default now()
);

create table if not exists alerts (
  id text primary key,
  wallet_address text not null,
  rule_id text not null references alert_rules(id) on delete cascade,
  trigger_type text not null,
  observation_key text not null,
  status text not null check (status in ('triggered', 'recovered', 'acknowledged')),
  severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
  message text not null,
  before_value numeric not null,
  after_value numeric not null,
  evidence_before jsonb not null default '{}'::jsonb,
  evidence_after jsonb not null default '{}'::jsonb,
  evidence_data jsonb not null default '{}'::jsonb,
  delivery_summary jsonb not null default '{}'::jsonb,
  triggered_at timestamptz not null default now(),
  recovered_at timestamptz,
  acknowledged_at timestamptz
);

create table if not exists alert_deliveries (
  id text primary key,
  alert_id text not null references alerts(id) on delete cascade,
  wallet_address text not null,
  channel text not null check (channel in ('in_app', 'email', 'telegram', 'discord')),
  status text not null check (status in ('pending', 'delivered', 'failed', 'skipped')),
  error_detail text,
  sanitized_payload jsonb not null default '{}'::jsonb,
  attempt_count integer not null default 0,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists alert_rules_wallet_enabled_idx on alert_rules(wallet_address, enabled);
create index if not exists alert_observations_wallet_trigger_idx on alert_observations(wallet_address, trigger_type, observation_key, created_at desc);
create index if not exists alerts_wallet_status_idx on alerts(wallet_address, status, triggered_at desc);
create index if not exists alert_deliveries_alert_idx on alert_deliveries(alert_id, channel);

-- Watchlist & discovery tables (upstream V3 discovery).
create table if not exists watchlist_entries (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  identity_key text not null,
  chain text not null,
  contract_address text,
  pair_address text,
  symbol text,
  token_name text,
  asset_key text,
  issuer text,
  asset_type text check (asset_type in ('native', 'classic', 'contract', 'issuer_account')),
  source text not null,
  note text,
  last_scanned_at timestamptz,
  latest_scan_run_id uuid,
  latest_classification text check (latest_classification in ('watch', 'risky', 'scam', 'early_opportunity')),
  latest_score integer,
  created_at timestamptz not null default now()
);

create unique index if not exists watchlist_entries_wallet_identity_uniq on watchlist_entries(wallet_address, identity_key);
create index if not exists watchlist_entries_wallet_created_idx on watchlist_entries(wallet_address, created_at desc);

create table if not exists watchlist_scan_runs (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references watchlist_entries(id) on delete cascade,
  wallet_address text not null,
  identity_key text not null,
  agent_run_id uuid references agent_runs(id) on delete set null,
  classification text not null check (classification in ('watch', 'risky', 'scam', 'early_opportunity')),
  classification_reasons jsonb not null default '[]'::jsonb,
  confidence numeric not null,
  score integer not null,
  source_lineage jsonb not null default '[]'::jsonb,
  missing_data jsonb not null default '[]'::jsonb,
  risk_report jsonb,
  status text not null check (status in ('completed', 'partial', 'failed', 'stale')),
  previous_run_id uuid references watchlist_scan_runs(id) on delete set null,
  scanned_at timestamptz not null default now()
);

create index if not exists watchlist_scan_runs_entry_scanned_idx on watchlist_scan_runs(entry_id, scanned_at desc);
create index if not exists watchlist_scan_runs_wallet_scanned_idx on watchlist_scan_runs(wallet_address, scanned_at desc);

create table if not exists discovery_alerts (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  entry_id uuid references watchlist_entries(id) on delete cascade,
  run_id uuid references watchlist_scan_runs(id) on delete set null,
  kind text not null check (kind in ('critical_risk', 'liquidity_drop', 'holder_concentration', 'social_phishing', 'news_incident', 'classification_change')),
  title text not null,
  detail text not null,
  severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
  source_label text,
  acknowledged boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists discovery_alerts_wallet_created_idx on discovery_alerts(wallet_address, created_at desc);
create index if not exists discovery_alerts_entry_created_idx on discovery_alerts(entry_id, created_at desc);
