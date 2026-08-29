export type RiskLevel = "low" | "medium" | "high" | "critical";

export type AgentStatus =
  | "idle"
  | "running"
  | "complete"
  | "partial"
  | "warning"
  | "error"
  | "unavailable"
  | "blocked"
  | "manual_review_required";

export type AgentSource = {
  label: string;
  url?: string;
  status: "mock" | "connected" | "unavailable";
  detail?: string;
  checkedAt?: string;
  latencyMs?: number;
  error?: string;
  errorCode?: string;
  provider?: string;
  fallbackRank?: number;
  cache?: {
    policy: string;
    ttlSeconds: number;
    hit?: boolean;
    freshnessSeconds?: number;
  };
  reliability?: number;
};

export type SourceDataQuality = {
  mode: "live" | "partial" | "unavailable" | "stale" | "conflicting";
  connectedSources: number;
  unavailableSources: number;
  mockSources: number;
  sourceCount: number;
  reliability: number;
  lastCheckedAt?: string;
  freshnessSeconds?: number;
  averageLatencyMs?: number;
  conflictCount?: number;
  providerErrors?: Array<{
    label: string;
    code?: string;
    detail?: string;
  }>;
  cache?: {
    policy: string;
    hitCount: number;
    missCount: number;
    staleCount: number;
  };
  detail: string;
};

export type AgentFinding = {
  label: string;
  severity: RiskLevel;
  detail: string;
  scoreImpact?: number;
  weight?: number;
  sourceLabel?: string;
  raw?: string;
  interpretation?: string;
  confidence?: number;
};

export type AgentRecommendedAction =
  | "hold"
  | "watch"
  | "reduce_exposure"
  | "swap_to_stable"
  | "avoid"
  | "manual_review"
  | "prepare_transaction"
  | "create_trustline"
  | "no_action";

export type AgentResult = {
  agent: "portfolio" | "news" | "social" | "onchain" | "decision" | "execution";
  status: AgentStatus;
  riskScore: number;
  score: number;
  riskLevel: RiskLevel;
  verdict: string;
  summary: string;
  findings: AgentFinding[];
  sources: AgentSource[];
  dataQuality: SourceDataQuality;
  confidence: number;
  recommendedAction: AgentRecommendedAction;
  blockingReasons: string[];
  blockingReasonDetails?: AgentBlockingReason[];
  missingData: AgentMissingData[];
  rawSignals?: Record<string, unknown>;
  createdAt: string;
};

export type AgentMissingData = {
  field: string;
  reason: string;
  impact: "low" | "medium" | "high";
  requiredFor?: string;
  canRetry?: boolean;
  fallbackUsed?: boolean;
};

export type AgentBlockingReason = {
  category: "critical" | "policy" | "identity" | "provider_coverage" | "simulation";
  severity: RiskLevel;
  detail: string;
  sourceLabel?: string;
};

export type AgentInputIdentity = {
  walletAddress?: string;
  chain?: string;
  contractAddress?: string;
  symbol?: string;
  tokenName?: string;
  issuer?: string;
  assetKey?: string;
  assetType?: "native" | "classic" | "contract" | "issuer_account";
  websiteUrl?: string;
  twitterUrl?: string;
  telegramUrl?: string;
  discordUrl?: string;
  coingeckoId?: string;
  coinmarketcapId?: string;
  pairAddress?: string;
  dexScreenerPairUrl?: string;
};

export type DiscoveryAgentInputIdentity = AgentInputIdentity;

export type DiscoveryAgentContext = {
  candidateId: string;
  chain: string;
  source: DiscoverySourceKind;
  discoveryMode: "candidate" | "watchlist_rescan";
  identityKey: string;
  identityConfidence: number;
  identityConfidenceLabel: ResolvedTokenIdentity["confidenceLabel"];
  metrics: DiscoveryCandidate["metrics"];
  scanOriginLabel: string;
  tokenSymbol?: string;
  tokenName?: string;
};

