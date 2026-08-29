import type { RiskLevel } from "@/server/types";

// ─── Supported chain identities ──────────────────────────────────────────────

/**
 * Canonical chain identifiers the discovery service accepts.
 * Extends the existing scan network set with a stricter union.
 */
export type DiscoveryChainId =
  | "ethereum"
  | "base"
  | "bsc"
  | "arbitrum"
  | "polygon"
  | "optimism"
  | "avalanche"
  | "linea"
  | "scroll"
  | "zksync"
  | "opbnb"
  | "mantle"
  | "blast"
  | "fantom"
  | "gnosis"
  | "celo"
  | "moonbeam"
  | "moonriver"
  | "berachain"
  | "sonic"
  | "unichain"
  | "worldchain"
  | "monad"
  | "plasma"
  | "goat"
  | "stellar-pubnet"
  | "stellar-testnet";

/** Provider that produced a candidate. */
export type DiscoveryProviderKind =
  | "dexscreener_new_pairs"
  | "stellar_market";

// ─── Provider evidence ───────────────────────────────────────────────────────

/**
 * Immutable evidence record that links a candidate back to its source provider.
 * Every observation attaches at least one evidence link.
 */
export type ProviderEvidence = {
  /** The provider that produced this evidence. */
  providerKind: DiscoveryProviderKind;
  /** Provider-specific source label (e.g. "DexScreener API", "Stellar Horizon"). */
  sourceLabel: string;
  /** Direct URL to the source data (pair page, explorer, etc.), if available. */
  sourceUrl?: string;
  /** Provider-specific raw identifier (pair address, asset key, etc.). */
  externalId: string;
  /** ISO timestamp of when the provider was queried. */
  fetchedAt: string;
  /** Response latency in milliseconds. */
  latencyMs?: number;
  /** Raw payload snippet for audit trail (PII-safe). */
  rawPayloadPreview?: Record<string, unknown>;
};

// ─── Candidate identity ──────────────────────────────────────────────────────

/**
 * Canonical chain identity used for deduplication.
 * Two candidates with the same canonicalKey are considered the same asset.
 */
export type CanonicalIdentity = {
  /** Globally unique deduplication key: `<chainFamily>:<chainId>:<normalizedAddress>`. */
  canonicalKey: string;
  chainFamily: "evm" | "stellar";
  chainId: DiscoveryChainId;
  /** Normalized contract / asset address (lowercase for EVM, uppercase for Stellar). */
  address: string;
  /** For Stellar classic assets: `CODE:ISSUER`. For EVM: the contract address. */
  assetKey: string;
  /** Human-readable symbol (may be missing for very new pairs). */
  symbol?: string;
  /** Human-readable token name. */
  tokenName?: string;
};

// ─── Normalised candidate fields ─────────────────────────────────────────────

/**
 * Normalised market data for a discovered candidate.
 * Missing fields are `undefined`, never zero — so callers can distinguish
 * "no data" from "data is zero".
 */
export type CandidateMarketData = {
  /** Age of the pair in whole days. `undefined` when the creation time is unknown. */
  pairAgeDays?: number;
  /** Liquidity in USD. */
  liquidityUsd?: number;
  /** 24-hour DEX volume in USD. */
  volume24hUsd?: number;
  /** Fully diluted valuation in USD. */
  fdvUsd?: number;
  /** FDV / liquidity ratio. Computed when both are available. */
  fdvLiquidityRatio?: number;
  /** 24-hour price change percent (absolute value). */
  volatilityPercent24h?: number;
  /** Whether an official website link was detected. */
  hasOfficialLink?: boolean;
  /** Whether a Twitter/X profile was detected. */
  hasTwitterProfile?: boolean;
  /** Whether the contract source is verified (where available). */
  isVerified?: boolean;
  /** Number of active liquidity pools / pairs. */
  poolCount?: number;
};

// ─── Immutable observation ───────────────────────────────────────────────────

/**
 * A single immutable observation of a candidate at a point in time.
 * Once stored, observations are never mutated — only superseded by newer ones
 * with a later `observedAt` timestamp.
 */
export type CandidateObservation = {
  /** Unique observation ID (deterministic: hash of canonicalKey + observedAt). */
  id: string;
  /** The canonical identity this observation describes. */
  identity: CanonicalIdentity;
  /** The provider kind that produced this observation. */
  observedBy: DiscoveryProviderKind;
  /** ISO timestamp of when the observation was recorded. */
  observedAt: string;
  /** Normalised market data at observation time. */
  market: CandidateMarketData;
  /** Provider evidence that backs this observation. At least one link. */
  evidence: ProviderEvidence[];
  /** Provider-level risk score (0-100), if the source computes one. */
  riskScore?: number;
  /** Provider-level risk level. */
  riskLevel?: RiskLevel;
};

