import { getMessage, upsertMessage, type NewMessage } from "../storage/database";
import { sha256Hex } from "../util/crypto";

interface PublicSnapshot extends Omit<NewMessage, "id" | "rawR2Key" | "rawSize"> {
  namespace: string;
  mime: () => string;
  customMetadata?: Record<string, string>;
}

/** Share persistence, while each source owns its identity and MIME representation. */
export async function ingestPublicSnapshot(
  env: Env,
  snapshot: PublicSnapshot
): Promise<{ id: string; ingested: boolean }> {
  const id = await sha256Hex(`${snapshot.source}:${snapshot.externalId}`);
  const existing = await getMessage(env.DB, id);
  if (existing && !(["queued", "failed"].includes(existing.status) && existing.raw_r2_key === "")) {
    return { id, ingested: false };
  }

  const raw = new TextEncoder().encode(snapshot.mime());
  if (raw.byteLength > 1_000_000) throw new Error("public_snapshot_size_limit");
  const rawR2Key = `raw/${snapshot.namespace}/${snapshot.receivedAt.slice(0, 10)}/${id}.eml`;
  await env.MAIL_BUCKET.put(rawR2Key, raw, {
    httpMetadata: { contentType: "message/rfc822" },
    customMetadata: {
      ...snapshot.customMetadata,
      source: snapshot.source,
      externalId: snapshot.externalId,
      receivedAt: snapshot.receivedAt
    }
  });
  try {
    await upsertMessage(env.DB, { ...snapshot, id, rawR2Key, rawSize: raw.byteLength });
  } catch (error) {
    await env.MAIL_BUCKET.delete(rawR2Key).catch(() => undefined);
    throw error;
  }
  return { id, ingested: true };
}
