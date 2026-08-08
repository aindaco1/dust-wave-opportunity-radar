import { describe, expect, it } from "vitest";
import { createRoutineDeployConfig, parseWranglerConfig } from "../scripts/deploy";

describe("routine deployment configuration", () => {
  it("omits only Email Routing address reconciliation", () => {
    const source = {
      $schema: "./node_modules/wrangler/config-schema.json",
      name: "dustwave-opportunity-radar",
      main: "src/index.ts",
      addresses: ["hey@ingest.dustwave.xyz"],
      d1_databases: [{ binding: "DB", database_name: "dustwave-opportunity-radar" }],
      vars: { ENVIRONMENT: "production" }
    };

    expect(createRoutineDeployConfig(source)).toEqual({
      $schema: "./node_modules/wrangler/config-schema.json",
      name: "dustwave-opportunity-radar",
      main: "src/index.ts",
      d1_databases: [{ binding: "DB", database_name: "dustwave-opportunity-radar" }],
      vars: { ENVIRONMENT: "production" }
    });
    expect(source.addresses).toEqual(["hey@ingest.dustwave.xyz"]);
  });

  it("parses comments and trailing commas from the reviewed JSONC source", () => {
    expect(parseWranglerConfig(`{
      // Keep routine deployment compatible with reviewed JSONC.
      "name": "dustwave-opportunity-radar",
    }`)).toEqual({ name: "dustwave-opportunity-radar" });
  });
});
