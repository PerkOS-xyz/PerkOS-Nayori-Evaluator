import { Cl, ClarityType, type ClarityValue } from "@stacks/transactions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextJobWatcher } from "../src/next-watcher.js";
import { EVALUATOR_NETWORK_POLICIES, NAYORI_NEXT_DEPLOYERS, nextEscrowContracts } from "../src/contracts.js";

const policy = EVALUATOR_NETWORK_POLICIES.testnet;
const next = nextEscrowContracts(NAYORI_NEXT_DEPLOYERS.testnet);
const OTHER_EVALUATOR = policy.appealAuthority;
const current = { network: "testnet" as const, stxContract: policy.stxContract, sbtcContract: policy.sbtcContract };

interface FakeJob { status: number; evaluator?: string; reviewDeadline?: number }

function fixture(jobs: Partial<Record<string, FakeJob[]>>, options: { maxReadsPerScan?: number } = {}) {
  const info: { network_id: number; burn_block_height: number } = { network_id: policy.networkId, burn_block_height: 100 };
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(info)));
  const read = vi.fn(async (contract: string, fn: string, args: ClarityValue[]) => {
    const list = jobs[contract] ?? [];
    if (fn === "get-job-count") return Cl.uint(list.length);
    const id = args[0]?.type === ClarityType.UInt ? Number(args[0].value) : 0;
    const job = list[id - 1];
    if (fn === "get-job") {
      return job ? Cl.some(Cl.tuple({ status: Cl.uint(job.status),
        evaluator: Cl.standardPrincipal(job.evaluator ?? policy.evaluator) })) : Cl.none();
    }
    if (fn === "get-submission") {
      return job?.reviewDeadline === undefined ? Cl.none()
        : Cl.some(Cl.tuple({ deliverable: Cl.buffer(new Uint8Array(36)), "review-deadline": Cl.uint(job.reviewDeadline) }));
    }
    throw new Error(`Unexpected read ${fn}`);
  });
  const watcher = new NextJobWatcher({ contracts: { ...current, next }, evaluatorPrincipal: policy.evaluator,
    apiUrl: policy.apiUrl, fetch: fetchMock, readOnly: read, ...options });
  return { watcher, read, fetchMock, info, jobs };
}

async function scan(watcher: NextJobWatcher) {
  const pending = watcher.scan();
  await vi.advanceTimersByTimeAsync(3_000); // read pacing between scans
  return pending;
}

afterEach(() => vi.useRealTimers());

describe("Next-generation job watcher", () => {
  it("reports submitted jobs of this evaluator inside the review window only", async () => {
    vi.useFakeTimers();
    const f = fixture({
      [next.stxContract]: [
        { status: 4, reviewDeadline: 112 },                         // ready
        { status: 4, reviewDeadline: 99 },                          // window closed: keeper's job
        { status: 4, evaluator: OTHER_EVALUATOR, reviewDeadline: 112 }, // someone else's job
        { status: 3 },                                              // accepted, not yet submitted
        { status: 5, reviewDeadline: 112 },                         // already decided
      ],
      [next.sbtcContract]: [{ status: 4, reviewDeadline: 100 }],    // exact deadline is still open
    }, { maxReadsPerScan: 50 });
    expect(await scan(f.watcher)).toEqual([
      { asset: "stx", contract: next.stxContract, jobId: "1", reviewDeadline: "112", blocksLeft: "12" },
      { asset: "sbtc", contract: next.sbtcContract, jobId: "1", reviewDeadline: "100", blocksLeft: "0" },
    ]);
    expect(f.read.mock.calls.every(([contract]) => contract === next.stxContract || contract === next.sbtcContract)).toBe(true);
    expect(f.fetchMock).toHaveBeenCalledOnce();
  });

  it("re-checks only unsubmitted jobs and new ids, and picks up a later submission", async () => {
    vi.useFakeTimers();
    const f = fixture({ [next.stxContract]: [{ status: 3 }, { status: 7 }] }, { maxReadsPerScan: 50 });
    expect(await scan(f.watcher)).toEqual([]);
    f.read.mockClear();
    f.jobs[next.stxContract]![0] = { status: 4, reviewDeadline: 105 };
    f.jobs[next.stxContract]!.push({ status: 4, reviewDeadline: 110 });
    const ready = await scan(f.watcher);
    expect(ready.map(job => job.jobId).sort()).toEqual(["1", "3"]);
    const jobReads = f.read.mock.calls.filter(([, fn]) => fn === "get-job").map(([, , args]) => args[0]);
    expect(jobReads).toEqual([Cl.uint(3), Cl.uint(1)]); // job 2 was completed and is not read again
  });

  it("reports a ready job once and never a job whose window closed", async () => {
    vi.useFakeTimers();
    const f = fixture({ [next.sbtcContract]: [{ status: 3 }, { status: 3 }] }, { maxReadsPerScan: 50 });
    expect(await scan(f.watcher)).toEqual([]);
    f.jobs[next.sbtcContract]![0] = { status: 4, reviewDeadline: 101 };
    f.jobs[next.sbtcContract]![1] = { status: 4, reviewDeadline: 99 };
    expect((await scan(f.watcher)).map(job => job.jobId)).toEqual(["1"]);
    expect(await scan(f.watcher)).toEqual([]);
  });

  it("bounds reads per scan and resumes where it stopped", async () => {
    vi.useFakeTimers();
    const many = Array.from({ length: 6 }, () => ({ status: 4, reviewDeadline: 120 }));
    const f = fixture({ [next.stxContract]: many }, { maxReadsPerScan: 5 });
    const first = await scan(f.watcher);
    expect(f.read).toHaveBeenCalledTimes(5);
    expect(first.map(job => job.jobId)).toEqual(["1", "2"]);
    const reported = first.map(job => job.jobId);
    for (let i = 0; i < 6; i++) reported.push(...(await scan(f.watcher)).map(job => job.jobId));
    expect(reported.sort()).toEqual(["1", "2", "3", "4", "5", "6"]); // each exactly once
  });

  it("requires the next generation to be configured and the canonical API", () => {
    expect(() => new NextJobWatcher({ contracts: current, evaluatorPrincipal: policy.evaluator, apiUrl: policy.apiUrl }))
      .toThrow("not configured");
    expect(() => new NextJobWatcher({ contracts: { ...current, next }, evaluatorPrincipal: policy.evaluator,
      apiUrl: EVALUATOR_NETWORK_POLICIES.mainnet.apiUrl })).toThrow();
  });

  it("watches the pinned mainnet escrows on mainnet, and only those", () => {
    const main = EVALUATOR_NETWORK_POLICIES.mainnet;
    const mainCurrent = { network: "mainnet" as const, stxContract: main.stxContract, sbtcContract: main.sbtcContract };
    expect(() => new NextJobWatcher({ contracts: { ...mainCurrent, next: nextEscrowContracts(NAYORI_NEXT_DEPLOYERS.mainnet) },
      evaluatorPrincipal: main.evaluator, apiUrl: main.apiUrl })).not.toThrow();
    expect(() => new NextJobWatcher({ contracts: { ...mainCurrent, next }, evaluatorPrincipal: main.evaluator,
      apiUrl: main.apiUrl })).toThrow();
  });

  it("fails closed on a crossed network", async () => {
    const f = fixture({});
    f.info.network_id = EVALUATOR_NETWORK_POLICIES.mainnet.networkId;
    await expect(f.watcher.scan()).rejects.toThrow("network_mismatch"); // first read is not paced
    expect(f.read).not.toHaveBeenCalled();
  });
});
