import type { ChainFamily } from "@/lib/chainIdentity";
import type { TransactionRecord } from "@/server/types";
import { goatNetwork } from "@/lib/chains";
import { getScanNetwork } from "@/lib/scanNetworks";
import { getStellarNetwork } from "@/lib/stellar/config";

export type ExplorerLink = {
  url: string;
  family: ChainFamily;
  network: string;
  hash: string;
  source: string;
};

const EVM_EXPLORER_BASE_URLS: Record<string, string> = {
  ethereum: "https://etherscan.io/tx",
  base: "https://basescan.org/tx",
  bsc: "https://bscscan.com/tx",
  arbitrum: "https://arbiscan.io/tx",
  polygon: "https://polygonscan.com/tx",
  optimism: "https://optimistic.etherscan.io/tx",
  avalanche: "https://snowtrace.io/tx",
  linea: "https://lineascan.build/tx",
  scroll: "https://scrollscan.com/tx",
  zksync: "https://explorer.zksync.io/tx",
  opbnb: "https://opbnb.bscscan.com/tx",
  mantle: "https://mantlescan.xyz/tx",
  blast: "https://blastscan.io/tx",
  fantom: "https://ftmscan.com/tx",
  gnosis: "https://gnosisscan.io/tx",
  celo: "https://celoscan.io/tx",
  moonbeam: "https://moonscan.io/tx",
  moonriver: "https://moonriver.moonscan.io/tx",
  berachain: "https://berascan.com/tx",
  sonic: "https://sonicscan.org/tx",
  unichain: "https://uniscan.xyz/tx",
  worldchain: "https://worldscan.org/tx",
  monad: "https://monadscan.com/tx",
  plasma: "https://plasmascan.to/tx",
  goat: process.env.NEXT_PUBLIC_GOAT_EXPLORER_URL ? `${process.env.NEXT_PUBLIC_GOAT_EXPLORER_URL.replace(/\/$/, "")}/tx` : `${goatNetwork.blockExplorers.default.url.replace(/\/$/, "")}/tx`,
};

export function getExplorerBaseUrl(network: string, family: ChainFamily) {
  const normalized = network.trim().toLowerCase();

  if (family === "stellar") {
    const stellarNetwork = getStellarNetwork(network);
    return stellarNetwork?.explorerUrl ?? "https://stellar.expert/explorer/public";
  }

  const explicit = EVM_EXPLORER_BASE_URLS[normalized];
  if (explicit) return explicit;

  const scanNetwork = getScanNetwork(network);
  if (scanNetwork?.id === "goat") {
    return EVM_EXPLORER_BASE_URLS.goat;
  }

  return `${goatNetwork.blockExplorers.default.url.replace(/\/$/, "")}/tx`;
}

export function buildExplorerLink(hash: string, network: string, family: ChainFamily, sourceHint?: string): ExplorerLink {
  return {
    url: `${getExplorerBaseUrl(network, family)}/${hash}`,
    family,
    network,
    hash,
    source: sourceHint ?? family === "stellar" ? "stellar_expert" : "chain_explorer",
  };
}

export function attachExplorerUrl(record: Pick<TransactionRecord, "hash" | "network" | "chainFamily">): string | undefined {
  try {
    return buildExplorerLink(record.hash, record.network, record.chainFamily).url;
  } catch {
    return undefined;
  }
}
