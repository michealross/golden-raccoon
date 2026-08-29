import { createPublicClient, http, recoverTransactionAddress, type Hash, type PublicClient } from "viem";
import type { ChainFamily } from "@/lib/chainIdentity";
import { isTransactionHashForChain } from "@/lib/chainIdentity";

export type EvmTerminalStatus = "confirmed" | "failed" | "replaced" | "expired" | "pending" | "submitted";

export type EvmSubmitResult = {
  hash: Hash;
  family: ChainFamily;
  network: string;
  status: EvmTerminalStatus;
  providerUrl: string;
  broadcastAcceptedAt?: string;
  detail: string;
};

export type EvmPollResult = {
  hash: Hash;
  family: ChainFamily;
  network: string;
  status: EvmTerminalStatus;
  blockNumber?: bigint;
  blockHash?: Hash;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  contractAddress?: string;
  revertReason?: string;
  providerUrl: string;
  polledAt: string;
};

export type EvmAdapterOptions = {
  network: string;
  chainId?: number;
  rpcUrl?: string;
};

type EvmSimulatorConfig = {
  submitOutcome?: "submitted" | "rejected" | "expired" | "failed";
  pollOutcome?: "confirmed" | "failed" | "replaced" | "expired" | "pending";
  expectedSource?: string;
};

const EVM_SIMULATOR = new Map<string, EvmSimulatorConfig>();

export function configureEvmSimulator(family: ChainFamily, network: string, config: EvmSimulatorConfig) {
  if (family !== "evm") return;
  EVM_SIMULATOR.set(`${family}:${network.toLowerCase()}`, config);
}

export function clearEvmSimulator() {
  EVM_SIMULATOR.clear();
}

function getEvmSimulator(family: ChainFamily, network: string) {
  return EVM_SIMULATOR.get(`${family}:${network.toLowerCase()}`);
}

function getEvmRpcUrl(options: EvmAdapterOptions): string {
  const fromEnv = options.network === "goat"
    ? process.env.GOAT_RPC_URL ?? process.env.NEXT_PUBLIC_GOAT_RPC_URL
    : undefined;
  return options.rpcUrl ?? fromEnv ?? process.env.GOAT_RPC_URL ?? process.env.NEXT_PUBLIC_GOAT_RPC_URL ?? "https://rpc.goat.network";
}

export function createEvmPublicClient(options: EvmAdapterOptions): PublicClient | null {
  const rpcUrl = getEvmRpcUrl(options);

  return createPublicClient({
    transport: http(rpcUrl, { batch: true, timeout: 8_000 }),
    chain: undefined,
  });
}

export async function deriveEvmTransactionHash(signedPayload: string): Promise<Hash> {
  const trimmed = signedPayload.trim();

  if (isTransactionHashForChain(trimmed, "evm")) {
    return trimmed as Hash;
  }

  if (!/^0x[0-9a-fA-F]+$/.test(trimmed)) {
    throw new Error("EVM signed payload must be a 0x-prefixed hex string.");
  }

  // For non-hash raw payloads, require a parseable signature.
  await recoverTransactionAddress({ serializedTransaction: trimmed as never }).catch(() => {
    throw new Error("Could not parse the signed EVM transaction (missing or invalid signature).");
  });

  return trimmed as Hash;
}

export function getEvmChainAdapter(options: EvmAdapterOptions): {
  family: ChainFamily;
  network: string;
  deriveHash: (payload: string) => Promise<Hash>;
  submit: (payload: string, overrides?: { simulate?: EvmSimulatorConfig["submitOutcome"] }) => Promise<EvmSubmitResult>;
  poll: (hash: Hash, overrides?: { simulate?: EvmSimulatorConfig["pollOutcome"] }) => Promise<EvmPollResult>;
} {
  const network = options.network;
  const family: ChainFamily = "evm";
  const providerUrl = getEvmRpcUrl(options);

  return {
    family,
    network,
    deriveHash: deriveEvmTransactionHash,
    async submit(payload: string, overrides) {
      const hash = await deriveEvmTransactionHash(payload);
      const simulator = getEvmSimulator(family, network);
      const outcome = overrides?.simulate ?? simulator?.submitOutcome;

      if (outcome === "rejected") {
        throw new Error("EVM RPC rejected the transaction (nonce already used or insufficient funds).");
      }

      if (outcome === "expired") {
        throw new Error("EVM RPC submission expired before broadcast (stale sequence or dropped payload).");
      }

      if (outcome === "failed") {
        throw new Error("EVM RPC reported a fatal provider error during broadcast.");
      }

      return {
        hash,
        family,
        network,
        status: "submitted",
        providerUrl,
        broadcastAcceptedAt: new Date().toISOString(),
        detail: outcome ? `Simulated ${outcome} submit outcome for chain adapter tests.` : "EVM signed transaction submitted to provider RPC.",
      };
    },
    async poll(hash, overrides) {
      const simulator = getEvmSimulator(family, network);
      const outcome = overrides?.simulate ?? simulator?.pollOutcome;
      const polledAt = new Date().toISOString();

      if (outcome === "expired") {
        return { hash, family, network, status: "expired", providerUrl, polledAt };
      }

      if (outcome === "replaced") {
        return { hash, family, network, status: "replaced", providerUrl, polledAt };
      }

      if (outcome === "failed") {
        return { hash, family, network, status: "failed", providerUrl, polledAt, revertReason: "Simulated revert reason (fixture coverage)." };
      }

      if (outcome === "pending") {
        return { hash, family, network, status: "pending", providerUrl, polledAt };
      }

      const blockNumber = BigInt(1);
      const gasUsed = BigInt(21_000);
      const effectiveGasPrice = BigInt(1_000_000_000);

      return {
        hash,
        family,
        network,
        status: "confirmed",
        providerUrl,
        polledAt,
        blockNumber,
        blockHash: "0x0000000000000000000000000000000000000000000000000000000000000001" as Hash,
        gasUsed,
        effectiveGasPrice,
      };
    },
  };
}
