import "server-only";

import { createHash } from "node:crypto";
import { Address, BASE_FEE, Contract, TransactionBuilder, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { createStellarRpcServer } from "@/server/stellar/client";
import type { StellarNetworkId } from "@/lib/stellar/config";
import { getStellarNetwork, getStellarRegistryContractId } from "@/lib/stellar/config";

export type RiskRegistryPublication = {
  publisher: string;
  assetKey: string;
  assetLabel: string;
  score: number;
  confidenceBps: number;
  verdict: string;
  evidenceUri: string;
  updatedAt: number;
  report: unknown;
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

export function canonicalReportJson(report: unknown) {
  return JSON.stringify(stableValue(report));
}

export function sha256Bytes(value: string) {
  return new Uint8Array(createHash("sha256").update(value).digest());
}

export function getRiskRegistryContractId(network: StellarNetworkId) {
  const config = getStellarNetwork(network);
  return config ? getStellarRegistryContractId(config) : undefined;
}

function requireRegistry(network: StellarNetworkId) {
  const contractId = getRiskRegistryContractId(network);
  if (!contractId) throw new Error(`Risk registry is not deployed for ${network}.`);
  return new Contract(contractId);
}

function assertRiskPublicationTransaction(transaction: ReturnType<typeof TransactionBuilder.fromXDR>, contractId: string) {
  if ("innerTransaction" in transaction) throw new Error("Fee-bump transactions are not accepted by the risk registry relay.");
  if (transaction.operations.length !== 1) throw new Error("Risk publication must contain exactly one operation.");
  if (transaction.signatures.length === 0) throw new Error("Risk publication transaction is not signed.");

  const operation = transaction.operations[0];
  if (operation.type !== "invokeHostFunction" || operation.func.switch().name !== "hostFunctionTypeInvokeContract") {
    throw new Error("Only a risk registry contract invocation can be submitted.");
  }

  const invocation = operation.func.value() as xdr.InvokeContractArgs;
  const target = Address.fromScAddress(invocation.contractAddress()).toString();
  const method = invocation.functionName().toString("utf-8");
  const publisherArgument = invocation.args()[0];
  const publisher = publisherArgument ? Address.fromScVal(publisherArgument).toString() : undefined;

  if (target !== contractId || method !== "publish_risk") {
    throw new Error("The signed transaction does not target the configured risk registry publication method.");
  }
  if (!publisher || publisher !== transaction.source) {
    throw new Error("The transaction source must match the risk publication publisher.");
  }
}

export async function prepareRiskPublication(networkId: StellarNetworkId, publication: RiskRegistryPublication) {
  const { network, server } = createStellarRpcServer(networkId);
  const registry = requireRegistry(network.id);
  const source = await server.getAccount(publication.publisher);
  const reportJson = canonicalReportJson(publication.report);
  if (Buffer.byteLength(reportJson, "utf8") > 100_000) throw new Error("Risk report payload is too large.");
  const assetId = sha256Bytes(`${network.id}:${publication.assetKey}`);
  const reportHash = sha256Bytes(reportJson);
  const operation = registry.call(
    "publish_risk",
    new Address(publication.publisher).toScVal(),
    nativeToScVal(assetId),
    nativeToScVal(network.shortName, { type: "symbol" }),
    nativeToScVal(publication.assetLabel),
    nativeToScVal(publication.score, { type: "u32" }),
    nativeToScVal(publication.confidenceBps, { type: "u32" }),
    nativeToScVal(publication.verdict.slice(0, 32), { type: "symbol" }),
    nativeToScVal(reportHash),
    nativeToScVal(publication.evidenceUri),
    nativeToScVal(publication.updatedAt, { type: "u64" }),
  );
  const transaction = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: network.networkPassphrase })
    .addOperation(operation)
    .setTimeout(120)
    .build();
  const prepared = await server.prepareTransaction(transaction);

  return {
    xdr: prepared.toXDR(),
    network: network.id,
    networkPassphrase: network.networkPassphrase,
    contractId: registry.contractId(),
    source: publication.publisher,
    assetId: Buffer.from(assetId).toString("hex"),
    reportHash: Buffer.from(reportHash).toString("hex"),
    reportJson,
    expiresAt: Date.now() + 120_000,
  };
}

export async function submitRiskPublication(networkId: StellarNetworkId, signedXdr: string) {
  const { network, server } = createStellarRpcServer(networkId);
  const registry = requireRegistry(network.id);
  const transaction = TransactionBuilder.fromXDR(signedXdr, network.networkPassphrase);
  assertRiskPublicationTransaction(transaction, registry.contractId());
  const submitted = await server.sendTransaction(transaction);

  return {
    network: network.id,
    hash: submitted.hash,
    status: submitted.status,
    errorResultXdr: submitted.errorResult?.toXDR("base64"),
    latestLedger: submitted.latestLedger,
    latestLedgerCloseTime: submitted.latestLedgerCloseTime,
  };
}

export async function getRiskPublicationStatus(networkId: StellarNetworkId, hash: string) {
  const { network, server } = createStellarRpcServer(networkId);
  const result = await server.getTransaction(hash);

  return {
    network: network.id,
    hash,
    status: result.status,
    ledger: "ledger" in result ? result.ledger : undefined,
    createdAt: "createdAt" in result ? result.createdAt : undefined,
  };
}

export async function readRiskRecord(networkId: StellarNetworkId, assetKey: string) {
  const { network, server } = createStellarRpcServer(networkId);
  const registry = requireRegistry(network.id);
  const assetId = sha256Bytes(`${network.id}:${assetKey}`);
  const source = await server.getAccount("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF");
  const transaction = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: network.networkPassphrase })
    .addOperation(registry.call("get_risk", nativeToScVal(assetId), nativeToScVal(network.shortName, { type: "symbol" })))
    .setTimeout(30)
    .build();
  const simulation = await server.simulateTransaction(transaction);

  if (!("result" in simulation) || !simulation.result?.retval || simulation.result.retval.switch() === xdr.ScValType.scvVoid()) return null;
  return scValToNative(simulation.result.retval) as Record<string, unknown>;
}
