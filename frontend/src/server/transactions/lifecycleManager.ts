import type { Hash } from "viem";
import type { ChainFamily } from "@/lib/chainIdentity";
import { getChainFamily, isTransactionHashForChain } from "@/lib/chainIdentity";
import { getStellarChainAdapter, type StellarTerminalStatus } from "@/server/transactions/adapters/stellar";
import { deriveEvmTransactionHash, getEvmChainAdapter, type EvmTerminalStatus } from "@/server/transactions/adapters/evm";
import { attachExplorerUrl } from "@/server/transactions/explorer";
import {
  appendLifecycleEventByName,
  canonicalizeTransactionHash,
  createTransactionRecord,
  getTransactionRecord,
  getTransactionRecordByIdempotencyKey,
  isImmutableTerminal,
  listTransactionLifecycleEvents,
  updateTransactionRecord,
} from "@/server/storage";
import type {
  PollTransactionResult,
  SubmitTransactionInput,
  SubmitTransactionResult,
  TransactionLifecycleEvent,
  TransactionLifecycleStatus,
  TransactionRecord,
} from "@/server/types";

export type CanonicalizedHash = Hash | string;

export const SUBMISSION_TTL_MS = 5 * 60_000;
export const POLL_INTERVAL_MS = 6_000;
export const POLL_DEADLINE_MS = 5 * 60_000;

export type SubmissionOutcome = "ignored_duplicate" | "submitted" | "terminally_recorded";

export type SubmissionReport = {
  transaction: TransactionRecord;
  result: SubmitTransactionResult;
  outcome: SubmissionOutcome;
};

type LifecycleStorageDependencies = {
  getByHash: typeof getTransactionRecord;
  getByIdempotencyKey: typeof getTransactionRecordByIdempotencyKey;
  create: typeof createTransactionRecord;
  update: typeof updateTransactionRecord;
  appendEvent: typeof appendLifecycleEventByName;
  listEvents: typeof listTransactionLifecycleEvents;
};

const defaultStorage: LifecycleStorageDependencies = {
  getByHash: getTransactionRecord,
  getByIdempotencyKey: getTransactionRecordByIdempotencyKey,
  create: createTransactionRecord,
  update: updateTransactionRecord,
  appendEvent: appendLifecycleEventByName,
  listEvents: listTransactionLifecycleEvents,
};

let storageOverride: LifecycleStorageDependencies | undefined;

export function setLifecycleStorage(deps: Partial<LifecycleStorageDependencies>) {
  storageOverride = { ...defaultStorage, ...deps };
}

function getStorage(): LifecycleStorageDependencies {
  return storageOverride ?? defaultStorage;
}

export class TransactionLifecycleError extends Error {
  public readonly code: string;
  public readonly detail?: Record<string, unknown>;
  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "TransactionLifecycleError";
    this.code = code;
    this.detail = detail;
  }
}

export function assertHashMatchesFamily(hash: string, family: ChainFamily) {
  if (!isTransactionHashForChain(hash, family)) {
    throw new TransactionLifecycleError(
      "hash_chain_family_mismatch",
      `Transaction hash does not match chain family ${family}.`,
      { hash, family },
    );
  }
}

function normalizeHashForRecord(hash: string, family: ChainFamily): string {
  return family === "stellar" ? canonicalizeTransactionHash(hash, "stellar") : canonicalizeTransactionHash(hash, "evm");
}

export async function deriveSubmitHash(input: SubmitTransactionInput): Promise<string> {
  if (input.chainFamily === "evm") {
    return deriveEvmTransactionHash(input.signedPayload);
  }

  return getStellarChainAdapter({ network: input.network }).deriveHash(input.signedPayload);
}

function buildBaseRecord(input: SubmitTransactionInput, hash: string): Omit<TransactionRecord, "createdAt" | "lifecycleStatus" | "status"> {
  return {
    hash,
    type: "swap",
    asset: input.asset,
    valueUsd: input.valueUsd ?? 0,
    chainFamily: input.chainFamily,
    network: input.network,
    walletAddress: input.walletAddress,
    sourceAccount: input.sourceAccount,
    decisionId: input.decisionId,
    decisionAction: input.decisionAction,
    userApproved: true,
    simulationStatus: input.simulationStatus,
    policyStatus: input.policyStatus,
    expectedEffects: input.expectedEffects,
    idempotencyKey: input.idempotencyKey,
  };
}

