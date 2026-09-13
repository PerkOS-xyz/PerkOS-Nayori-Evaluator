import { validateStacksAddress } from "@stacks/transactions";
import { z } from "zod";

export type StacksNetworkName = "testnet" | "mainnet";
export const MAINNET_EVALUATOR_CONFIRMATION = "enable-record-decision-v6-v5-mainnet";

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
    serviceFeeBps: 200,
    reviewWindow: 12,
    appealWindow: 3,
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
    privateEvidenceOrigin: null,
    serviceFeeBps: 200,
    reviewWindow: 12,
    appealWindow: 144,
    treasury: "SP1NT1V4X6GQR6T32Z8MSMNECZ6GSWX9HZ81SM1Y8",
    appealAuthority: "SP28DBK3Q89F4KRYGPF51QT0RYEZBPXS4BAQ0ETBH",
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

export interface CommerceContracts {
  readonly network: StacksNetworkName;
  readonly stxContract: string;
  readonly sbtcContract: string;
}

export const commerceContractsSchema: z.ZodType<CommerceContracts> = z.object({
  network: z.enum(["testnet", "mainnet"]),
  stxContract: z.string(),
  sbtcContract: z.string(),
}).superRefine((contracts, context) => {
  const policy = policyForNetwork(contracts.network);
  if (contracts.stxContract !== policy.stxContract || contracts.sbtcContract !== policy.sbtcContract) {
    context.addIssue({ code: "custom", message: "Contracts do not match the exact network allowlist." });
  }
});

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
    (target.asset === "sbtc" && target.contract === contracts.sbtcContract)
  );
}
