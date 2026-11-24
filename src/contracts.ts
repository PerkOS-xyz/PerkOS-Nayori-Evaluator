import { validateStacksAddress } from "@stacks/transactions";
import { z } from "zod";

export type StacksNetworkName = "testnet" | "mainnet";
export const MAINNET_EVALUATOR_CONFIRMATION = "enable-record-decision-v6-v5-mainnet";
/** Separate acknowledgement for signing record-decision on the next mainnet escrows. */
export const MAINNET_NEXT_EVALUATOR_CONFIRMATION = "enable-record-decision-nayori-escrow-mainnet";

export const EVALUATOR_NETWORK_POLICIES = {
  testnet: {
    environment: "qa",
    apiUrl: "https://api.testnet.hiro.so",
    networkId: 2_147_483_648,
    deployer: "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5",
    stxContract: "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5.agentic-commerce-v6",
    sbtcContract: "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5.sbtc-commerce-v5",
    sbtcToken: "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token",
    privateEvidenceOrigin: "https://api.qa.nayori.ai",
    privateEvidenceTokenEndpoint: "https://oauth.qa.nayori.ai/oauth/token",
    privateEvidenceObjectHost: "perkos-nayori-qa-evidence-089332276762.s3.us-east-1.amazonaws.com",
    serviceFeeBps: 200,
    reviewWindow: 12,
    appealWindow: 3,
    evaluator: "STBTXHXFXFGMNPXST7A6XQ1WNGC0V6TB6CDDQZB4",
    treasury: "ST1E7E64H8VSSSGE0RPWF90RRC91MQG7CRQRM1BFX",
    appealAuthority: "ST256E5DAXM7RDFZ76ECCTPTBYHRXXJQ29H16DN69",
  },
  mainnet: {
    environment: "production",
    apiUrl: "https://api.hiro.so",
    networkId: 1,
    deployer: "SP2K7PV5NXBNRV510S6DCA6RFMTFHAF3ZPK6ZSXPH",
    stxContract: "SP2K7PV5NXBNRV510S6DCA6RFMTFHAF3ZPK6ZSXPH.agentic-commerce-v6",
    sbtcContract: "SP2K7PV5NXBNRV510S6DCA6RFMTFHAF3ZPK6ZSXPH.sbtc-commerce-v5",
    sbtcToken: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
    privateEvidenceOrigin: "https://api.nayori.ai",
    privateEvidenceTokenEndpoint: "https://oauth.nayori.ai/oauth/token",
    privateEvidenceObjectHost: "perkos-nayori-prod-evidence-089332276762.s3.us-east-1.amazonaws.com",
    serviceFeeBps: 200,
    reviewWindow: 12,
    appealWindow: 144,
    evaluator: "SP3GRG5CKEFNYM5BV0NPPHCM51FT176JQ02QWQ9T3",
    treasury: "SP1NT1V4X6GQR6T32Z8MSMNECZ6GSWX9HZ81SM1Y8",
    appealAuthority: "SP2R584GC8W2A921080TY8CQ8P1GZ6JNXYXS65DA6",
  },
} as const;

export function policyForNetwork(network: StacksNetworkName) {
  return EVALUATOR_NETWORK_POLICIES[network];
}

function canonicalOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.pathname !== "/" || url.username || url.password || url.search || url.hash) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function isCanonicalApiUrl(network: StacksNetworkName, value: string): boolean {
  return canonicalOrigin(value) === policyForNetwork(network).apiUrl;
}

export function isPrincipalForNetwork(value: string, network: StacksNetworkName): boolean {
  const prefix = network === "testnet" ? "ST" : "SP";
  return value.startsWith(prefix) && !value.includes(".") && validateStacksAddress(value);
}

export function isContractIdForNetwork(value: string, network: StacksNetworkName): boolean {
  const [address, name, extra] = value.split(".");
  return !extra && isPrincipalForNetwork(address ?? "", network) &&
    Boolean(name && /^[a-z][a-z0-9-]{0,39}$/.test(name));
}

