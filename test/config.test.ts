import { describe, expect, it } from "vitest";
import { loadRuntimeConfig, sourceLabel } from "../src/config";
import { env } from "./support/fixtures";

describe("runtime configuration", () => {
  it("parses production-like bindings and trims folder names", () => {
    const config = loadRuntimeConfig(env({
      BATCH_HOURS: " 7, 19 ",
      ZOHO_ACCOUNT_EMAIL: "Alonso@DustWave.XYZ",
      ZOHO_DATACENTER: "US",
      ZOHO_FOLDERS: "Inbox, Dust Wave,Newsletter, Notification, "
    }));
    expect([...config.batchHours]).toEqual([7, 19]);
    expect(config.zohoAccountEmail).toBe("alonso@dustwave.xyz");
    expect(config.zohoDatacenter).toBe("us");
    expect(config.zohoFolders).toEqual(["Inbox", "Dust Wave", "Newsletter", "Notification"]);
  });

  it("enables feature flags only for the literal true value", () => {
    expect(loadRuntimeConfig(env({ NOTION_ENABLED: "true", ZOHO_ENABLED: "true", CREATIVE_WEST_ENABLED: "true", COLOSSAL_ENABLED: "true" })))
      .toMatchObject({ notionEnabled: true, zohoEnabled: true, creativeWestEnabled: true, colossalEnabled: true });
    expect(loadRuntimeConfig(env({ NOTION_ENABLED: "TRUE", ZOHO_ENABLED: "1", CREATIVE_WEST_ENABLED: "TRUE", COLOSSAL_ENABLED: "1" })))
      .toMatchObject({ notionEnabled: false, zohoEnabled: false, creativeWestEnabled: false, colossalEnabled: false });
  });

  it.each([
    ["BATCH_HOURS", ""],
    ["BATCH_HOURS", "7,24"],
    ["BATCH_HOURS", "7.5"],
    ["AI_CONFIDENCE_THRESHOLD", "1.01"],
    ["AI_CONFIDENCE_THRESHOLD", "not-a-number"],
    ["INITIAL_BACKFILL_DAYS", "0"],
    ["ATTACHMENT_MAX_BYTES", "2.5"],
    ["R2_RETENTION_HOURS", "-1"]
  ])("rejects invalid %s=%s", (key, value) => {
    expect(() => loadRuntimeConfig(env({ [key]: value }))).toThrow();
  });
});

describe("source labels", () => {
  it("renders human-readable source origins", () => {
    expect(sourceLabel("hey", "Imbox")).toBe("HEY · Imbox");
    expect(sourceLabel("zoho", "Dust Wave")).toBe("Zoho · Dust Wave");
    expect(sourceLabel("creative_west", "New Mexico")).toBe("Creative West · New Mexico");
    expect(sourceLabel("colossal", "Opportunities")).toBe("Colossal · Opportunities");
  });
});
