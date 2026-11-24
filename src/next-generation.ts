import { sha256Hex } from "./canonical.js";
import { NAYORI_NEXT_ESCROW_NAMES } from "./contracts.js";

/** Job status codes of nayori-escrow-stx / nayori-escrow-sbtc. */
export const NAYORI_NEXT_STATUS = {
  open: 0n, funded: 1n, offered: 2n, accepted: 3n, submitted: 4n, decided: 5n,
  disputed: 6n, completed: 7n, rejected: 8n, refunded: 9n, expired: 10n,
} as const;

const DOMAIN = "nayori/decision-evidence/v1";
const DIGEST = /^[0-9a-f]{64}$/;

export interface DecisionEvidenceInput {
  readonly network: "testnet" | "mainnet";
  readonly contract: string;
  readonly jobId: string;
  readonly decision: "approve" | "reject";
  readonly evidenceHash: string;
  readonly explanationHash: string;
}

/**
 * The single `evidence-hash` argument of next-generation `record-decision`.
 *
 * The current contracts take two hashes: `evidenceHash` (SHA-256 of the canonical evidence list)
 * and `explanationHash` (SHA-256 of the public explanation). The next contracts take one, so both
 * are bound into one commitment together with the target and the decision:
 *
 *   SHA-256( "nayori/decision-evidence/v1" + "\n" + JSON )
 *
 * where JSON is, byte for byte, with keys in this order and no whitespace:
 *   {"contract":…,"decision":"approve"|"reject","evidenceHash":…,"explanationHash":…,"jobId":"…","network":…,"schemaVersion":"1"}
 *
 * Both input hashes are lowercase 64-character hex. Anyone holding the published evaluation
 * (evidenceHash, explanationHash, decision) can recompute the on-chain value.
 */
export function nextDecisionEvidenceHash(input: DecisionEvidenceInput): string {
  if (!DIGEST.test(input.evidenceHash) || !DIGEST.test(input.explanationHash) ||
    !/^[1-9][0-9]*$/.test(input.jobId) || !["approve", "reject"].includes(input.decision)) {
    throw new Error("invalid_decision_evidence_input");
  }
  const preimage = JSON.stringify({
    contract: input.contract,
    decision: input.decision,
    evidenceHash: input.evidenceHash,
    explanationHash: input.explanationHash,
    jobId: input.jobId,
    network: input.network,
    schemaVersion: "1",
  });
  const digest = sha256Hex(`${DOMAIN}\n${preimage}`);
  if (/^0{64}$/.test(digest)) throw new Error("invalid_decision_evidence_hash");
  return digest;
}

/** Name-only check used for display; authorization always uses the configured deployer. */
export function isNextEscrowName(contract: string): boolean {
  const name = contract.split(".")[1];
  return name === NAYORI_NEXT_ESCROW_NAMES.stx || name === NAYORI_NEXT_ESCROW_NAMES.sbtc;
}