/**
 * Next contract generation (nayori-escrow-stx / nayori-escrow-sbtc), live on 2026-11-24. The
 * deployer of each network is pinned here like the current release tuple; the deployer has no
 * powers over the contracts (roles live in nayori-roles). The generation is still opt-in through
 * configuration, and it is accepted only on the networks listed in NAYORI_NEXT_NETWORKS. On mainnet
 * it also needs its own activation acknowledgement, MAINNET_NEXT_EVALUATOR_CONFIRMATION.
 */
export const NAYORI_NEXT_ESCROW_NAMES = { stx: "nayori-escrow-stx", sbtc: "nayori-escrow-sbtc" } as const;
export const NAYORI_NEXT_DEPLOYERS: Readonly<Record<StacksNetworkName, string>> = {
  testnet: "ST3MRPNX0VNWYRSJ07PNTASE5BZ9K5XE57ARZ39DY",
  mainnet: "SP2BM4WCNQM286PFHPGA1BG2YXER0PCG1PKQ5MF1X",
};
export const NAYORI_NEXT_NETWORKS: readonly StacksNetworkName[] = ["testnet", "mainnet"];

export interface NextEscrowContracts {
  readonly stxContract: string;
  readonly sbtcContract: string;
}

export function nextEscrowContracts(deployer: string): NextEscrowContracts {
  return {
    stxContract: `${deployer}.${NAYORI_NEXT_ESCROW_NAMES.stx}`,
    sbtcContract: `${deployer}.${NAYORI_NEXT_ESCROW_NAMES.sbtc}`,
  };
}

/** The pinned next escrows of an enabled network. */
export function nextEscrowContractsForNetwork(network: StacksNetworkName): NextEscrowContracts {
  if (!NAYORI_NEXT_NETWORKS.includes(network)) throw new Error("Next generation is not enabled for this network.");
  return nextEscrowContracts(NAYORI_NEXT_DEPLOYERS[network]);
}

/** Only the pinned deployer of an enabled network is accepted; an operator cannot pick another one. */
export function isNextDeployerForNetwork(deployer: string, network: StacksNetworkName): boolean {
  return NAYORI_NEXT_NETWORKS.includes(network) && deployer === NAYORI_NEXT_DEPLOYERS[network] &&
    isPrincipalForNetwork(deployer, network);
}

export interface CommerceContracts {
  readonly network: StacksNetworkName;
  readonly stxContract: string;
  readonly sbtcContract: string;
  readonly next?: NextEscrowContracts | undefined;
}

export const commerceContractsSchema: z.ZodType<CommerceContracts> = z.object({
  network: z.enum(["testnet", "mainnet"]),
  stxContract: z.string(),
  sbtcContract: z.string(),
  next: z.object({ stxContract: z.string(), sbtcContract: z.string() }).optional(),
}).superRefine((contracts, context) => {
  const policy = policyForNetwork(contracts.network);
  if (contracts.stxContract !== policy.stxContract || contracts.sbtcContract !== policy.sbtcContract) {
    context.addIssue({ code: "custom", message: "Contracts do not match the exact network allowlist." });
  }
  if (contracts.next) {
    const [deployer = ""] = contracts.next.stxContract.split(".");
    const expected = nextEscrowContracts(deployer);
    if (!isNextDeployerForNetwork(deployer, contracts.network) ||
      contracts.next.stxContract !== expected.stxContract || contracts.next.sbtcContract !== expected.sbtcContract) {
      context.addIssue({ code: "custom", message: "Next-generation contracts are invalid for the selected network." });
    }
  }
});

/** True only for the configured next-generation escrows; the current pair is never "next". */
export function isNextContract(contracts: CommerceContracts, contract: string): boolean {
  return Boolean(contracts.next) &&
    (contract === contracts.next?.stxContract || contract === contracts.next?.sbtcContract);
}

export function hasServiceFees(contracts: CommerceContracts): boolean {
  return policyForNetwork(contracts.network).serviceFeeBps > 0;
}

export function matchesTarget(contracts: CommerceContracts, target: {
  readonly network: string;
  readonly asset: string;
  readonly contract: string;
}): boolean {
  return target.network === contracts.network && (
    (target.asset === "stx" && target.contract === contracts.stxContract) ||
    (target.asset === "sbtc" && target.contract === contracts.sbtcContract) ||
    (target.asset === "stx" && target.contract === contracts.next?.stxContract) ||
    (target.asset === "sbtc" && target.contract === contracts.next?.sbtcContract)
  );
}
