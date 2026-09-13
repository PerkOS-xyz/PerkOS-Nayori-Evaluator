import type { EvaluationArtifact } from "./domain.js";
import {
  Cl,
  PostConditionMode,
  broadcastTransaction,
  fetchNonce,
  getAddressFromPrivateKey,
  makeContractCall,
} from "@stacks/transactions";
import { STACKS_MAINNET, STACKS_TESTNET } from "@stacks/network";
import { z } from "zod";
import {
  commerceContractsSchema,
  isCanonicalApiUrl,
  matchesTarget,
  type CommerceContracts,
  type StacksNetworkName,
} from "./contracts.js";

export interface DecisionReceipt {
  readonly txid: string;
  readonly network: StacksNetworkName;
  readonly contract: string;
  readonly jobId: string;
}

export interface DecisionRecorder {
  recordDecision(artifact: EvaluationArtifact): Promise<DecisionReceipt>;
}

export interface RestrictedDecisionAdapter {
  execute(input: {
    readonly network: StacksNetworkName;
    readonly contract: string;
    readonly functionName: "record-decision";
    readonly jobId: string;
    readonly decision: "approve" | "reject";
    readonly evidenceHash: string;
    readonly explanationHash: string;
  }): Promise<DecisionReceipt>;
}

export class AllowlistedDecisionRecorder implements DecisionRecorder {
  private readonly contracts: CommerceContracts;
  private readonly adapter: RestrictedDecisionAdapter;

  constructor(options: CommerceContracts & { readonly adapter: RestrictedDecisionAdapter }) {
    this.contracts = commerceContractsSchema.parse(options);
    this.adapter = options.adapter;
  }

  async recordDecision(artifact: EvaluationArtifact): Promise<DecisionReceipt> {
    if (!matchesTarget(this.contracts, artifact)) throw new Error("Asset/contract/network is not allowlisted.");
    return this.adapter.execute({
      network: this.contracts.network,
      contract: artifact.contract,
      functionName: "record-decision",
      jobId: artifact.jobId,
      decision: artifact.decision,
      evidenceHash: artifact.evidenceHash,
      explanationHash: artifact.explanationHash,
    });
  }
}

export interface StacksDecisionAdapterOptions {
  readonly contracts: CommerceContracts;
  readonly apiUrl: string;
  readonly privateKey: string;
  readonly evaluatorPrincipal: string;
  readonly fee: number;
}

export class StacksDecisionAdapter implements RestrictedDecisionAdapter {
  private readonly contracts: CommerceContracts;
  private readonly apiUrl: string;
  private readonly privateKey: string;
  private readonly evaluatorPrincipal: string;
  private readonly fee: number;
  private readonly network: typeof STACKS_TESTNET | typeof STACKS_MAINNET;

  constructor(options: StacksDecisionAdapterOptions) {
    this.contracts = commerceContractsSchema.parse(options.contracts);
    if (!isCanonicalApiUrl(this.contracts.network, options.apiUrl)) {
      throw new Error("Stacks API does not match the selected network.");
    }
    if (!Number.isSafeInteger(options.fee) || options.fee < 1_000 || options.fee > 100_000) {
      throw new Error("Decision gas fee is outside the configured safety range.");
    }
    const derived = getAddressFromPrivateKey(options.privateKey, this.contracts.network);
    if (derived !== options.evaluatorPrincipal) {
      throw new Error("Evaluator signer does not match EVALUATOR_PRINCIPAL.");
    }
    this.apiUrl = options.apiUrl.replace(/\/+$/, "");
    const selected = this.contracts.network === "mainnet" ? STACKS_MAINNET : STACKS_TESTNET;
    this.network = { ...selected, client: { baseUrl: this.apiUrl,
      fetch: (url, init) => fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) }) } };
    this.privateKey = options.privateKey;
    this.evaluatorPrincipal = options.evaluatorPrincipal;
    this.fee = options.fee;
  }

  async execute(input: {
    readonly network: StacksNetworkName;
    readonly contract: string;
    readonly functionName: "record-decision";
    readonly jobId: string;
    readonly decision: "approve" | "reject";
    readonly evidenceHash: string;
    readonly explanationHash: string;
  }): Promise<DecisionReceipt> {
    if (input.network !== this.contracts.network || input.functionName !== "record-decision") {
      throw new Error("Decision adapter only permits record-decision on its selected network.");
    }
    if (![this.contracts.stxContract, this.contracts.sbtcContract].some(contract => contract === input.contract)) {
      throw new Error("Contract is not allowlisted by the signing adapter.");
    }
    const digest = z.string().regex(/^[0-9a-f]{64}$/).refine(value => value !== "0".repeat(64));
    z.object({
      jobId: z.string().regex(/^[1-9][0-9]*$/).refine(value => BigInt(value) < 2n ** 128n),
      decision: z.enum(["approve", "reject"]), evidenceHash: digest, explanationHash: digest,
    }).parse(input);
    const [contractAddress, contractName, extra] = input.contract.split(".");
    if (!contractAddress || !contractName || extra) throw new Error("Invalid contract identifier.");
    const nonce = await fetchNonce({
      address: this.evaluatorPrincipal,
      network: this.network,
    });
    const transaction = await makeContractCall({
      contractAddress,
      contractName,
      functionName: "record-decision",
      functionArgs: [
        Cl.uint(BigInt(input.jobId)),
        Cl.uint(input.decision === "approve" ? 1 : 2),
        Cl.bufferFromHex(input.evidenceHash),
        Cl.bufferFromHex(input.explanationHash),
      ],
      senderKey: this.privateKey,
      network: this.network,
      nonce,
      fee: BigInt(this.fee),
      postConditionMode: PostConditionMode.Deny,
      postConditions: [],
    });
    const result = await broadcastTransaction({
      transaction,
      network: this.network,
    });
    const broadcast = result as { txid?: string; error?: string; reason?: string };
    if (broadcast.error || !broadcast.txid) {
      throw new Error(
        `Stacks ${this.contracts.network} rejected record-decision: ${broadcast.reason ?? broadcast.error ?? "missing txid"}`
      );
    }
    const txid = broadcast.txid.startsWith("0x") ? broadcast.txid : `0x${broadcast.txid}`;
    return {
      txid,
      network: this.contracts.network,
      contract: input.contract,
      jobId: input.jobId,
    };
  }
}
