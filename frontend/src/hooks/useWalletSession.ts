"use client";

import { useEffect, useRef } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { useStellarWallet } from "@/providers/StellarWalletProvider";

type Family = "evm" | "stellar";

type ChallengePayload = {
  nonce: string;
  family: Family;
  walletAddress: string;
  issuedAt: string;
  expiresAt: string;
  network: string | null;
  challenge?: string;
  challengeXdr?: string;
};

export function useWalletSession() {
  const evm = useAccount();
  const stellar = useStellarWallet();
  const signMessageAsync = useSignMessage().signMessageAsync;
  const family: Family | null = stellar.isConnected ? "stellar" : evm.isConnected ? "evm" : null;
  const address = family === "stellar" ? stellar.address : evm.address;
  const network =
    family === "stellar"
      ? stellar.network === "stellar-pubnet"
        ? "Public Global Stellar Network ; September 2015"
        : "Test SDF Network ; September 2015"
      : evm.chainId?.toString() ?? "";
  // queueStream serializes every claim so a fast disconnect-then-reconnect
  // (A → B) cannot fire its cleanup DELETE *after* B's chain already minted
  // a new cookie. Without this single-chain serialization, A's late
  // `.then()` would race the successor wallet and wipe it.
  // inflightFor coalesces per-wallet so deps churn (wagmi/Stellar
  // ref instability) does NOT queue duplicate claims for the same wallet
  // before the first chain resolves.
  const queueStream = useRef<Promise<unknown>>(Promise.resolve());
  const inflightFor = useRef<string | null>(null);
  const lastSynced = useRef<string | null>(null);

  useEffect(() => {
    if (!address || !family) {
      lastSynced.current = null;
      inflightFor.current = null;
      return;
    }
    if (lastSynced.current === address) return;
    if (inflightFor.current === address) return;
    inflightFor.current = address;
    const queued = queueStream.current;
    const claimedAtStart = address;

    const next = queued
      .then(async () => {
        // Step 1 — clear a prior wallet's cookie if the synced wallet
        // differs from the one we are about to claim. Runs BEFORE the
        // new challenge so the server challenge cookie is fresh.
        if (lastSynced.current && lastSynced.current !== claimedAtStart) {
          await fetch("/api/wallet-session", { method: "DELETE", credentials: "include" }).catch(
            () => undefined,
          );
        }
        // Step 2 — fetch the nonce, sign on the client, submit the claim.
        await runChallenge(claimedAtStart, family, network, signMessageAsync, stellar.signTransaction);
        lastSynced.current = claimedAtStart;
      })
      .catch((err: unknown) => {
        if (process.env.NODE_ENV !== "production") {
          console.warn("wallet session challenge failed", err);
        }
      })
      .finally(() => {
        if (inflightFor.current === claimedAtStart) inflightFor.current = null;
      });

    queueStream.current = next.catch(() => undefined);
  }, [address, family, network, signMessageAsync, stellar.signTransaction]);

  return {
    family,
    address: family === "stellar" ? stellar.address : evm.address,
    chain: family === "stellar" ? stellar.network : evm.chain?.name,
    chainId: family === "evm" ? evm.chainId : undefined,
    isConnected: family !== null,
    isConnecting: stellar.isConnecting || evm.status === "connecting" || evm.status === "reconnecting",
    status: family ? "connected" : stellar.isConnecting || evm.status === "connecting" || evm.status === "reconnecting" ? "connecting" : "disconnected",
    stellar,
    evm,
  } as const;
}

async function runChallenge(
  walletAddress: string,
  family: Family,
  network: string,
  signMessageAsync: (input: { message: string }) => Promise<string>,
  stellarSignTransaction: (xdr: string) => Promise<string>,
) {
  const nonceResponse = await fetch("/api/wallet-session/nonce", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ walletAddress, family, network: network || undefined }),
  });
  if (!nonceResponse.ok) {
    throw new Error(`challenge_issue_failed:${nonceResponse.status}`);
  }
  const challenge = (await nonceResponse.json()) as ChallengePayload;

  let signature: string | undefined;
  let signedTxXdr: string | undefined;

  if (family === "evm") {
    if (!challenge.challenge) throw new Error("evm_challenge_missing");
    signature = await signMessageAsync({ message: challenge.challenge });
  } else {
    if (!challenge.challengeXdr) throw new Error("stellar_challenge_missing");
    signedTxXdr = await stellarSignTransaction(challenge.challengeXdr);
  }

  const claimResponse = await fetch("/api/wallet-session", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      walletAddress,
      family,
      nonce: challenge.nonce,
      signature,
      signedTxXdr,
      network: network || undefined,
    }),
  });
  if (!claimResponse.ok) {
    const detail = await claimResponse.text().catch(() => "");
    throw new Error(`claim_rejected:${claimResponse.status}:${detail}`);
  }
}
