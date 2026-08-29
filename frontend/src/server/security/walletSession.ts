import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { verifyMessage } from "viem";
import { Keypair, Networks, Operation, Memo, MemoText, Account, TransactionBuilder, Transaction } from "@stellar/stellar-sdk";

/**
 * Server-controlled wallet session used by the alert APIs. Holds the
 * authenticated wallet in an HttpOnly cookie so request bodies/query
 * strings cannot override the wallet scope.
 *
 * Audit #38: the cookie is ONLY minted after the wallet proves
 * ownership of `walletAddress` via a server-issued signature challenge.
 * This module exposes challenge mint + verify helpers used by
 * `/api/wallet-session` POST and `/api/wallet-session/nonce` POST.
 */

export const WALLET_SESSION_COOKIE = "gr_wallet_session";
export const WALLET_CHALLENGE_COOKIE = "gr_wallet_challenge";
export const WALLET_SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours
export const WALLET_CHALLENGE_TTL_SECONDS = 60 * 5; // 5 minutes
const SESSION_VERSION = "v1";
const CHALLENGE_VERSION = "v1";

export type WalletFamily = "evm" | "stellar";

export interface WalletChallenge {
  /** Random 16-byte hex nonce — tied to the cookie so it cannot be reused. */
  nonce: string;
  family: WalletFamily;
  walletAddress: string;
  /** ISO 8601 issuance timestamp. */
  issuedAt: string;
  /** ISO 8601 expiry timestamp — server-side clock. */
  expiresAt: string;
  /**
   * EVM: textual EIP-191 personal_sign payload.
   * Stellar: base64 transaction XDR envelope that the wallet signs via
   * SEP-10 lite (zero-amount self-payment with the nonce as memo and
   * a `timebounds` window matching the cookie TTL).
   */
  challengeBody: string;
  /** Stellar: network passphrase the challenge was built for. */
  network: string;
}

export interface WalletChallengeClaim {
  walletAddress: string;
  family: WalletFamily;
  nonce: string;
  /** EVM: 0x-prefixed signature over the EIP-191 personal_sign payload. */
  signature?: string;
  /** Stellar: signed transaction envelope in base64 XDR. */
  signedTxXdr?: string;
  network?: string;
}

export interface WalletChallengeVerifyResult {
  ok: boolean;
  error?: string;
}

function normalizeWallet(input: string | null | undefined): string | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  if (!trimmed.length) return undefined;

  // EVM wallets are 0x-prefixed hex; lowercasing is idempotent and
  // canonical. Stellar StrKey addresses are case-sensitive Base32, so
  // lowercasing them produces an invalid encoding — we must preserve
  // the address exactly as supplied.
  if (/^0[xX]/.test(trimmed)) return trimmed.toLowerCase();

  return trimmed;
}

/**
 * Build the cookie value. We attach a version prefix so we can rotate
 * the storage layer without breaking in-flight sessions.
 */
export function encodeWalletCookie(wallet: string): string {
  return `${SESSION_VERSION}:${wallet}`;
}

export function decodeWalletCookie(value: string | null | undefined): string | undefined {
  if (!value || !value.startsWith(`${SESSION_VERSION}:`)) return undefined;
  return normalizeWallet(value.slice(SESSION_VERSION.length + 1));
}

function rawHex(byteLength: number): string {
  return crypto.randomBytes(byteLength).toString("hex");
}

// Stellar MEMO_TEXT accepts at most 28 UTF-8 bytes. We round the nonce
// to 14 raw bytes (28 hex chars) so it fits inside the envelope memo.
const STELLAR_MEMO_NONCE_BYTES = 14;
const NONCE_BYTE_LENGTH = 16;