export type DiscoveryScanInputIdentity = AgentInputIdentity & {
  discovery?: DiscoveryAgentContext;
};

export type DiscoveryWithAlerts = {
  alerts: DiscoveryAlert[];
};

export type ResolvedTokenIdentity = AgentInputIdentity & {
  identityKey: string;
  confidence: number;
  confidenceLabel: "low" | "medium" | "high";
  matchReasons: string[];
  warnings: string[];
  chainFamily?: string;
  identityGraph?: unknown;
  symbolCollision?: unknown;
  officialLinkVerification?: unknown;
};

export type TokenSignal = {
  scamRisk: number;
  websiteTrustRisk: number;
  contractRisk: number;
  whaleSellRisk: number;
  liquidityRisk: number;
  xSentimentRisk: number;
  holderConcentrationRisk: number;
  priceVolatilityRisk: number;
  portfolioExposureRisk: number;
};

export type TokenHolding = {
  tokenAddress: string;
  symbol: "GOAT" | "USDC" | "MEME" | string;
  name: string;
  assetKind?: "native" | "classic" | "sac" | "sep41";
  issuer?: string;
  contractId?: string;
  chainId?: string;
  chainName?: string;
  chainLogoUrl?: string;
  logoUrl?: string;
  isVerified?: boolean;
  balance: number;
  priceUsd: number | null;
  priceStatus?: "priced" | "unavailable";
  priceSource?: string;
  valueUsd: number;
  dayChangeUsd?: number;
  dayChangePercent?: number;
  allocationPercent: number;
  riskScore: number;
  riskLevel: RiskLevel;
  signals: TokenSignal;
  stellarRisk?: {
    authorized: boolean;
    authorizationRequired: boolean;
    revocable: boolean;
    clawbackEnabled: boolean;
    liquidity: "known" | "unknown";
    dataStatus: "complete" | "partial";
  };
};

export type StellarPortfolioActivity = {
  id: string;
  type: "payment" | "contract_call" | "trustline_change" | "swap";
  createdAt: string;
  transactionHash: string;
  asset?: string;
  amount?: string;
};

export type PortfolioSnapshot = {
  walletAddress: string;
  nativeBalance: number;
  nativeSymbol: string;
  dayChangePercent: number;
  dayChangeUsd?: number;
  totalValueUsd: number;
  riskScore: number;
  createdAt: string;
  holdings: TokenHolding[];
  valuationStatus?: "complete" | "partial" | "unavailable";
  unpricedAssetCount?: number;
  accountSubentryCount?: number;
  minimumReserveXlm?: number;
  nativeSellingLiabilities?: number;
  spendableNativeBalance?: number;
  reserveReady?: boolean;
  recentActivity?: StellarPortfolioActivity[];
  dataWarnings?: string[];
  providerMeta?: {
    provider: string;
    network: string;
    latencyMs: number;
  };
};

export type AgentStep = {
  key: "observe" | "analyze" | "decide" | "plan" | "act";
  label: string;
  status: "complete" | "pending";
  detail: string;
};

export type SuggestedAction = {
  type: "swap_to_stablecoin" | "hold" | "reduce_exposure";
  fromToken: string;
  toToken: string;
  percent: number;
};

export type AgentDecision = {
  walletAddress: string;
  summary: string;
  riskScore: number;
  decision: string;
  reasoning: string[];
  suggestedAction: SuggestedAction;
  confidence: number;
  status: "pending" | "approved" | "rejected" | "executed";
  txHash?: string;
  createdAt: string;
};

export type StellarTransactionMeta = {
  sequence?: string;
  feeCharged?: number; // stroop fee actually paid
  feeBid?: number; // stroop fee bid
  operationCount?: number;
  ledger?: number;
  timeBounds?: {
    minTime?: number;
    maxTime?: number;
  };
  ledgerBounds?: {
    minLedger?: number;
    maxLedger?: number;
  };
  envelopeXdr?: string;
  resultXdr?: string;
  memo?: string;
  memoType?: "text" | "id" | "hash" | "return";
  signers?: string[];
  sourceAccount?: string;
};

