import type { EvaluationArtifact } from "./domain.js";
import {
  Cl,
  PostConditionMode,
  broadcastTransaction,
  fetchNonce,
  getAddressFromPrivateKey,
  makeContractCall,
} from "@stacks/transactions";
import { STACKS_TESTNET } from "@stacks/network";

export interface DecisionReceipt {
  readonly txid: string;
  readonly network: "testnet";
  readonly contract: string;
  readonly jobId: string;
}

export interface DecisionRecorder {
  recordDecision(artifact: EvaluationArtifact): Promise<DecisionReceipt>;
}

export interface RestrictedDecisionAdapter {
  execute(input: {
    readonly network: "testnet";
    readonly contract: string;
    readonly functionName: "record-decision";
    readonly jobId: string;
    readonly decision: "approve" | "reject";
    readonly evidenceHash: string;
    readonly explanationHash: string;
  }): Promise<DecisionReceipt>;
}

export class AllowlistedDecisionRecorder implements DecisionRecorder {
  private readonly contracts: ReadonlySet<string>;
  private readonly adapter: RestrictedDecisionAdapter;

  constructor(options: {
    readonly stxContract: string;
    readonly sbtcContract: string;
    readonly adapter: RestrictedDecisionAdapter;
  }) {
    this.contracts = new Set([options.stxContract, options.sbtcContract]);
    this.adapter = options.adapter;
  }

  async recordDecision(artifact: EvaluationArtifact): Promise<DecisionReceipt> {
    if (artifact.network !== "testnet") throw new Error("Only Stacks testnet is allowed.");
    if (!this.contracts.has(artifact.contract)) throw new Error("Contract is not allowlisted.");
    return this.adapter.execute({
      network: "testnet",
      contract: artifact.contract,
      functionName: "record-decision",
      jobId: artifact.jobId,
      decision: artifact.decision,
      evidenceHash: artifact.evidenceHash,
      explanationHash: artifact.explanationHash,
    });
  }
}

export interface StacksTestnetDecisionAdapterOptions {
  readonly apiUrl: string;
  readonly privateKey: string;
  readonly evaluatorPrincipal: string;
  readonly fee: number;
}

export class StacksTestnetDecisionAdapter implements RestrictedDecisionAdapter {
  private readonly apiUrl: string;
  private readonly privateKey: string;
  private readonly evaluatorPrincipal: string;
  private readonly fee: number;

  constructor(options: StacksTestnetDecisionAdapterOptions) {
    const derived = getAddressFromPrivateKey(options.privateKey, "testnet");
    if (derived !== options.evaluatorPrincipal) {
      throw new Error("Evaluator signer does not match EVALUATOR_PRINCIPAL.");
    }
    this.apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.privateKey = options.privateKey;
    this.evaluatorPrincipal = options.evaluatorPrincipal;
    this.fee = options.fee;
  }

  async execute(input: {
    readonly network: "testnet";
    readonly contract: string;
    readonly functionName: "record-decision";
    readonly jobId: string;
    readonly decision: "approve" | "reject";
    readonly evidenceHash: string;
    readonly explanationHash: string;
  }): Promise<DecisionReceipt> {
    if (input.network !== "testnet" || input.functionName !== "record-decision") {
      throw new Error("Decision adapter only permits record-decision on Stacks testnet.");
    }
    const [contractAddress, contractName, extra] = input.contract.split(".");
    if (!contractAddress || !contractName || extra) throw new Error("Invalid contract identifier.");
    const nonce = await fetchNonce({
      address: this.evaluatorPrincipal,
      network: { ...STACKS_TESTNET, client: { baseUrl: this.apiUrl } },
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
      network: { ...STACKS_TESTNET, client: { baseUrl: this.apiUrl } },
      nonce,
      fee: BigInt(this.fee),
      postConditionMode: PostConditionMode.Deny,
      postConditions: [],
    });
    const result = await broadcastTransaction({
      transaction,
      network: { ...STACKS_TESTNET, client: { baseUrl: this.apiUrl } },
    });
    const broadcast = result as { txid?: string; error?: string; reason?: string };
    if (broadcast.error || !broadcast.txid) {
      throw new Error(
        `Stacks testnet rejected record-decision: ${broadcast.reason ?? broadcast.error ?? "missing txid"}`
      );
    }
    const txid = broadcast.txid.startsWith("0x")
      ? broadcast.txid
      : `0x${broadcast.txid}`;
    return {
      txid,
      network: "testnet",
      contract: input.contract,
      jobId: input.jobId,
    };
  }
}