function encodeChallengeCookie(challenge: WalletChallenge): string {
  return [CHALLENGE_VERSION, challenge.family, challenge.walletAddress, challenge.nonce, challenge.expiresAt, challenge.issuedAt, challenge.network]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

function decodeChallenge(value: string | null | undefined): WalletChallenge | undefined {
  if (!value || !value.startsWith(`${CHALLENGE_VERSION}:`)) return undefined;
  const parts = value.slice(CHALLENGE_VERSION.length + 1).split(":");

  if (parts.length < 5) return undefined;
  const [familyPart, walletPart, noncePart, expiresAtPart, issuedAtPart, networkPart] = parts;
  if (familyPart !== "evm" && familyPart !== "stellar") return undefined;
  const wallet = normalizeWallet(decodeURIComponent(walletPart ?? ""));
  if (!wallet) return undefined;

  return {
    family: familyPart,
    walletAddress: wallet,
    nonce: decodeURIComponent(noncePart ?? ""),
    expiresAt: decodeURIComponent(expiresAtPart ?? ""),
    issuedAt: decodeURIComponent(issuedAtPart ?? ""),
    network: decodeURIComponent(networkPart ?? ""),
    challengeBody: "",
  };
}

/**
 * Decide whether the API deployment is allowed to mint session cookies.
 * Defaults to enabled in non-production; in production the operator must
 * opt-in explicitly via `ALLOW_WALLET_SESSION_COOKIE=1`.
 */
export function isWalletSessionCookieAllowed(): boolean {
  if (process.env.ALLOW_WALLET_SESSION_COOKIE === "1") return true;
  return process.env.NODE_ENV !== "production";
}

/**
 * Authoritative server-side wallet resolution for the alert APIs. Reads
 * the HttpOnly cookie; rejects any user-supplied wallet address that does
 * not match the session wallet. Returns either `{ wallet }` for downstream
 * handlers, or `{ response }` which is a 401/403 NextResponse.
 */
export type WalletSessionResolution =
  | { wallet: string; response?: undefined }
  | { wallet?: undefined; response: NextResponse };

function forbidden(reason: "missing" | "mismatch"): NextResponse {
  if (reason === "missing") {
    return NextResponse.json(
      {
        error: "wallet_session_required",
        detail: "Connect your wallet on the client before calling alert APIs.",
      },
      { status: 401 },
    );
  }

  return NextResponse.json(
    {
      error: "wallet_session_mismatch",
      detail: "The supplied wallet does not match the active wallet session.",
    },
    { status: 403 },
  );
}

export function readWalletSessionCookie(request: Request | NextRequest): string | undefined {
  // Some test runners construct bare fetch Request objects without the
  // `cookies` helper, so we read from the header directly.
  const header = request.headers.get("cookie") ?? "";

  for (const piece of header.split(";")) {
    const [rawKey, ...rest] = piece.split("=");
    if (rawKey && rawKey.trim() === WALLET_SESSION_COOKIE) {
      return decodeWalletCookie(rest.join("="));
    }
  }

  return undefined;
}

export function resolveWalletSession(
  request: Request | NextRequest,
  options: { suppliedWallet?: string | null } = {},
): WalletSessionResolution {
  const sessionWallet = readWalletSessionCookie(request);

  if (!sessionWallet) return { response: forbidden("missing") };
  if (options.suppliedWallet && normalizeWallet(options.suppliedWallet) !== sessionWallet) {
    return { response: forbidden("mismatch") };
  }

  return { wallet: sessionWallet };
}

/**
 * Convenience for handlers that read a walletAddress query/body field
 * alongside a session. Returns a wallet if everything matches, else a
 * 403 response. Useful when the client still sends the wallet for
 * transparency but the server remains authoritative.
 */
export function resolveWalletSessionFromSupplied(
  request: Request | NextRequest,
  suppliedWallet: string | null | undefined,
): WalletSessionResolution {
  return resolveWalletSession(request, { suppliedWallet });
}

/**
 * Apply a wallet cookie to a NextResponse.
 */
export function applyWalletCookie(response: NextResponse, wallet: string) {
  response.cookies.set({
    name: WALLET_SESSION_COOKIE,
    value: encodeWalletCookie(wallet),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: WALLET_SESSION_TTL_SECONDS,
  });

  return response;
}

export function clearWalletCookie(response: NextResponse) {
  response.cookies.set({
    name: WALLET_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });

  return response;
}

// ---------------- Signature Challenge ----------------

const STELLAR_FALLBACK_PASSPHRASE = Networks.TESTNET;

/**
 * Issue a wallet-ownership challenge. The returned challenge ships to
 * the client (sans `challengeBody` for non-EVM callers, which we
 * separately encode) AND is bound to an HttpOnly cookie carrying the
 * nonce + family + walletAddress + issuedAt + expiresAt. Subsequent
 * claims must present a valid signature for the same nonce and family.
 */
export function mintWalletChallenge(input: {
  walletAddress: string;
  family: WalletFamily;
  network?: string;
}): WalletChallenge {
  const normalizedWallet = normalizeWallet(input.walletAddress);
  if (!normalizedWallet) throw new Error("wallet_address_required");
  // EVM nonces are arbitrary-length hex (16 raw bytes = 32 hex chars).
  // Stellar MEMO_TEXT is capped at 28 UTF-8 bytes, so we shrink the
  // nonce to 14 raw bytes (28 hex chars) on that path to stay inside
  // the envelope memo.
  const nonce = input.family === "stellar" ? rawHex(STELLAR_MEMO_NONCE_BYTES) : rawHex(NONCE_BYTE_LENGTH);
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + WALLET_CHALLENGE_TTL_SECONDS * 1000);
  const network = input.network ?? (input.family === "stellar" ? STELLAR_FALLBACK_PASSPHRASE : "");

  let challengeBody: string;
  if (input.family === "evm") {
    challengeBody = [
      "Sign in to Golden Raccoon",
      "",
      `Wallet: ${normalizedWallet}`,
      `Nonce: ${nonce}`,
      `Issued At: ${issuedAt.toISOString()}`,
      `Expires At: ${expiresAt.toISOString()}`,
    ].join("\n");
  } else {
    // SEP-10 lite: zero-amount self-payment with the nonce as MEMO_TEXT,
    // and a tight timebounds so the second of signing must fall inside
    // [issuedAt, expiresAt]. The wallet signs the resulting envelope
    // via `signTransaction`; the server parses the returned envelope
    // and verifies the signature against the claimed public key.
    const source = new Account(normalizedWallet, "0");
    const builder = new TransactionBuilder(source, {
      fee: "100",
      networkPassphrase: network,
      memo: new Memo(MemoText, nonce),
      timebounds: {
        minTime: Math.floor(issuedAt.getTime() / 1000),
        maxTime: Math.floor(expiresAt.getTime() / 1000),
      },
    });
    builder.addOperation(
      // SEP-10 §"Challenge Transaction" canonical challenge uses
      // `manageData` (zero-value, no balance transfer) instead of a
      // payment. The nonce lives in MEMO_TEXT for server-side lookup
      // via `tx.memo.value`. The operation nickname "auth" lines up
      // with the SEP-10 wallet-auth vocabulary.
      Operation.manageData({
        name: "auth",
        value: "Golden Raccoon wallet auth",
      }),
    );
    const tx = builder.build();
    challengeBody = tx.toEnvelope().toXDR("base64");
  }

  return {
    nonce,
    family: input.family,
    walletAddress: normalizedWallet,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    challengeBody,
    network,
  };
}