export type StellarTrustlinePreview = {
  assetCode: string;
  issuer: string;
  contractId?: string;
  isNative: boolean;
  reserveRequiredXlm: number;
  currentXlmBalance: number;
  sufficientReserve: boolean;
  issuerFlags?: {
    authRequired?: boolean;
    authRevocable?: boolean;
    authClawbackEnabled?: boolean;
    authImmutable?: boolean;
  };
  existingTrustline: boolean;
  blockedReason?: "clawback_enabled" | "revocable_auth" | "insufficient_reserve" | "wrong_issuer" | "network_mismatch" | "issuer_unknown";
  /** Transaction metadata for preview, populated after simulation */
  transactionMeta?: StellarTransactionMeta;
};

export type StellarSwapQuote = {
  provider: "soroswap" | "stellar_aggregator" | "planned_stellar_dex";
  routeType: "classic_path_payment" | "soroban_swap" | "mixed";
  route: string[];
  expectedOutputAmount: number;
  estimatedValueUsd: number;
  priceImpactBps: number;
  slippageBps: number;
  minReceiveAmount: number;
  pathPaymentOps?: Array<{
    type: "path_payment_strict_send" | "path_payment_strict_receive";
    sendAsset: string;
    sendAmount: string;
    destAsset: string;
    destAmount: string;
    path: string[];
  }>;
  sorobanSimulation?: {
    contractId: string;
    method: string;
    args: string[];
    sourceAccount: string;
    footprint: string[];
    fee?: number;
  };
  status: "fresh" | "stale" | "simulated" | "unavailable";
  fetchedAt: string;
  expiresAt: string;
  detail: string;
};

export type TransactionPreview = {
  title: string;
  action?: "swap" | "reduce_exposure" | "watchlist" | "trustline" | "no_action";
  fromToken?: string;
  toToken?: string;
  percent?: number;
  estimatedValueUsd: number;
  currentRiskScore: number;
  projectedRiskScore: number;
  requiresApproval: boolean;
  network: string;
  slippageBps?: number;
  priceImpactBps?: number;
  gasEstimateUsd?: number;
  approvalSteps?: string[];
  executionReady?: boolean;
  lifecycle?: {
    status: "prepared" | "user_rejected" | "submitted" | "confirmed" | "failed" | "replaced" | "expired" | "pending";
    expiresAt?: string;
    idempotencyKey?: string;
  };
  stellarTrustline?: StellarTrustlinePreview;
  stellarQuote?: StellarSwapQuote;
  approvalRisk?: {
    infiniteApprovalWarning: boolean;
    existingAllowanceCheck: "required" | "not_required";
    revokeSuggestion?: string;
    permitSupport: "unsupported" | "planned";
    permit2Support: "unsupported" | "planned";
  };
  blockedReason?: string;
  policy?: {
    maxTradePercent: number;
    maxRiskScore: number;
    maxMemeExposurePercent: number;
    maxDailyTransactionValueUsd?: number;
    maxSlippageBps?: number;
    allowedChains?: string[];
    blockedTokens?: string[];
    allowedActions?: AgentRecommendedAction[];
    autoExecute: false;
  };
  policyStatus?: {
    allowed: boolean;
    violations: string[];
  };
  quote?: {
    provider: "planned_dex_aggregator" | "soroswap" | "stellar_aggregator";
    route: string[];
    expectedOutputToken: string;
    expectedOutputAmount?: number;
    estimatedValueUsd: number;
    priceImpactBps: number;
    slippageBps: number;
    gasEstimateUsd: number;
    status: "planned" | "fresh" | "simulated" | "unavailable";
    detail: string;
  };
  simulation?: {
    provider: "planned_tenderly" | "not_required" | "stellar_soroban" | "stellar_classic";
    status: "not_required" | "pending" | "passed" | "failed" | "unavailable";
    checks: string[];
    revertReason?: string;
    detail: string;
  };
  audit?: {
    approvalRequired: boolean;
    serverCanSign: false;
    userRuleWallet?: string;
    userApproved?: boolean;
    decisionId?: string;
  };
};

