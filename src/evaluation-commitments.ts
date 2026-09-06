/**
 * Nayori commitment profile v1. Kept byte-identical in SDK and Evaluator.
 * Only JSON primitives, lexicographic ASCII keys, ordered arrays and UTF-8.
 * Hashes bind manifests; they do not prove evidence truth or authorize wallet spending.
 */
export interface EvaluationCriterion {
  readonly id: string;
  readonly requirement: string;
  readonly verification: string;
}
export interface EvaluationEvidence {
  readonly id: string;
  readonly uri: string;
  readonly sha256: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
}
export interface CriteriaCommitmentInput {
  readonly network: "testnet";
  readonly asset: "stx" | "sbtc";
  readonly contract: string;
  readonly client: string;
  readonly evaluator: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly EvaluationCriterion[];
}
export interface EvidenceCommitmentInput extends CriteriaCommitmentInput {
  readonly jobId: string;
  readonly provider: string;
  readonly evidence: readonly EvaluationEvidence[];
}

const CRITERIA = "\nnayori-criteria-v1:";
const EVIDENCE = "ny1:";
const HASH = /^[0-9a-f]{64}$/;
const PRINCIPAL = /^ST[A-Z0-9]{20,41}$/;
function ensure(condition: boolean): asserts condition {
  if (!condition) throw new Error("invalid_evaluation_commitment");
}
function text(value: unknown, max: number): asserts value is string {
  ensure(typeof value === "string" && value.length > 0 && value.length <= max);
  // Reject lone surrogates instead of hashing lossy UTF-8 replacements.
  ensure(!/[\uD800-\uDFFF]/u.test(value));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map(k => JSON.stringify(k) + ":" + canonical(record[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}
async function digest(domain: string, value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(domain + "\n" + canonical(value));
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)),
    byte => byte.toString(16).padStart(2, "0")).join("");
}
function criteriaManifest(input: CriteriaCommitmentInput) {
  ensure(input.network === "testnet" && ["stx", "sbtc"].includes(input.asset));
  ensure(/^ST[A-Z0-9]{20,41}\.[a-z][a-z0-9-]{0,39}$/.test(input.contract));
  ensure(PRINCIPAL.test(input.client) && PRINCIPAL.test(input.evaluator) && input.client !== input.evaluator);
  text(input.description, 512 - CRITERIA.length - 64);
  ensure(/^[\x20-\x7e\n\r\t]+$/.test(input.description) && !input.description.includes("nayori-criteria-"));
  ensure(Array.isArray(input.acceptanceCriteria) && input.acceptanceCriteria.length >= 1 && input.acceptanceCriteria.length <= 20);
  const acceptanceCriteria = input.acceptanceCriteria.map(item => {
    text(item.id, 64); ensure(/^[a-zA-Z0-9._-]+$/.test(item.id));
    text(item.requirement, 1024); text(item.verification, 1024);
    return { id: item.id, requirement: item.requirement, verification: item.verification };
  });
  ensure(new Set(acceptanceCriteria.map(item => item.id)).size === acceptanceCriteria.length);
  return { schemaVersion: "1", network: input.network, asset: input.asset, contract: input.contract,
    client: input.client, evaluator: input.evaluator, description: input.description, acceptanceCriteria };
}
export async function prepareEvaluationJob(input: CriteriaCommitmentInput) {
  const criteriaHash = await digest("nayori/criteria/v1", criteriaManifest(input));
  return { criteriaHash, description: input.description + CRITERIA + criteriaHash };
}
export function parseEvaluationDescription(description: string) {
  text(description, 512);
  const index = description.lastIndexOf(CRITERIA);
  ensure(index > 0);
  const plainDescription = description.slice(0, index);
  const criteriaHash = description.slice(index + CRITERIA.length);
  ensure(HASH.test(criteriaHash) && !plainDescription.includes("nayori-criteria-"));
  return { description: plainDescription, criteriaHash };
}
export async function prepareEvaluationSubmission(input: EvidenceCommitmentInput) {
  const criteria = await prepareEvaluationJob(input);
  ensure(/^[1-9][0-9]{0,38}$/.test(input.jobId) && BigInt(input.jobId) < 2n ** 128n);
  ensure(PRINCIPAL.test(input.provider) && ![input.client, input.evaluator].includes(input.provider));
  ensure(Array.isArray(input.evidence) && input.evidence.length >= 1 && input.evidence.length <= 50);
  const evidence = input.evidence.map(item => {
    text(item.id, 64); ensure(/^[a-zA-Z0-9._-]+$/.test(item.id));
    text(item.uri, 2048);
    const uri = new URL(item.uri);
    ensure(uri.protocol === "https:" && !uri.username && !uri.password && !uri.hash);
    ensure(HASH.test(item.sha256) && !/^0+$/.test(item.sha256));
    text(item.mediaType, 128);
    ensure(Number.isSafeInteger(item.sizeBytes) && item.sizeBytes >= 0 && item.sizeBytes <= 25_000_000);
    return { id: item.id, uri: item.uri, sha256: item.sha256, mediaType: item.mediaType, sizeBytes: item.sizeBytes };
  });
  ensure(new Set(evidence.map(item => item.id)).size === evidence.length);
  const evidenceHash = await digest("nayori/evidence/v1", {
    schemaVersion: "1", network: input.network, asset: input.asset, contract: input.contract,
    jobId: input.jobId, client: input.client, provider: input.provider, evaluator: input.evaluator,
    criteriaHash: criteria.criteriaHash, evidence,
  });
  // Existing submit-work ABI is (buff 64): four ASCII version bytes + 32 raw digest bytes.
  const deliverable = new Uint8Array(36);
  deliverable.set(new TextEncoder().encode(EVIDENCE));
  deliverable.set(Uint8Array.from(evidenceHash.match(/../g)!, pair => parseInt(pair, 16)), 4);
  return { ...criteria, evidenceHash, deliverable };
}
export async function evaluationJobId(input: Pick<EvidenceCommitmentInput, "network" | "contract" | "jobId">): Promise<string> {
  ensure(input.network === "testnet" && /^ST[A-Z0-9]{20,41}\.[a-z][a-z0-9-]{0,39}$/.test(input.contract));
  ensure(/^[1-9][0-9]{0,38}$/.test(input.jobId) && BigInt(input.jobId) < 2n ** 128n);
  const hash = await digest("nayori/evaluation-id/v1", {
    network: input.network, contract: input.contract, jobId: input.jobId,
  });
  // Deterministic UUID-shaped identifier, not a credential.
  return hash.slice(0, 8) + "-" + hash.slice(8, 12) + "-5" + hash.slice(13, 16) +
    "-a" + hash.slice(17, 20) + "-" + hash.slice(20, 32);
}
