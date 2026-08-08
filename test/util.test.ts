import { describe, expect, it } from "vitest";
import { sha256Hex, timingSafeEqualText } from "../src/util/crypto";
import { parseDate, subtractDays, subtractHours } from "../src/util/dates";
import { readBoundedBytes, readBoundedJson, readBoundedText } from "../src/util/http";

describe("cryptographic utilities", () => {
  it("returns the known SHA-256 digest", async () => {
    await expect(sha256Hex("abc")).resolves.toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("compares tokens without exposing the expected value", async () => {
    await expect(timingSafeEqualText("same", "same")).resolves.toBe(true);
    await expect(timingSafeEqualText("wrong", "same")).resolves.toBe(false);
    await expect(timingSafeEqualText("", "same")).resolves.toBe(false);
  });
});

describe("date utilities", () => {
  it("subtracts exact UTC durations", () => {
    const date = new Date("2026-08-05T12:00:00.000Z");
    expect(subtractDays(date, 7).toISOString()).toBe("2026-07-29T12:00:00.000Z");
    expect(subtractHours(date, 24).toISOString()).toBe("2026-08-04T12:00:00.000Z");
  });

  it("uses the fallback for empty and invalid dates", () => {
    const fallback = new Date("2026-01-01T00:00:00.000Z");
    expect(parseDate(undefined, fallback)).toBe(fallback);
    expect(parseDate("not-a-date", fallback)).toBe(fallback);
    expect(parseDate("2026-08-05", fallback).toISOString()).toBe("2026-08-05T00:00:00.000Z");
  });
});

describe("bounded HTTP readers", () => {
  it("reads bytes, text, and JSON within the cap", async () => {
    await expect(readBoundedBytes(new Response("abc"), 3)).resolves.toEqual(new TextEncoder().encode("abc"));
    await expect(readBoundedText(new Response("Dust Wave"), 32)).resolves.toBe("Dust Wave");
    await expect(readBoundedJson<{ ok: boolean }>(new Response('{"ok":true}'), 32)).resolves.toEqual({ ok: true });
  });

  it("rejects a declared response that is too large before reading it", async () => {
    const response = new Response("oversized", { headers: { "content-length": "100" } });
    await expect(readBoundedBytes(response, 10)).rejects.toThrow("declared 100 bytes");
  });

  it("rejects a streamed response that crosses the cap", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("1234"));
        controller.enqueue(new TextEncoder().encode("5678"));
        controller.close();
      }
    });
    await expect(readBoundedBytes(new Response(stream), 7)).rejects.toThrow("exceeded 7 byte cap");
  });

  it("returns empty bytes when no body exists and rejects malformed JSON", async () => {
    await expect(readBoundedBytes({ headers: new Headers(), body: null }, 10)).resolves.toEqual(new Uint8Array());
    await expect(readBoundedJson(new Response("not-json"), 32)).rejects.toThrow();
  });
});