export async function submitTransaction(input: SubmitTransactionInput): Promise<SubmissionReport> {
  if (input.userApproved !== true) {
    throw new TransactionLifecycleError("approval_required", "User wallet approval is mandatory before submission.");
  }

  const storage = getStorage();
  const family = input.chainFamily;

  if (family !== getChainFamily(input.network)) {
    throw new TransactionLifecycleError("network_chain_family_mismatch", `Network ${input.network} does not match chain family ${family}.`);
  }

  const existingByKey = input.idempotencyKey
    ? storage.getByIdempotencyKey(input.walletAddress, input.idempotencyKey)
    : undefined;
  if (existingByKey) {
    return {
      transaction: existingByKey,
      outcome: "ignored_duplicate",
      result: {
        hash: existingByKey.hash,
        chainFamily: existingByKey.chainFamily,
        network: existingByKey.network,
        submittedAt: existingByKey.submittedAt ?? existingByKey.createdAt,
        status: existingByKey.lifecycleStatus,
        explorerUrl: existingByKey.explorerUrl,
        idempotent: true,
        reuseReason: "idempotency_key",
        lifecycle: storage.listEvents(existingByKey.hash),
      },
    };
  }

  const derivedHash = await deriveSubmitHash(input);
  const normalizedHash = normalizeHashForRecord(derivedHash, family);
  const existingByHash = storage.getByHash(derivedHash) ?? storage.getByHash(normalizedHash);

  if (existingByHash) {
    storage.appendEvent(normalizedHash, "duplicate_rejected", { reason: "duplicate_hash", walletAddress: input.walletAddress });
    return {
      transaction: existingByHash,
      outcome: "ignored_duplicate",
      result: {
        hash: existingByHash.hash,
        chainFamily: existingByHash.chainFamily,
        network: existingByHash.network,
        submittedAt: existingByHash.submittedAt ?? existingByHash.createdAt,
        status: existingByHash.lifecycleStatus,
        explorerUrl: existingByHash.explorerUrl,
        idempotent: true,
        reuseReason: "duplicate_hash",
        lifecycle: storage.listEvents(existingByHash.hash),
      },
    };
  }

  const base = buildBaseRecord(input, normalizedHash);
  const record = storage.create({ ...base, status: "prepared", lifecycleStatus: "prepared" });
  storage.appendEvent(normalizedHash, "prepared", { walletAddress: input.walletAddress, network: input.network, chainFamily: family });

  const submitResult = await submitToChainAdapter(input);
  const submittedAt = submitResult.broadcastAcceptedAt ?? new Date().toISOString();

  const updated = storage.update(normalizedHash, {
    lifecycleStatus: "submitted",
    status: "submitted",
    submittedAt,
    explorerUrl: attachExplorerUrl({ hash: normalizedHash, network: input.network, chainFamily: family }),
  }) ?? record;

  storage.appendEvent(normalizedHash, "submitted", {
    network: input.network,
    providerUrl: submitResult.providerUrl,
    detail: submitResult.detail,
  }, { label: "chain_adapter", url: submitResult.providerUrl });

  return {
    transaction: updated,
    outcome: "submitted",
    result: {
      hash: updated.hash,
      chainFamily: updated.chainFamily,
      network: updated.network,
      submittedAt,
      status: updated.lifecycleStatus,
      explorerUrl: updated.explorerUrl,
      idempotent: false,
      lifecycle: storage.listEvents(updated.hash),
    },
  };
}

async function submitToChainAdapter(input: SubmitTransactionInput) {
  if (input.chainFamily === "evm") {
    const adapter = getEvmChainAdapter({ network: input.network });
    return adapter.submit(input.signedPayload);
  }

  const adapter = getStellarChainAdapter({ network: input.network });
  return adapter.submit(input.signedPayload, {
    sourceAccount: input.sourceAccount,
    expectedEffects: input.expectedEffects,
  });
}