export type UserRule = {
  walletAddress: string;
  maxRiskScore: number;
  maxTradePercent: number;
  maxMemeExposurePercent: number;
  maxDailyTransactionValueUsd?: number;
  maxSlippageBps?: number;
  allowedChains?: string[];
  blockedTokens?: string[];
  allowedActions?: AgentRecommendedAction[];
  autoExecute: boolean;
  createdAt: string;
};

export type RiskBreakdownItem = {
  key:
    | "scam"
    | "website"
    | "contract"
    | "liquidity"
    | "whales"
    | "xSentiment"
    | "holders"
    | "volatility"
    | "portfolioExposure";
  label: string;
  score: number;
  severity: RiskLevel;
  finding: string;
};

export type ScanSource = {
  label: string;
  status: "mock" | "connected" | "unavailable";
  detail: string;
};

export type RiskReportVerdict = "buy_small" | "watch" | "avoid" | "hold" | "reduce_exposure" | "manual_review";

export type ScoreFactorCategory =
  | "sellability"
  | "owner_controls"
  | "taxes"
  | "liquidity"
  | "holder_concentration"
  | "lp_lock"
  | "market_anomaly"
  | "creator_behavior"
  | "social_identity"
  | "social_engagement"
  | "phishing"
  | "news_catalyst"
  | "news_risk"
  | "portfolio_exposure"
  | "source_coverage"
  | "decision_logic";

export type ScoreFactor = {
  label: string;
  category: ScoreFactorCategory;
  impact: number;
  weight?: number;
  severity: RiskLevel;
  detail: string;
  sourceLabel?: string;
  direction: "risk_increase" | "risk_decrease" | "neutral";
  raw?: unknown;
  meta?: Record<string, string | number | boolean | null | undefined>;
};

export type AgentScoreCard = {
  agent: AgentResult["agent"];
  displayName: string;
  score: number;
  scoreKind: "risk" | "trust" | "signal" | "exposure" | "decision";
  confidence: number;
  status: AgentStatus;
  summary: string;
  factors: ScoreFactor[];
  criticalFactors?: ScoreFactor[];
  secondaryScores?: Array<{
    label: string;
    score: number;
    detail: string;
  }>;
  sources: AgentSource[];
  missingData: AgentMissingData[];
};

export type RiskReportInput = {
  query: string;
  chain: string;
  contractAddress?: string;
  pairAddress?: string;
  pairUrl?: string;
  symbol?: string;
  tokenName?: string;
  assetKey?: string;
  assetType?: "native" | "classic" | "contract" | "issuer_account";
  issuer?: string;
  source: "contract_address" | "dexscreener_pair_url" | "dexscreener_token_url" | "stellar_asset" | "stellar_issuer" | "unresolved";
};

export type DiscoverySourceKind = "dexscreener" | "stellar_market" | "manual";

export type DiscoveryCandidate = {
  id: string;
  chain: string;
  contractAddress?: string;
  pairAddress?: string;
  pairUrl?: string;
  symbol?: string;
  tokenName?: string;
  assetKey?: string;
  issuer?: string;
  assetType?: "native" | "classic" | "contract" | "issuer_account";
  source: DiscoverySourceKind;
  sourceUrl?: string;
  discoveredAt: string;
  metrics: {
    liquidityUsd?: number;
    volume24hUsd?: number;
    fdvUsd?: number;
    fdvLiquidityRatio?: number;
    priceChange24hPercent?: number;
    pairAgeDays?: number;
    nativePair?: boolean;
  };
  raw: Record<string, unknown>;
};

