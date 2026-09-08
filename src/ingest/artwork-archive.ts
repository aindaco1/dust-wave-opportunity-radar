import type { RuntimeConfig } from "../config";
import { listSourceDocuments, rememberSourceDocument, saveSourceDocumentProgress } from "../storage/source-documents";
import { logInfo } from "../util/log";
import { ARTWORK_ARCHIVE_GUIDE, artworkArchiveGuideUrl, parseArtworkArchiveEntries } from "./artwork-archive-parser";
import { DiscoverySafetyError, syncPublicDocument, type PublicDocumentSource, type PublicDocumentSyncCounts } from "./public-document";
import { fetchPublicText } from "./public-fetch";

const source: PublicDocumentSource = {
  id: "artwork_archive", label: "Artwork Archive", senderEmail: "opportunities@artworkarchive.com",
  documentUrl: artworkArchiveGuideUrl, parseEntries: parseArtworkArchiveEntries
};

export async function inspectArtworkArchiveConnection(config: RuntimeConfig) {
  if (!config.artworkArchiveEnabled) return { matchingEntries: 0, skipped: true };
  const response = await fetchPublicText(ARTWORK_ARCHIVE_GUIDE, { contentTypes: ["text/html"] });
  if (response.status === 304 || !artworkArchiveGuideUrl(response.finalUrl)) throw new Error("artwork_archive_unverified_response");
  return { matchingEntries: parseArtworkArchiveEntries(response.text).length, skipped: false };
}

export async function syncArtworkArchive(env: Env, config: RuntimeConfig, runAt: Date): Promise<PublicDocumentSyncCounts & { skipped: boolean }> {
  const result = { extracted: 0, ingested: 0, unchanged: 0, cached: 0, unresolved: 0, failed: 0, deferred: 0, skipped: !config.artworkArchiveEnabled };
  if (!config.artworkArchiveEnabled) return result;
  if (Number.isNaN(runAt.valueOf())) throw new Error("artwork_archive_invalid_run_date");
  // This is an evergreen guide, not a named monthly roundup. Empty month is a stable document scope.
  await rememberSourceDocument(env.DB, source.id, { url: ARTWORK_ARCHIVE_GUIDE, month: "", publishedAt: "" });
  const document = (await listSourceDocuments(env.DB, source.id, [""])).find((doc) => doc.url === ARTWORK_ARCHIVE_GUIDE)!;
  try {
    await syncPublicDocument(source, env, document, undefined, runAt, 200, result);
  } catch (error) {
    // Incomplete collision guards must stop the batch before any candidate can publish.
    if (error instanceof DiscoverySafetyError) throw error;
    result.failed++;
    await saveSourceDocumentProgress(env.DB, document, {
      hash: document.content_hash, nextEntry: document.next_entry, pending: true,
      error: "document_sync_failed", checkedAt: runAt.toISOString()
    });
  }
  logInfo("artwork_archive_sync_completed", { ...result });
  return result;
}
