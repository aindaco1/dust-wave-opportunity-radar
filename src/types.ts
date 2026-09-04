import { z } from "zod";

export const sourceSchema = z.enum(["hey", "zoho", "creative_west", "colossal"]);
export type MessageSource = z.infer<typeof sourceSchema>;

export const messageStatusSchema = z.enum([
  "queued",
  "processing",
  "pending_notion",
  "notion_review",
  "notion",
  "digest",
  "ignored",
  "failed"
]);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

export const discoveryContextSchema = z.object({
  sourceUrl: z.string().url(),
  officialUrls: z.array(z.string().url()).max(30),
  ambiguousUrls: z.array(z.string().url()).max(30),
  requiresReview: z.boolean()
});
export type DiscoveryContext = z.infer<typeof discoveryContextSchema>;

export interface MessageRecord {
  id: string;
  source: MessageSource;
  external_id: string;
  mailbox: string;
  subject: string;
  sender_name: string | null;
  sender_email: string | null;
  received_at: string;
  raw_r2_key: string;
  parsed_r2_key: string | null;
  raw_size: number;
  status: MessageStatus;
  classification_json: string | null;
  discovery_context_json?: string | null;
  canonical_url: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ParsedAttachment {
  filename: string;
  mimeType: string;
  size: number;
  text?: string;
  warning?: string;
}

export interface ParsedMessage {
  asOfDate?: string;
  discoveryContext?: DiscoveryContext;
  source: MessageSource;
  mailbox: string;
  externalId: string;
  messageId?: string;
  subject: string;
  senderName?: string;
  senderEmail?: string;
  receivedAt: string;
  text: string;
  html?: string;
  urls: string[];
  attachments: ParsedAttachment[];
  warnings: string[];
}

export const opportunityTypeSchema = z.enum([
  "Grant",
  "Venture Fund",
  "Angel",
  "Tax Incentive",
  "Fellowship",
  "Residency",
  "Exhibition",
  "Competition",
  "Screening",
  "Award",
  "Festival",
  "Lab",
  "Completion Funds",
  "Incubator",
  "Mentoring",
  "RFP",
  "Partnership",
  "Scholarship",
  "Call",
  "Training",
  "Magazine",
  "Pitch",
  "Conference"
]);

export const digestCategorySchema = z.enum([
  "Possible Opportunities",
  "Jobs & Commissions",
  "Workshops & Training",
  "Events & Conferences",
  "Games & Interactive",
  "Industry News",
  "Other Useful Finds"
]);

export const classificationSchema = z.object({
  decision: z.enum(["notion", "digest", "ignore"]),
  confidence: z.number().min(0).max(1),
  title: z.string().min(1).max(240),
  organization: z.string().max(240).nullable(),
  summary: z.string().min(1).max(900),
  bodyMarkdown: z.string().max(12_000),
  primaryUrl: z.string().url().nullable(),
  applicationUrl: z.string().url().nullable(),
  dueDate: z.string().date().nullable(),
  applicationOpenStart: z.string().date().nullable(),
  applicationOpenEnd: z.string().date().nullable(),
  type: opportunityTypeSchema.nullable(),
  tags: z.array(z.string().min(1).max(80)).max(20),
  digestCategory: digestCategorySchema.nullable(),
  eligibleStates: z.array(z.enum(["New Mexico", "Illinois", "Pennsylvania"])),
  explicitlyExcludedStates: z.array(z.enum(["New Mexico", "Illinois", "Pennsylvania"])),
  evidence: z.array(z.string().min(1).max(400)).max(8),
  rationale: z.string().min(1).max(800)
});
export type Classification = z.infer<typeof classificationSchema>;

export interface BatchParams {
  scheduledFor: string;
  trigger: "cron" | "manual";
  force?: boolean;
}

export interface ProcessResult {
  messageId: string;
  status: MessageStatus;
}

export interface BatchSummary {
  runId: string;
  queued: number;
  notion: number;
  pendingNotion: number;
  notionReview: number;
  digest: number;
  ignored: number;
  failed: number;
  digestSent: boolean;
}
