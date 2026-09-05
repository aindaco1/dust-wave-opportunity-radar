export function buildMime(input: {
  id: string; subject: string; fromName: string; fromEmail: string; to: string; date: Date; body: string;
  attachments: { filename: string; mime: string; bytes: Buffer }[];
}): Buffer;
