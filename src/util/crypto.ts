import { sha256BytesHex, sha256Hex as hashText } from "@dustwave/worker-core/crypto";
export { timingSafeEqualText } from "@dustwave/worker-core/crypto";

// Preserve this consumer's string-or-binary contract; Platform's text hash coerces to string.
export function sha256Hex(value: string | ArrayBuffer): Promise<string> {
  return typeof value === "string" ? hashText(value) : sha256BytesHex(value);
}
