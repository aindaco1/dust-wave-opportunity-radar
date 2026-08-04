import { describe, expect, it } from "vitest";
import { localBatchSlot, shouldStartBatch } from "../src/util/dates";

describe("Mountain-time scheduling", () => {
  const hours = new Set([7, 19]);

  it("runs at 7 AM MDT", () => {
    const date = new Date("2026-08-04T13:00:00Z");
    expect(localBatchSlot(date, "America/Denver")).toMatchObject({ hour: 7, key: "2026-08-04-07" });
    expect(shouldStartBatch(date, "America/Denver", hours)).toBe(true);
  });

  it("runs at 7 AM MST without changing the cron", () => {
    const date = new Date("2026-12-04T14:00:00Z");
    expect(localBatchSlot(date, "America/Denver")).toMatchObject({ hour: 7, key: "2026-12-04-07" });
    expect(shouldStartBatch(date, "America/Denver", hours)).toBe(true);
  });

  it("skips other hourly ticks", () => {
    expect(shouldStartBatch(new Date("2026-08-04T14:00:00Z"), "America/Denver", hours)).toBe(false);
  });
});