// ─── Durable cursor ──────────────────────────────────────────────────────────

/**
 * A durable cursor that lets the polling scheduler resume from where it
 * left off after a restart. Serialised as JSON and persisted in storage.
 */
export type DiscoveryCursor = {
  /** The provider kind this cursor belongs to. */
  providerKind: DiscoveryProviderKind;
  /** Chain ID being polled. */
  chainId: DiscoveryChainId;
  /** Provider-specific cursor value (pagination token, ledger seq, timestamp, etc.). */
  cursor: string;
  /** ISO timestamp when this cursor was last updated. */
  updatedAt: string;
  /** Number of consecutive failures since last success. */
  consecutiveFailures: number;
  /** Epoch ms when the next poll is allowed (rate-limit backoff). */
  nextAllowedPollMs: number;
};

// ─── Polling configuration ───────────────────────────────────────────────────

export type RateLimitConfig = {
  /** Max requests per window per chain. */
  maxRequestsPerWindow: number;
  /** Window duration in milliseconds. */
  windowMs: number;
  /** Minimum pause between individual requests (ms). */
  minIntervalMs: number;
};

export type BackoffConfig = {
  /** Initial backoff duration on failure (ms). */
  initialMs: number;
  /** Multiplier applied per consecutive failure (e.g. 2.0 for exponential). */
  multiplier: number;
  /** Maximum backoff duration (ms). */
  maxMs: number;
};

export type FreshnessConfig = {
  /** Maximum age of a cursor before it's considered stale (ms). */
  maxCursorAgeMs: number;
  /** How long before re-polling a chain that hasn't changed (ms). */
  pollIntervalMs: number;
};

export type ProviderPollingConfig = {
  rateLimit: RateLimitConfig;
  backoff: BackoffConfig;
  freshness: FreshnessConfig;
};

// ─── Polling result ──────────────────────────────────────────────────────────

export type PollResult = {
  /** The chain that was polled. */
  chainId: DiscoveryChainId;
  /** The provider kind. */
  providerKind: DiscoveryProviderKind;
  /** New observations produced by this poll. */
  observations: CandidateObservation[];
  /** Updated cursor after the poll. */
  cursor: DiscoveryCursor;
  /** Whether the poll succeeded. */
  ok: boolean;
  /** Error message if the poll failed. */
  error?: string;
  /** Elapsed wall-clock time for the poll (ms). */
  elapsedMs: number;
};

// ─── Discovery service API ───────────────────────────────────────────────────

export type DiscoveryServiceConfig = {
  /** Which chains to poll. If empty, polls all supported chains. */
  enabledChains?: DiscoveryChainId[];
  /** Which providers to enable. If empty, enables all. */
  enabledProviders?: DiscoveryProviderKind[];
  /** Override default polling config per provider kind. */
  providerOverrides?: Partial<Record<DiscoveryProviderKind, Partial<ProviderPollingConfig>>>;
  /** Maximum observations to retain per canonical identity (default 3). */
  maxObservationsPerIdentity?: number;
  /** Whether to enable the polling scheduler (default true). */
  enableScheduler?: boolean;
};

// ─── Discovery result (what consumers see) ───────────────────────────────────

/**
 * The external representation of a candidate.
 * This is the ONLY shape that leaves the discovery module.
 * It deliberately omits any execution-ready data (e.g. swap calldata, signatures).
 */
export type DiscoveryCandidate = {
  /** Canonical identity key for deduplication. */
  canonicalKey: string;
  /** Chain family. */
  chainFamily: "evm" | "stellar";
  /** Chain ID. */
  chainId: DiscoveryChainId;
  /** Normalised contract / asset address. */
  address: string;
  /** Human-readable symbol (may be missing). */
  symbol?: string;
  /** Human-readable token name. */
  tokenName?: string;
  /** The most recent observation's market data. */
  market: CandidateMarketData;
  /** The most recent observation's evidence links. */
  evidence: ProviderEvidence[];
  /** Provider that last observed this candidate. */
  lastObservedBy: DiscoveryProviderKind;
  /** ISO timestamp of the most recent observation. */
  lastObservedAt: string;
  /** Number of times this candidate has been observed (deduplication count). */
  observationCount: number;
  /** Provider-level risk score (0-100) from the latest observation. */
  riskScore?: number;
  /** Provider-level risk level from the latest observation. */
  riskLevel?: RiskLevel;
};
