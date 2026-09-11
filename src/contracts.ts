import { validateStacksAddress } from "@stacks/transactions";
import { z } from "zod";

export const TESTNET_API_URL = "https://api.testnet.hiro.so";
export function isTestnetApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === TESTNET_API_URL && url.pathname === "/" &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export const testnetPrincipal = z.string().refine(
  value => value.startsWith("ST") && validateStacksAddress(value),
  "A valid testnet standard principal is required."
);
const contractId = z.string().refine(value => {
  const [address, name, extra] = value.split(".");
  return !extra && testnetPrincipal.safeParse(address).success &&
    Boolean(name && /^[a-z][a-z0-9-]{0,39}$/.test(name));
}, "A valid testnet contract identifier is required.");

export const commerceContractsSchema = z.object({
  stxContract: contractId,
  sbtcContract: contractId,
}).refine(pair => {
  const [stxAddress, stxName] = pair.stxContract.split(".");
  const [sbtcAddress, sbtcName] = pair.sbtcContract.split(".");
  return stxAddress === sbtcAddress && (
    (stxName === "agentic-commerce-v5" && sbtcName === "sbtc-commerce-v4") ||
    (stxName === "agentic-commerce-v6" && sbtcName === "sbtc-commerce-v5")
  );
}, "Select the matching v5/v4 or v6/v5 pair under one testnet deployer.");

export type CommerceContracts = z.infer<typeof commerceContractsSchema>;
export function hasServiceFees(contracts: CommerceContracts): boolean {
  return contracts.stxContract.endsWith(".agentic-commerce-v6");
}
export function matchesTarget(contracts: CommerceContracts, target: {
  readonly network: string; readonly asset: string; readonly contract: string;
}): boolean {
  return target.network === "testnet" && (
    (target.asset === "stx" && target.contract === contracts.stxContract) ||
    (target.asset === "sbtc" && target.contract === contracts.sbtcContract)
  );
}
