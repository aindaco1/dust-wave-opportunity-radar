export function logInfo(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "info", event, ...fields }));
}

export function logError(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  console.error(
    JSON.stringify({
      level: "error",
      event,
      error: error instanceof Error ? error.message : String(error),
      ...fields
    })
  );
}
