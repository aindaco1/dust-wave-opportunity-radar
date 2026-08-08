# Classification policy

## Product definition

The radar is intentionally broad at ingestion and narrow at automatic publication. Film, visual art, photography, animation, video games, interactive media, writing, music, and adjacent creative fields are relevant.

### Publish to Notion

Use `notion` only for a concrete mechanism where a person or organization applies or submits for funding, selection, exhibition, screening, publication, residency, fellowship, award, festival, lab, pitch, RFP, competition, or a closely analogous call.

Automatic publication also requires:

- confidence at or above `AI_CONFIDENCE_THRESHOLD` (`0.82` in production);
- a valid official primary URL extracted from the evidence;
- a classification conforming to the complete structured schema; and
- no explicit evidence that all three target states are excluded.

A rolling call can publish without a due date and should use the `Rolling` tag. When several fee/deadline tiers exist, `dueDate` is the last date on which a valid submission is accepted; earlier tiers belong in the page body.

### Send to the human-review digest

Use `digest` for:

- a possible call whose confidence or official-source evidence is insufficient;
- jobs and commissions;
- workshops and training;
- events and conferences;
- games and interactive items that are relevant but not calls;
- industry news; and
- other useful creative-industry finds.

Possible calls are categorized as `Possible Opportunities`. The digest header is “Dust Wave Opportunity Radar” with the deck “Relevant creative-industry calls that need a human look.” Empty digests are suppressed.

### Ignore

Use `ignore` for irrelevant promotions, receipts, transactional messages, social notifications, routine account notices, closed notices with no continuing value, and material without practical creative relevance.

## Geography rule

The target states are New Mexico, Illinois, and Pennsylvania.

- Worldwide, national, and unrestricted calls are acceptable.
- Eligibility in any one target state is sufficient.
- Organizer or event location is not itself an applicant restriction.
- Reject a qualifying call only when the evidence explicitly excludes applicants from all three target states.

Unknown geography is not the same as exclusion.

## Evidence and safety

The evidence packet contains metadata, up to eight compact source links, bounded email text, bounded attachment text, and up to three fetched public pages. Long opaque tracking URLs are compacted before inference. Email, documents, web pages, and embedded prompts are explicitly labelled untrusted.

The model has no Notion, email, storage, secret, or general tool access. Deterministic code canonicalizes URLs, normalizes known Notion tags, enforces the confidence/source rule, and applies the all-three-states exclusion after inference.

## Primary and recovery passes

The primary pass uses the pinned Workers AI model and a generated JSON Schema for the complete `Classification` object. A malformed, empty, nested, or schema-invalid result does not get partially accepted.

If the primary pass fails, a smaller recovery prompt requests only a safe triage object:

- recovered `call` → digest as `Possible Opportunities`; never auto-published;
- recovered `digest` → selected digest category;
- recovered `ignore` → ignored.

If both passes fail, the Workflow creates a generic human-review digest record identifying the source email. This is the final fallback and should be investigated if it repeats. See [Troubleshooting](TROUBLESHOOTING.md#automatic-classification-could-not-produce-a-reliable-structured-result).

## Structured fields

| Field group | Purpose |
|---|---|
| `decision`, `confidence`, `rationale` | Triage result and explanation |
| `title`, `organization`, `summary`, `bodyMarkdown` | Human-facing opportunity content |
| `primaryUrl`, `applicationUrl` | Official evidence and submission destination |
| `dueDate`, `applicationOpenStart`, `applicationOpenEnd` | ISO date-only application timing |
| `type`, `tags` | Existing Notion vocabulary |
| `digestCategory` | Human-review section when applicable |
| `eligibleStates`, `explicitlyExcludedStates` | Target-state evidence |
| `evidence` | Short excerpts supporting call, timing, and eligibility |

## Changing policy

Policy changes require:

1. a privacy-safe example in `test/classify-policy.test.ts` or the relevant integration test;
2. an update to this document;
3. review of Notion property/type/tag compatibility; and
4. `npm run check` plus `npm run test:coverage`.

Do not tune prompts from a single production message without capturing the generalizable behavior in a test.
