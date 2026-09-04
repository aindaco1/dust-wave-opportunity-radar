import type { RuntimeConfig } from "../config";
import { inspectRoundupConnection, syncRoundups, type RoundupSource } from "./roundup-source";
import {
  HYPERALLERGIC_ARCHIVE, HYPERALLERGIC_FEED, hyperallergicArticleUrl,
  parseHyperallergicArchive, parseHyperallergicEntries, parseHyperallergicFeed
} from "./hyperallergic-parser";

const source: RoundupSource = {
  id: "hyperallergic", label: "Hyperallergic", senderEmail: "opportunities@hyperallergic.com",
  feedUrl: HYPERALLERGIC_FEED, archiveUrl: HYPERALLERGIC_ARCHIVE, articleUrl: hyperallergicArticleUrl,
  parseFeed: parseHyperallergicFeed, parseArchive: parseHyperallergicArchive, parseEntries: parseHyperallergicEntries
};
export const inspectHyperallergicConnection = (config: RuntimeConfig, runAt: Date) =>
  inspectRoundupConnection(source, config.hyperallergicEnabled, config, runAt);
export const syncHyperallergic = (env: Env, config: RuntimeConfig, runAt: Date) =>
  syncRoundups(source, config.hyperallergicEnabled, env, config, runAt);
