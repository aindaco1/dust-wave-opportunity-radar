import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, unstable_splitSqlQuery } from "wrangler";

const server = createTestHarness({
  root: process.cwd(),
  workers: [{ configPath: "./test/wrangler.email.jsonc" }]
});

beforeAll(async () => {
  await server.listen();
  const worker = server.getWorker("dust-wave-opportunity-radar-email-test");
  const migrations = (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort();
  for (const migration of migrations) {
    const statements = unstable_splitSqlQuery(await readFile(`migrations/${migration}`, "utf8"));
    for (const statement of statements) {
      const response = await worker.fetch("/__test/migrate", { method: "POST", body: statement });
      expect(response.ok).toBe(true);
    }
  }
}, 30_000);

afterAll(async () => {
  await server.close();
});

describe("Email Worker runtime integration", () => {
  it("streams a real email event into local R2 and D1 idempotently", async () => {
    const worker = server.getWorker("dust-wave-opportunity-radar-email-test");
    const externalId = "<runtime-email-test@example.org>";
    const raw = [
      `Message-ID: ${externalId}`,
      "Date: Fri, 07 Aug 2026 18:00:00 GMT",
      "From: Sender <sender@example.org>",
      "To: hey@ingest.dustwave.xyz",
      "Subject: Runtime integration test",
      "",
      "Synthetic fixture body"
    ].join("\r\n");

    const startedAt = performance.now();
    const first = await worker.email({
      from: "sender@example.org",
      to: "hey@ingest.dustwave.xyz",
      raw
    });
    const elapsedMs = performance.now() - startedAt;
    expect(first.outcome).toBe("ok");
    expect(elapsedMs).toBeLessThan(5_000);

    const stateResponse = await worker.fetch(`/__test/message?externalId=${encodeURIComponent(externalId)}`);
    expect(stateResponse.ok).toBe(true);
    await expect(stateResponse.json()).resolves.toEqual({
      row: {
        source: "hey",
        externalId,
        mailbox: "Forwarded non-spam",
        status: "queued",
        rawSize: new TextEncoder().encode(raw).byteLength
      },
      object: {
        size: new TextEncoder().encode(raw).byteLength,
        contentType: "message/rfc822"
      },
      matchingRows: 1
    });

    const duplicate = await worker.email({
      from: "sender@example.org",
      to: "hey@ingest.dustwave.xyz",
      raw
    });
    expect(duplicate.outcome).toBe("ok");
    const duplicateState = await worker.fetch(`/__test/message?externalId=${encodeURIComponent(externalId)}`);
    await expect(duplicateState.json()).resolves.toMatchObject({ matchingRows: 1 });

    const logs = JSON.stringify(server.getLogs());
    expect(logs).toContain("hey_email_ingested");
    expect(logs).not.toContain("sender@example.org");
    expect(logs).not.toContain("Runtime integration test");
    expect(logs).not.toContain("Synthetic fixture body");
  }, 15_000);
});
