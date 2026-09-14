import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectNotionSchema, trashNotionPage } from '../src/notion/client';
import { env, runtimeConfig } from './support/fixtures';
const token = 'synthetic-notion-token';
const pageId = '11111111-1111-4111-8111-111111111111';
const read = () => inspectNotionSchema(env({ NOTION_TOKEN: token }), { ...runtimeConfig(), notionDataSourceId: 'source' });
const write = () => trashNotionPage(env({ NOTION_TOKEN: token }), pageId);
const successful = () => Response.json({ id: 'source', properties: {} });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Notion transport characterization', () => {
  it('retains method, body, version and token on one successful attempt', async () => {
    const fetcher = vi.fn().mockResolvedValue(successful()); vi.stubGlobal('fetch', fetcher);
    await write(); const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://api.notion.com/v1/pages/${pageId}`);
    expect(init.method).toBe('PATCH'); expect(JSON.parse(init.body)).toEqual({ in_trash: true });
    const headers = new Headers(init.headers); expect(headers.get('Authorization')).toBe(`Bearer ${token}`);
    expect(headers.get('Notion-Version')).toBe('2026-03-11'); expect(headers.get('Content-Type')).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('retains consumer-owned status retry policy and Retry-After delay', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('busy', { status: 429, headers: { 'Retry-After': '2' } })).mockResolvedValueOnce(successful());
    vi.stubGlobal('fetch', fetcher); const request = read();
    await vi.advanceTimersByTimeAsync(1999); expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await request; expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps four status attempts, including the final delay, and caller-specific errors', async () => {
    vi.useFakeTimers(); const fetcher = vi.fn().mockImplementation(() => new Response('{"message":"fixture failure"}', { status: 503 }));
    vi.stubGlobal('fetch', fetcher); const result = read().catch(error => error);
    await vi.advanceTimersByTimeAsync(7499); expect(fetcher).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1); const error = await result; expect(error.message).toBe('Notion GET /data_sources/source failed (503): fixture failure');
  });
  it.each([400, 403])('does not retry terminal HTTP %s', async status => {
    const fetcher = vi.fn().mockResolvedValue(new Response('fixture error', { status })); vi.stubGlobal('fetch', fetcher);
    await expect(read()).rejects.toThrow(`Notion GET /data_sources/source failed (${status}): fixture error`); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not retry network uncertainty on writes', async () => {
    const failure = new TypeError('synthetic network failure'); const fetcher = vi.fn().mockRejectedValue(failure); vi.stubGlobal('fetch', fetcher);
    await expect(write()).rejects.toBe(failure); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not retry malformed JSON or over-limit responses', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{')).mockResolvedValueOnce(new Response('x'.repeat(2_000_001))); vi.stubGlobal('fetch', fetcher);
    await expect(read()).rejects.toBeInstanceOf(SyntaxError); expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(read()).rejects.toThrow(/exceed|limit|large/i); expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
