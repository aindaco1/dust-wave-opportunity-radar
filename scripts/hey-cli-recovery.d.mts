import type { ImportedHeyEmail } from "../src/ingest/email-worker";
import type { MessageRecord } from "../src/types";
export const RECOVERY_CLI_VERSION: string;
export class RecoveryError extends Error {}
export function validateMessageId(value: unknown): string;
export type RecoveryRecord = MessageRecord & { identity_count: number };
export interface RecoveryAttachment { id: string; message_id: number | string; filename: string; content_type?: string; byte_size: number }
export interface RecoveryPorts {
  readRecord(id: string): Promise<RecoveryRecord | null>;
  heyJson(args: string[]): Promise<unknown>;
  getMessage(id: string): Promise<unknown>;
  download(attachment: RecoveryAttachment): Promise<Buffer>;
  postImport(payload: ImportedHeyEmail): Promise<{ accepted: boolean; id: string }>;
}
export interface RecoverySummary {
  ok: boolean; decision: "preview" | "recovered" | "already_queued"; imported: number;
  identityCount?: number; selectedEntries?: number; excludedNewerEntries?: number;
  attachments?: number; attachmentBytes?: number; rawBytes?: number;
}
export function recoverHeyRecord(input: { messageId: string; mode: "preview" | "import"; ports: RecoveryPorts }): Promise<RecoverySummary>;