export type DiscoveryClassification = "watch" | "risky" | "scam" | "early_opportunity";

export type DiscoveryScanResult = {
  candidate: DiscoveryCandidate;
  identity: ResolvedTokenIdentity;
  results: AgentResult[];
  decision: AgentResult;
  classification: DiscoveryClassification;
  classificationReasons: string[];
  confidence: number;
  sourceLineage: AgentSource[];
  missingData: AgentMissingData[];
  scannedAt: string;
};

export type WatchlistEntryInput = {
  walletAddress: string;
  chain: string;
  contractAddress?: string;
  pairAddress?: string;
  symbol?: string;
  tokenName?: string;
  assetKey?: string;
  issuer?: string;
  assetType?: "native" | "classic" | "contract" | "issuer_account";
  source: DiscoveryCandidate["source"] | "manual_watchlist";
  note?: string;
};

export type WatchlistEntry = {
  id: string;
  walletAddress: string;
  identityKey: string;
  chain: string;
  contractAddress?: string;
  pairAddress?: string;
  symbol?: string;
  tokenName?: string;
  assetKey?: string;
  issuer?: string;
  assetType?: "native" | "classic" | "contract" | "issuer_account";
  source: WatchlistEntryInput["source"];
  note?: string;
  createdAt: string;
  lastScannedAt?: string;
  latestScanRunId?: string;
  latestClassification?: DiscoveryClassification;
  latestScore?: number;
  latestStatus?: WatchlistScanRun["status"];
  successfulScanRunIds?: string[];
};

export type WatchlistScanRun = {
  id: string;
  entryId: string;
  walletAddress: string;
  identityKey: string;
  classification: DiscoveryClassification;
  classificationReasons: string[];
  confidence: number;
  score: number;
  riskReport?: RiskReport;
  agentRunId?: string;
  previousRunId?: string;
  sourceLineage: AgentSource[];
  missingData: AgentMissingData[];
  scannedAt: string;
  status: "completed" | "partial" | "failed" | "stale";
};

export type DiscoveryAlertKind =
  | "critical_risk"
  | "liquidity_drop"
  | "holder_concentration"
  | "social_phishing"
  | "news_incident"
  | "classification_change";

export type DiscoveryAlert = {
  id: string;
  walletAddress: string;
  entryId?: string;
  runId?: string;
  kind: DiscoveryAlertKind;
  title: string;
  detail: string;
  severity: RiskLevel;
  sourceLabel?: string;
  acknowledged: boolean;
  createdAt: string;
};

export type RiskReport = {
  id: string;
  chain: string;
  contractAddress?: string;
  symbol: string;
  tokenName?: string;
  buyRisk: number;
  confidence: number;
  verdict: RiskReportVerdict;
  summary: string;
  topReasons: string[];
  input: RiskReportInput;
  agentCards: AgentScoreCard[];
  sources: AgentSource[];
  missingData: AgentMissingData[];
  executionPreview?: TransactionPreview;
  createdAt: string;
};

export type TokenScanResult = {
  symbol: string;
  tokenAddress: string;
  chain: string;
  normalizedInput?: RiskReportInput;
  market?: {
    pairAddress?: string;
    dexId?: string;
    pairUrl?: string;
    priceUsd?: number;
    liquidityUsd?: number;
    volume24hUsd?: number;
    fdvUsd?: number;
    marketCapUsd?: number;
    priceChange24hPercent?: number;
    pairAgeDays?: number;
  };
  overallRiskScore: number;
  opportunityScore: number;
  verdict: "safe" | "watch" | "high_risk" | "critical";
  summary: string;
  reasons: string[];
  suggestedAction: SuggestedAction;
  riskBreakdown: RiskBreakdownItem[];
  analysisChecks?: Array<{
    key: string;
    label: string;
    status: "pass" | "warning" | "danger" | "unavailable";
    score: number | null;
    value?: string;
    reason: string;
  }>;
  riskReport?: RiskReport;
  sources: ScanSource[];
  dataQuality?: SourceDataQuality;
  scannedAt: string;
};

