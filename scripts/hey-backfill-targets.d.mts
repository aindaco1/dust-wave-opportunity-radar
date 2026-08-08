export interface HeyBackfillTarget {
  id: string;
  folder: "imbox" | "feed" | "paper_trail";
}

export function parseBackfillTargets(value: string | undefined): HeyBackfillTarget[];
