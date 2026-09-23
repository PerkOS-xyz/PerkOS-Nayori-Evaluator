import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPrivateEvidenceCredentials } from "../src/private-evidence.js";

const wallet = "SP3GRG5CKEFNYM5BV0NPPHCM51FT176JQ02QWQ9T3";
const client = { clientId: `ny_oc_${"a".repeat(24)}`, clientSecret: "s".repeat(32),
  tokenEndpoint: "https://oauth.nayori.ai/oauth/token", walletAddress: wallet, scopes: ["evidence:read"] };

describe("private evidence credential release boundary", () => {
  it("pins the wallet and token endpoint without permitting additional scopes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nayori-private-evidence-"));
    const file = join(dir, "oauth.json");
    try {
      await writeFile(file, JSON.stringify(client), { mode: 0o600 });
      expect(loadPrivateEvidenceCredentials(file, wallet, client.tokenEndpoint)).toMatchObject(client);
      expect(() => loadPrivateEvidenceCredentials(file, wallet, "https://oauth.qa.nayori.ai/oauth/token")).toThrow();
      await writeFile(file, JSON.stringify({ ...client, scopes: ["evidence:read", "evidence:write"] }), { mode: 0o600 });
      expect(() => loadPrivateEvidenceCredentials(file, wallet, client.tokenEndpoint)).toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
