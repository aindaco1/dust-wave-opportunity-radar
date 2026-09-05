export interface HeyAttachmentFidelity {
  complete: boolean;
  evidenceCount: number;
  listedCount: number;
  missingEvidenceCount: number;
  unsafeEvidenceCount: number;
  malformedMetadataCount: number;
  inspectionLimitExceeded: boolean;
  reasons: string[];
}

export function extractHeySearchTopicIds(response: unknown): string[];
export function extractHeyAttachmentList(response: unknown): unknown[];
export function inspectHeyAttachmentFidelity(input: {
  html: string;
  attachments: unknown[];
}): HeyAttachmentFidelity;