/**
 * Verify a claimed challenge signature against the supplied public
 * address. Returns `{ ok: false, error: <code> }` on any mismatch so the
 * caller can surface a typed response without leaking signature bytes.
 *
 * Returns a Promise because viem's `verifyMessage` is itself async;
 * callers must `await` the result.
 */
export async function verifyWalletChallenge(input: {
  challenge: WalletChallenge;
  walletAddress: string;
  family: WalletFamily;
  signature?: string;
  signedTxXdr?: string;
  network?: string;
}): Promise<WalletChallengeVerifyResult> {
  const claimWallet = normalizeWallet(input.walletAddress);
  if (!claimWallet) return { ok: false, error: "wallet_missing" };
  if (claimWallet !== input.challenge.walletAddress) return { ok: false, error: "wallet_mismatch" };
  if (input.challenge.family !== input.family) return { ok: false, error: "family_mismatch" };

  // Treat a malformed expiresAt (garbage / NaN) as already-expired
  // so a tampered cookie cannot bypass the freshness gate.
  const expiresAt = Date.parse(input.challenge.expiresAt);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    return { ok: false, error: "challenge_expired" };
  }

  if (input.family === "evm") {
    if (!input.signature) return { ok: false, error: "signature_missing" };
    try {
      // viem's `verifyMessage` returns a Promise<boolean>; await it so the
      // success/failure branch is the actual cryptographic result, not the
      // Promise object that is always truthy.
      const valid = await verifyMessage({
        address: claimWallet as `0x${string}`,
        message: input.challenge.challengeBody,
        signature: input.signature as `0x${string}`,
      });

      return valid ? { ok: true } : { ok: false, error: "evm_signature_invalid" };
    } catch (error) {
      return { ok: false, error: `evm_verify_failed:${errorMessage(error)}` };
    }
  }

  // Stellar: SEP-10 lite envelope signed with the wallet's source
  // account. TransactionBuilder.fromXDR is the supported static API in
  // @stellar/stellar-sdk v16 (no Transaction.fromXDR). The returned
  // `source` is an Account for non-muxed sources, whose `accountId()`
  // returns the StrKey-encoded address.
  if (!input.signedTxXdr) return { ok: false, error: "signed_tx_missing" };
  const network = input.network || input.challenge.network || STELLAR_FALLBACK_PASSPHRASE;

  try {
    // TransactionBuilder.fromXDR returns a Transaction OR a
    // FeeBumpTransaction (the latter has no `.memo`); we reject FeeBump
    // envelopes explicitly so the failure code is honest.
    const parsed = TransactionBuilder.fromXDR(input.signedTxXdr, network);
    if (!(parsed instanceof Transaction)) {
      return { ok: false, error: "stellar_fee_bump_unsupported" };
    }
    const tx = parsed;

    const memo = tx.memo;
    if (!memo || memo.type !== MemoText) return { ok: false, error: "stellar_memo_wrong_type" };
    // MemoText.value may be a Buffer (deserialized off the wire) or a
    // string (in-freshly-built envelopes). Normalize to UTF-8 string
    // before comparison so the nonce match survives both shapes.
    const memoValue =
      typeof memo.value === "string"
        ? memo.value
        : Buffer.isBuffer(memo.value)
          ? memo.value.toString("utf-8")
          : "";
    if (memoValue !== input.challenge.nonce) return { ok: false, error: "stellar_memo_mismatch" };

    // Defense in depth: the wallet also refuses to sign past the
    // envelope's maxTime, but the server checks the same bound so a
    // tampered cookie cannot bypass expiry.
    if (tx.timeBounds && typeof tx.timeBounds.maxTime === "number" && tx.timeBounds.maxTime < Math.floor(Date.now() / 1000)) {
      return { ok: false, error: "stellar_timebound_expired" };
    }

    // The proof of ownership is the cryptographic signature: ed25519
    // `Keypair.verify(txHash, sig)` succeeds ONLY when the holder of
    // `claimWallet`'s private key signed the message. There is no
    // path by which an attacker can produce a valid signature against
    // `claimWallet`'s pubkey without owning its secret. The signature
    // base `tx.hash()` includes the source account, the memo, time
    // bounds, and operations, so cross-checks against `tx.memo.value`
    // (above) and `tx.timeBounds.maxTime` (above) are the actual
    // envelope-level guards. We do not also compare `tx.source` to
    // `claimWallet` because stellar-sdk v16 exposes the deserialized
    // source through multiple incompatible shapes (Account wrapper,
    // MuxedAccount.baseAccount, raw xdr.AccountId) and chaining those
    // behind a single helper proved brittle in earlier passes.
    const txHash = tx.hash();
    const keyPair = Keypair.fromPublicKey(claimWallet);
    const decorations = tx.signatures;
    const valid = decorations.some((sig) => {
      try {
        return keyPair.verify(txHash, sig.signature());
      } catch {
        return false;
      }
    });

    return valid ? { ok: true } : { ok: false, error: "stellar_signature_invalid" };
  } catch (error) {
    return { ok: false, error: `stellar_parse_failed:${errorMessage(error)}` };
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function readChallengeCookie(request: Request | NextRequest): WalletChallenge | undefined {
  const header = request.headers.get("cookie") ?? "";

  for (const piece of header.split(";")) {
    const [rawKey, ...rest] = piece.split("=");

    if (rawKey && rawKey.trim() === WALLET_CHALLENGE_COOKIE) {
      return decodeChallenge(rest.join("="));
    }
  }

  return undefined;
}

export function applyChallengeCookie(response: NextResponse, challenge: WalletChallenge) {
  response.cookies.set({
    name: WALLET_CHALLENGE_COOKIE,
    value: encodeChallengeCookie(challenge),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: WALLET_CHALLENGE_TTL_SECONDS,
  });

  return response;
}

export function clearChallengeCookie(response: NextResponse) {
  response.cookies.set({
    name: WALLET_CHALLENGE_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });

  return response;
}