export type TransactionRecord = {
  hash: string;
  type: "swap" | "approval" | "agent_log" | "transfer" | "trustline_create" | "trustline_change";
  decisionAction?: AgentRecommendedAction;
  asset: string;
  valueUsd: number;
  status: "prepared" | "user_rejected" | "submitted" | "confirmed" | "failed" | "replaced" | "expired" | "pending";
  createdAt: string;
  network: string;
  walletAddress?: string;
  userApproved?: boolean;
  decisionId?: string;
  simulationStatus?: NonNullable<TransactionPreview["simulation"]>["status"];
  policyStatus?: TransactionPreview["policyStatus"];
  stellarDetails?: {
    sequence?: string;
    feeCharged?: number;
    operationCount?: number;
    ledger?: number;
    envelopeXdr?: string;
    resultXdr?: string;
    trustlineAsset?: string;
  };
};

export type AgentRunRecord = {
  id: string;
  walletAddress: string;
  mode?: "portfolio_review" | "token_scan" | "pre_buy_check" | "holding_review" | "execution_prepare" | "discovery_candidate";
  inputSnapshot?: Record<string, unknown>;
  targetToken?: {
    symbol?: string;
    name?: string;
    tokenAddress?: string;
    chain?: string;
    riskScore?: number;
    allocationPercent?: number;
  };
  status: "completed" | "partial" | "failed";
  recommendation: AgentRecommendedAction;
  decisionScore: number;
  confidence: number;
  summary: string;
  results: AgentResult[];
  sourceStatuses?: Array<{
    agent: AgentResult["agent"];
    connected: number;
    unavailable: number;
    mock: number;
  }>;
  userAction?: "pending" | "approved" | "rejected" | "adjusted" | "executed";
  createdAt: string;
};

export type StorageProvider = "memory" | "supabase_postgres";

export type StorageHealth = {
  provider: StorageProvider;
  persistent: boolean;
  detail: string;
  schema?: {
    tables: string[];
    adapterApi: string[];
    migration: string;
  };
};

export type X402PaymentReceipt = {
  id: string;
  requestId: string;
  paymentHeaderHash: string;
  walletAddress?: string;
  payer?: string;
  transactionHash?: string;
  network: string;
  asset: string;
  amount: string;
  priceUsd: string;
  payTo: string;
  facilitatorUrl: string;
  protectedResource: string;
  requestBodyHash: string;
  verificationStatus: "payment_required" | "verified" | "settled" | "failed" | "duplicate" | "expired";
  createdAt: string;
  updatedAt: string;
};

export type RecommendationRecord = {
  id: string;
  runId?: string;
  walletAddress: string;
  action: AgentRecommendedAction;
  decisionScore: number;
  confidence: number;
  summary: string;
  createdAt: string;
};

export type UserApprovalRecord = {
  id: string;
  walletAddress: string;
  decisionId?: string;
  txHash: string;
  network?: string;
  action?: AgentRecommendedAction;
  asset?: string;
  valueUsd?: number;
  status: "confirmed";
  autoExecuted: false;
  createdAt: string;
};

export type StorageCounts = {
  agentRuns: number;
  recommendations: number;
  transactions: number;
  approvals: number;
  userRules: number;
  x402PaymentReceipts: number;
  alertRules: number;
  alertObservations: number;
  alerts: number;
  alertDeliveries: number;
};

export type AlertTriggerType =
  | "critical_risk"
  | "liquidity_drop"
  | "holder_concentration_change"
  | "tax_control_change"
  | "phishing_detected"
  | "exploit_news"
  | "portfolio_concentration"
  | "stable_reserve_change"
  | "stellar_issuer_auth"
  | "stellar_clawback"
  | "stellar_trustline"
  | "stellar_contract_ttl"
  | "rpc_degradation";

