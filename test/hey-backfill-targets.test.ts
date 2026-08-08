import { describe, expect, it } from "vitest";
import { parseBackfillTargets } from "../scripts/hey-backfill-targets.mjs";

describe("targeted HEY backfill input", () => {
  it("uses normal folder pagination when the temporary target secret is absent", () => {
    expect(parseBackfillTargets(undefined)).toEqual([]);
    expect(parseBackfillTargets("  ")).toEqual([]);
  });

  it("validates, trims, and deduplicates explicit recovery targets", () => {
    expect(parseBackfillTargets(JSON.stringify([
      { id: " 123 ", folder: "paper_trail" },
      { id: "123", folder: "paper_trail" },
      { id: "abc-def", folder: "imbox" }
    ]))).toEqual([
      { id: "123", folder: "paper_trail" },
      { id: "abc-def", folder: "imbox" }
    ]);
  });

  it.each([
    ["not-json", "valid JSON"],
    ["[]", "1-500 targets"],
    [JSON.stringify([{ id: "123", folder: "trash" }]), "folder must be"],
    [JSON.stringify([{ id: "bad\nheader", folder: "feed" }]), "safe 1-200 character id"]
  ])("rejects invalid targets", (value, message) => {
    expect(() => parseBackfillTargets(value)).toThrow(message);
  });
});
