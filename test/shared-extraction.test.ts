import { describe, expect, it, vi } from "vitest";
import { sha256Hex, timingSafeEqualText } from "../src/util/crypto";
import { readBoundedBytes, readBoundedJson, readBoundedText } from "../src/util/http";
import { createTestDatabase } from "./support/d1";

describe("HTTP and crypto extraction contract", () => {
  it("preserves binary hashing, Unicode, empty and unequal-length comparisons", async () => {
    const bytes = new TextEncoder().encode("café");
    expect(await sha256Hex(bytes.buffer)).toBe(await sha256Hex("café"));
    expect(await timingSafeEqualText("", "")).toBe(true);
    expect(await timingSafeEqualText("é", "é")).toBe(true);
    expect(await timingSafeEqualText("é", "e")).toBe(false);
    expect(await timingSafeEqualText("a", "aa")).toBe(false);
  });

  it("counts bytes, concatenates chunks, and propagates JSON parse failures", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array([0xc3]));
      controller.enqueue(new Uint8Array([0xa9]));
      controller.close();
    } });
    expect(await readBoundedText(new Response(stream), 2)).toBe("é");
    await expect(readBoundedText(new Response("é"), 1)).rejects.toThrow("Response exceeded 1 byte cap");
    expect(await readBoundedBytes(new Response(null), 0)).toEqual(new Uint8Array());
    expect(await readBoundedJson(new Response("[]"), 2)).toEqual([]);
    await expect(readBoundedJson(new Response("x"), 1)).rejects.toBeInstanceOf(SyntaxError);
  });

  it("cancels declared overflow before reading, including fractional declarations", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    await expect(readBoundedBytes({ headers: new Headers({ "content-length": "2.5" }), body }, 2))
      .rejects.toThrow("Response declared 2.5 bytes; cap is 2");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves cancellation errors before reading but ignores cleanup failures after overflow", async () => {
    const createBody = () => new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2])); },
      cancel() { throw new Error("cancel failure"); }
    });
    await expect(readBoundedBytes({ headers: new Headers({ "content-length": "2" }), body: createBody() }, 1))
      .rejects.toThrow("cancel failure");
    await expect(readBoundedBytes(new Response(createBody()), 1)).rejects.toThrow("Response exceeded 1 byte cap");
    const failure = new Error("read failure");
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(failure); } });
    await expect(readBoundedBytes(new Response(body), 10)).rejects.toBe(failure);
  });
});

describe("SQLite D1 extraction contract", () => {
  it("preserves bind/run/all/first/raw metadata, empty rows, and statement reuse", async () => {
    const database = createTestDatabase({ migrate: false });
    const { db } = database;
    try {
      expect(await db.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")).toEqual({ count: 0, duration: 0 });
      expect(await db.prepare("INSERT INTO sample (name) VALUES (?)").bind("one").run()).toMatchObject({
        success: true, results: [], meta: { changes: 1, last_row_id: 1, rows_written: 1, changed_db: true }
      });
      const query = db.prepare("SELECT id, name FROM sample WHERE id = ?").bind(1);
      expect(await query.raw()).toEqual([[1, "one"]]);
      expect(await query.first()).toEqual({ id: 1, name: "one" });
      expect(await query.first("name")).toBe("one");
      expect(await query.all()).toMatchObject({ results: [{ id: 1, name: "one" }], meta: { rows_read: 1, changes: 0 } });
      expect(await query.bind(99).first()).toBeNull();
      expect(await query.all()).toMatchObject({ results: [], meta: { rows_read: 0 } });
      expect(await db.batch([])).toEqual([]);
      expect(() => db.withSession()).toThrow("not implemented");
      expect(() => db.dump()).toThrow("not implemented");
    } finally { database.close(); }
    expect(() => db.prepare("SELECT 1")).toThrow();
  });

  it("enforces foreign keys and rolls back the entire failed batch", async () => {
    const database = createTestDatabase({ migrate: false });
    const { db } = database;
    try {
      await db.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (parent_id INTEGER REFERENCES parent(id))");
      await expect(db.prepare("INSERT INTO child VALUES (99)").run()).rejects.toThrow();
      await expect(db.batch([
        db.prepare("INSERT INTO parent VALUES (?)").bind(1),
        db.prepare("INSERT INTO child VALUES (?)").bind(99)
      ])).rejects.toThrow();
      expect(await db.prepare("SELECT COUNT(*) AS count FROM parent").first("count")).toBe(0);
      await db.batch([db.prepare("INSERT INTO parent VALUES (1)"), db.prepare("INSERT INTO child VALUES (1)")]);
      expect(await db.prepare("SELECT COUNT(*) AS count FROM child").first("count")).toBe(1);
    } finally { database.close(); }
  });
});
