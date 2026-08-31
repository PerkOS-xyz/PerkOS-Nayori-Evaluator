import type { EvaluationArtifact } from "./domain.js";

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