export async function pollTransaction(hash: string, options: { network?: string; familyHint?: ChainFamily } = {}): Promise<PollTransactionResult> {
  const storage = getStorage();
  const record = storage.getByHash(hash);

  if (!record) {
    throw new TransactionLifecycleError("transaction_not_found", `Transaction ${hash} not found in lifecycle store.`, { hash });
  }

  if (isImmutableTerminal(record.lifecycleStatus)) {
    return { transaction: record, polled: false, terminalReached: true, events: storage.listEvents(record.hash) };
  }

  const family = options.familyHint ?? record.chainFamily;
  const network = options.network ?? record.network;
  const adapter = family === "stellar" ? getStellarChainAdapter({ network }) : getEvmChainAdapter({ network });
  const pollResult = await adapter.poll(hash as never);
  const polledAt = new Date().toISOString();
  const nextStatus = mapToLifecycleStatus(pollResult.status);

  const recentEvents = storage.listEvents(hash);
  const recentPolled = recentEvents.find((event) => event.event === "polled");
  const recentPolledAt = recentPolled ? new Date(recentPolled.occurredAt).getTime() : 0;
  if (!recentPolledAt || Date.now() - recentPolledAt >= POLL_INTERVAL_MS) {
    storage.appendEvent(hash, "polled", {
      network,
      providerUrl: pollResult.providerUrl,
      status: pollResult.status,
    }, { label: family === "stellar" ? "stellar_rpc" : "evm_rpc", url: pollResult.providerUrl });
  }

  if (nextStatus === "pending" || nextStatus === "submitted") {
    const updated = storage.update(hash, { lifecycleStatus: nextStatus, status: nextStatus, lastPolledAt: polledAt }) ?? record;
    return { transaction: updated, polled: true, terminalReached: false, events: storage.listEvents(hash) };
  }

  const eventName = nextStatus === "confirmed" ? "confirmed" : nextStatus === "failed" ? "failed" : nextStatus === "replaced" ? "replaced" : "expired";
  const revertReason = "revertReason" in pollResult ? pollResult.revertReason ?? `Remote provider reported ${nextStatus}.` : `Remote provider reported ${nextStatus}.`;
  storage.appendEvent(hash, eventName, {
    network,
    providerUrl: pollResult.providerUrl,
    revertReason,
  }, { label: family === "stellar" ? "stellar_rpc" : "evm_rpc", url: pollResult.providerUrl });

  const updated = storage.update(hash, {
    lifecycleStatus: nextStatus,
    status: nextStatus,
    lastPolledAt: polledAt,
    terminalAt: polledAt,
    failureReason: revertReason,
  }) ?? record;

  return { transaction: updated, polled: true, terminalReached: true, events: storage.listEvents(hash) };
}

export async function expireTransactionIfStale(hash: string, options: { now?: () => Date; ttlMs?: number } = {}): Promise<{ expired: boolean; transaction?: TransactionRecord; events: TransactionLifecycleEvent[] }> {
  const storage = getStorage();
  const record = storage.getByHash(hash);

  if (!record || isImmutableTerminal(record.lifecycleStatus)) {
    return { expired: false, transaction: record, events: storage.listEvents(hash) };
  }

  const ttl = options.ttlMs ?? SUBMISSION_TTL_MS;
  const nowFn = options.now ?? (() => new Date());
  const nowMs = nowFn().getTime();
  const submittedAtTs = record.submittedAt ? new Date(record.submittedAt).getTime() : new Date(record.createdAt).getTime();
  const elapsed = nowMs - submittedAtTs;

  if (elapsed < ttl) {
    return { expired: false, transaction: record, events: storage.listEvents(hash) };
  }

  const polledAt = new Date(nowMs).toISOString();
  const updated = storage.update(hash, {
    lifecycleStatus: "expired",
    status: "expired",
    terminalAt: polledAt,
    lastPolledAt: polledAt,
    failureReason: "Submission TTL exceeded without a terminal response from chain provider.",
  }) ?? record;

  storage.appendEvent(hash, "expired", { ttlMs: ttl, elapsedMs: elapsed });

  return { expired: true, transaction: updated, events: storage.listEvents(hash) };
}

function mapToLifecycleStatus(status: EvmTerminalStatus | StellarTerminalStatus): TransactionLifecycleStatus {
  switch (status) {
    case "confirmed":
      return "confirmed";
    case "failed":
      return "failed";
    case "replaced":
      return "replaced";
    case "expired":
      return "expired";
    case "pending":
      return "pending";
    case "submitted":
    default:
      return "submitted";
  }
}

export function listHashEvents(hash: string): TransactionLifecycleEvent[] {
  return listTransactionLifecycleEvents(hash);
}
