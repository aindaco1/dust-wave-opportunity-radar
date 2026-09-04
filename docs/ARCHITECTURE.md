# Architecture

## Context

Dust Wave Opportunity Radar converts two private mail sources and public Creative West and optional Colossal feeds into one controlled creative-opportunity workflow. Cloudflare hosts every persistent and scheduled component. GitHub provides CI and explicitly dispatched operational workflows; it is not in the steady-state message path.

## Components

| Component | Responsibility | Persistent content |
|---|---|---|
| Worker HTTP/email/scheduled handlers | Receive forwarded HEY MIME, expose admin routes, and translate hourly ticks into local batch slots | None |
| Cloudflare Workflow | Orchestrate retries and named durable steps for each 12-hour batch | Workflow execution metadata |
| Creative West GraphQL API | Return open New Mexico artist/organization listings in the batch's 31-day deadline window | Source system owns listings |
| Colossal category RSS/HTML (disabled by default) | Discover monthly roundups and extract individual candidates | Source owns articles; D1 retains progress metadata |
| D1 | Queue state, source/snapshot dedupe, classifications, Notion identity mapping, digest state, checkpoints, and run history | Structured metadata; no attachment binaries |
| R2 | Raw RFC 822 MIME (including synthetic MIME for public listings) and parsed JSON needed for processing/retry | Source and attachment-derived content for 24 hours |
| Workers AI | Produce a strict opportunity classification, then a smaller recovery result if needed | Provider-governed inference telemetry |
| Zoho Mail API | Read the configured folders and original MIME | Source system owns mail |
| Notion API | Inspect schema and create/update Opportunities pages | Published opportunity records |
| Email Sending | Deliver one non-empty human-review digest | Delivery metadata |
| GitHub Actions | CI, manual deployment, integration checks, source-only sync, recovery, and HEY historical import | Action logs and configured secrets |

## Batch sequence

```mermaid
sequenceDiagram
  participant Cron as Hourly cron
  participant Worker
  participant Flow as Cloudflare Workflow
  participant Zoho
  participant CW as Creative West
  participant Colossal
  participant D1
  participant R2
  participant AI as Workers AI
  participant Notion
  participant Email as Email Sending

  Cron->>Worker: scheduled tick
  Worker->>Worker: select 07:00/19:00 America/Denver
  Worker->>Flow: create idempotent local-slot instance
  Flow->>D1: create run
  Flow->>Zoho: sync configured folders
  Zoho->>R2: store original/fallback MIME
  Zoho->>D1: upsert message + checkpoint
  Flow->>CW: query fixed filters + run date through +31 days
  CW-->>Flow: return bounded listing page
  Flow->>R2: store each new/changed listing as bounded synthetic MIME
  Flow->>D1: upsert versioned listing snapshot
  opt Colossal enabled
    Flow->>Colossal: current/previous roundup month and early next month
    Flow->>R2: store new/changed entry MIME
    Flow->>D1: persist snapshots and article progress
  end
  Flow->>D1: list and claim retryable messages
  Note over Flow,AI: Prepare MIME and classify in bounded groups of up to four
  Flow->>R2: load MIME, store parsed JSON
  Flow->>AI: strict JSON-schema classification
  alt primary result invalid
    Flow->>AI: smaller recovery JSON classification
  end
  alt qualifying call
    Note over Flow,Notion: Serialize Notion reconciliation after parallel preparation
    Flow->>Notion: query equivalent pages before write
    Flow->>Notion: create or safely update canonical page
    Flow->>D1: save page identity and managed Markdown
  else useful or uncertain
    Flow->>D1: upsert digest item
  else irrelevant
    Flow->>D1: mark ignored
  end
  Flow->>D1: list unsent digest items
  opt digest is non-empty
    Flow->>Email: send HTML + text digest
    Flow->>D1: mark exact items sent
  end
  Flow->>R2: purge expired objects
  Flow->>D1: complete run counts
```

## Idempotency and recovery

- A source item is unique on `(source, external_id)`. Re-import updates metadata without resetting a successful terminal state.
- Creative West snapshot IDs include a digest of the returned listing fields. An unchanged listing is skipped; a substantive update is queued as a new snapshot and later resolves to the same Notion entity by official URL.
- Colossal reuses public snapshot persistence, with HTTP validators and resumable article metadata in D1. Pending work and expired queued/failed payload restoration survive month rollover and HTTP 304. See [Colossal](COLOSSAL.md).
- Workflow instance IDs use the local date/hour slot, so duplicate cron delivery does not create duplicate scheduled batches.
- A D1 run ID is inserted with `INSERT OR IGNORE`; non-forced duplicate runs return a no-op summary.
- A message claim increments `attempts`. Failed work and processing claims stale for 15 minutes are eligible until four attempts.
- Zoho checkpoints overlap by one hour to tolerate ordering and boundary delays; the source/external unique key removes repeats.
- Notion is queried before every create. URL variants, exact/fuzzy title evidence, title years, automation keys, and D1 ownership are used conservatively.
- Digest items are keyed by message ID and marked sent only after the email binding succeeds.
- Durable Workflow step outputs contain only opaque message IDs, statuses, counts, and booleans. Complete message records and classifications are reloaded from D1 inside each step rather than copied into Workflow execution metadata.

## Failure isolation

Each message is processed independently inside the batch. MIME preparation, enrichment, and AI classification run as separately durable steps with a maximum concurrency of four, which stays below the Workers runtime's connection ceiling and far below the Workers AI text-generation rate limit. Notion reconciliation remains serialized after preparation so two equivalent calls cannot race through find-before-create. Parsing/classification failures become a failed message or a human-review recovery item; they do not prevent other messages from completing. Retryable Notion failures become `pending_notion` so the structured result can retry without reparsing expired raw MIME. Managed-body conflicts become `notion_review`, stop retrying, and require a guarded ownership decision. A failure outside per-message work marks the run failed and lets the Workflow retry according to its step policy.

## Code map

- Entrypoints and admin routing: `src/index.ts`
- Durable orchestration: `src/workflow/batch.ts`
- Ingestion: `src/ingest/email-worker.ts`, `src/ingest/zoho.ts`, `src/ingest/creative-west.ts`, `src/ingest/colossal.ts`
- Shared public-source persistence and bounded transport: `src/ingest/public-snapshot.ts`, `src/ingest/public-fetch.ts`
- Parsing and web evidence: `src/email/parse.ts`, `src/ingest/web-enrichment.ts`
- AI and deterministic policy: `src/ai/classify.ts`
- Notion reconciliation: `src/notion/client.ts`
- State persistence: `src/storage/database.ts`
- Digest: `src/email/digest.ts`

See [Data model](DATA-MODEL.md), [Notion integration](NOTION.md), and [Security](SECURITY.md) for deeper boundary details.
