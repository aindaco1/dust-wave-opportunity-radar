interface BoundedBody {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

export async function readBoundedBytes(response: BoundedBody, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Response declared ${declared} bytes; cap is ${maxBytes}`);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`Response exceeded ${maxBytes} byte cap`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

export async function readBoundedText(response: BoundedBody, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBoundedBytes(response, maxBytes));
}

export async function readBoundedJson<T>(response: BoundedBody, maxBytes: number): Promise<T> {
  return JSON.parse(await readBoundedText(response, maxBytes)) as T;
}
