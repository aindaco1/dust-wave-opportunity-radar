import type { RuntimeConfig } from "../config";
import { inspectRoundupConnection, syncRoundups, type RoundupSource } from "./roundup-source";
import {
  COLOSSAL_ARCHIVE, COLOSSAL_FEED, colossalArticleUrl, parseColossalArchive, parseColossalEntries, parseColossalFeed
} from "./colossal-parser";
export type { RoundupSyncResult as ColossalSyncResult } from "./roundup-source";

const source: RoundupSource = {
  id: "colossal", label: "Colossal", senderEmail: "opportunities@thisiscolossal.com",
  feedUrl: COLOSSAL_FEED, archiveUrl: COLOSSAL_ARCHIVE, articleUrl: colossalArticleUrl,
  parseFeed: parseColossalFeed, parseArchive: parseColossalArchive, parseEntries: parseColossalEntries,
  normalizeText: (text) => text.replace(/\bFeatured\b/g, "")
};
export const inspectColossalConnection = (config: RuntimeConfig, runAt: Date) =>
  inspectRoundupConnection(source, config.colossalEnabled, config, runAt);
export const syncColossal = (env: Env, config: RuntimeConfig, runAt: Date) =>
  syncRoundups(source, config.colossalEnabled, env, config, runAt);
