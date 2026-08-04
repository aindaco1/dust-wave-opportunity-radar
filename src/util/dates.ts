export interface LocalBatchSlot {
  key: string;
  hour: number;
  dateLabel: string;
}

export function localBatchSlot(date: Date, timezone: string): LocalBatchSlot {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const dateLabel = `${values.year}-${values.month}-${values.day}`;
  const hour = Number(values.hour);
  return { key: `${dateLabel}-${String(hour).padStart(2, "0")}`, hour, dateLabel };
}

export function shouldStartBatch(date: Date, timezone: string, batchHours: ReadonlySet<number>): boolean {
  return batchHours.has(localBatchSlot(date, timezone).hour);
}

export function subtractDays(date: Date, days: number): Date {
  return new Date(date.getTime() - days * 86_400_000);
}

export function subtractHours(date: Date, hours: number): Date {
  return new Date(date.getTime() - hours * 3_600_000);
}

export function parseDate(value: string | undefined | null, fallback: Date): Date {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? fallback : parsed;
}
