import worker from "../../src/index";

const testWorker = {
  email: worker.email,

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/__test/migrate") {
      await env.DB.prepare(await request.text()).run();
      return Response.json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/__test/message") {
      const externalId = url.searchParams.get("externalId");
      if (!externalId || externalId.length > 900) return Response.json({ error: "Invalid externalId" }, { status: 400 });
      const row = await env.DB
        .prepare(
          `SELECT source, external_id, mailbox, status, raw_r2_key, raw_size
           FROM messages WHERE source = 'hey' AND external_id = ?`
        )
        .bind(externalId)
        .first<{
          source: string;
          external_id: string;
          mailbox: string;
          status: string;
          raw_r2_key: string;
          raw_size: number;
        }>();
      if (!row) return Response.json({ row: null, object: null, matchingRows: 0 });
      const [object, count] = await Promise.all([
        env.MAIL_BUCKET.head(row.raw_r2_key),
        env.DB
          .prepare("SELECT COUNT(*) AS count FROM messages WHERE source = 'hey' AND external_id = ?")
          .bind(externalId)
          .first<{ count: number }>()
      ]);
      return Response.json({
        row: {
          source: row.source,
          externalId: row.external_id,
          mailbox: row.mailbox,
          status: row.status,
          rawSize: row.raw_size
        },
        object: object ? { size: object.size, contentType: object.httpMetadata?.contentType ?? null } : null,
        matchingRows: count?.count ?? 0
      });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }
} satisfies ExportedHandler<Env>;

export default testWorker;