export type AlertDeliveryChannel = "in_app" | "email" | "telegram" | "discord";

export type AlertDeliveryStatus = "pending" | "delivered" | "failed" | "skipped";

export type AlertStatus = "triggered" | "recovered" | "acknowledged";

export type AlertSeverity = "low" | "medium" | "high" | "critical";

export type AlertObservationDirection = "high_is_bad" | "low_is_bad";

/**
 * A user-defined alert rule scoped to a wallet. Threshold semantics depend
 * on `direction` on the trigger type. Cooldown prevents re-triggering
 * immediately after recovery; hysteresis prevents flapping near the threshold.
 */
export type AlertRule = {
  id: string;
  walletAddress: string;
  triggerType: AlertTriggerType;
  observationKey?: string;
  threshold: number;
  hysteresis: number;
  cooldownMinutes: number;
  direction?: AlertObservationDirection;
  severity: AlertSeverity;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

/**
 * Immutable observation extracted from an AgentRunRecord. The evidence only
 * includes the minimum data the alert needs (no wallet secrets, no PII).
 */
export type AlertObservation = {
  id: string;
  walletAddress: string;
  triggerType: AlertTriggerType;
  observationKey: string;
  value: number;
  direction: AlertObservationDirection;
  evidence: {
    runId: string;
    agent: AgentResult["agent"];
    label: string;
    detail: string;
    sourceLabels: string[];
    sourceSnapshotHash?: string;
    beforeValue?: number;
    afterValue?: number;
    meta?: Record<string, string | number | boolean | null | undefined>;
  };
  createdAt: string;
  /**
   * True when the observation was extracted from an AgentResult that had at
   * least one unavailable source. Incomplete observations are intentionally
   * excluded from risk-change alerts at extraction time so a degraded
   * provider cannot generate phantom alerts.
   */
  incompleteData?: boolean;
};

export type Alert = {
  id: string;
  walletAddress: string;
  ruleId: string;
  triggerType: AlertTriggerType;
  observationKey: string;
  status: AlertStatus;
  severity: AlertSeverity;
  message: string;
  beforeValue: number;
  afterValue: number;
  /**
   * Immutable evidence captured at trigger time. NEVER overwritten once the
   * alert is created — subsequent deterioration events extend the chain in
   * `deteriorationObservationIds` and refresh only the latest-at-time field
   * (`evidenceAfter`) with a snapshot from the new observation.
   */
  evidenceBefore: AlertObservation["evidence"];
  evidenceAfter: AlertObservation["evidence"];
  evidenceData: {
    runId: string;
    observationId: string;
    sourceSnapshotHashAfter: string;
    sourceSnapshotHashBefore?: string;
    evidenceBeforeObservationId?: string;
    evidenceAfterObservationId: string;
    evidenceBeforeHash?: string;
    evidenceAfterHash: string;
    deteriorationObservationIds: string[];
  };
  triggeredAt: string;
  recoveredAt?: string;
  acknowledgedAt?: string;
  deliverySummary?: {
    delivered: AlertDeliveryChannel[];
    failed: Array<{ channel: AlertDeliveryChannel; error: string }>;
    skipped: Array<{ channel: AlertDeliveryChannel; reason: string }>;
  };
};

export type AlertDelivery = {
  id: string;
  alertId: string;
  walletAddress: string;
  channel: AlertDeliveryChannel;
  status: AlertDeliveryStatus;
  errorDetail?: string;
  sanitizedPayload: {
    triggerType: AlertTriggerType;
    severity: AlertSeverity;
    summary: string;
    beforeValue: number;
    afterValue: number;
    observationKey: string;
    evidenceLinks: string[];
  };
  attemptCount: number;
  createdAt: string;
  sentAt?: string;
};
