import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRoutineDeployConfig, parseWranglerConfig } from "../scripts/deploy";

describe("routine deployment configuration", () => {
  it("deploys only Radar's batch and human-review digest bindings", () => {
    const config = createRoutineDeployConfig(parseWranglerConfig(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")));
    expect(config.workflows).toEqual([{
      binding: "BATCH_WORKFLOW",
      name: "dustwave-opportunity-radar-batch",
      class_name: "OpportunityBatchWorkflow"
    }]);
    expect((config.send_email as Array<{ name: string }>).map((binding) => binding.name)).toEqual(["EMAIL"]);
    expect(Object.keys(config.vars as Record<string, unknown>).filter((name) => name.startsWith("NEWSLETTER_"))).toEqual([]);
  });

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
