# RAG Audit

**Find stale, orphaned, missing, and misconfigured chunks in an existing RAG index.**

[![npm](https://img.shields.io/npm/v/rag-audit)](https://www.npmjs.com/package/rag-audit)
[![CI](https://github.com/Ritesh17rb/rag-audit/actions/workflows/ci.yml/badge.svg)](https://github.com/Ritesh17rb/rag-audit/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Your source document changed. Your vector index might not have. RAG Audit compares a source manifest with indexed metadata to find obsolete revisions, retained deletions, missing documents, duplicate chunks, and embedding-model mismatches.

Use it with JSON exports or an existing Qdrant collection. It does not require changing your ingestion framework, calling an LLM, or sending data to a hosted audit service.

## Try the broken-sync demo

```sh
npx rag-audit demo
```

The bundled example models a company updating a refund policy, retiring an old policy, and failing to ingest onboarding material. The index also has a missing tenant label and an outdated embedding-model label. The report identifies these faults with record/document evidence and repair suggestions.

The demo intentionally exits `1` because it contains findings. To inspect it without failing your shell pipeline:

```sh
npx rag-audit demo --fail-on never
npx rag-audit demo --format html --out audit.html --fail-on never
```

HTML reports are standalone, escaped, and have no scripts or external resources. Report files are created exclusively: existing files are never overwritten.

## Install

```sh
npm install rag-audit
npx rag-audit --help
```

Node.js 20.3 or later. Zero runtime package dependencies. The library supports ESM/CommonJS and includes TypeScript declarations.

## Define the source contract

`manifest.json` is your inventory of source documents and the revisions that should be indexed:

```json
{
  "formatVersion": 1,
  "completeness": "complete",
  "embeddingModel": "your-embedding-model-v2",
  "documents": [
    {
      "id": "refund-policy",
      "sourceVersion": "3",
      "expectedChunkIds": ["refund:0", "refund:1"]
    },
    { "id": "retired-policy", "status": "deleted" }
  ]
}
```

`completeness: "complete"` means the inventory is authoritative **for its declared scope**. Mark samples and incremental change lists `partial`. Tombstones explicitly identify deleted sources even when the rest of the source inventory is partial.

Source versions, hashes, model names, document IDs, tenant IDs, and logical chunk IDs use nonempty strings. RAG Audit does not coerce versions or infer identity. For each source, set `sourceVersion`, `contentHash`, or both to enable freshness checks. A content hash is a consistently computed **source-document hash**, not a per-chunk text hash.

## Audit a JSON index export

`index.json`:

```json
{
  "formatVersion": 1,
  "completeness": "complete",
  "records": [
    {
      "id": "point-1",
      "documentId": "refund-policy",
      "chunkId": "refund:0",
      "sourceVersion": "2",
      "embeddingModel": "your-embedding-model-v1"
    }
  ]
}
```

```sh
npx rag-audit audit manifest.json index.json
npx rag-audit audit manifest.json index.json --format json
npx rag-audit audit manifest.json index.json --format html --out audit.html
```

This export reveals an old source revision, an embedding mismatch, and a missing expected chunk.

The snapshot records represent physical index rows. Their `id` must be a nonempty string or nonnegative safe integer. `chunkId` is the stable logical chunk identity; if omitted, the string form of the physical ID is used. Export integer IDs beyond JavaScript's safe range as strings.

For another metadata layout, supply RFC 6901 JSON Pointers:

```json
{
  "documentId": "/metadata/source_id",
  "sourceVersion": "/metadata/revision",
  "tenantId": "/metadata/tenant"
}
```

```sh
npx rag-audit audit manifest.json index.json --mapping mapping.json
```

The physical `id` is always read from the top-level record. Unmapped fields keep their default top-level names. Unknown payload data, including chunk text, is discarded during normalization.

## Audit Qdrant directly

The adapter uses only Qdrant's read-only `POST /collections/{name}/points/scroll` operation. It disables vectors, selects configured metadata fields, and follows `next_page_offset` to exhaustion.

```sh
npx rag-audit qdrant manifest.json --url https://YOUR-QDRANT-HOST --collection knowledge
```

For authentication, set `QDRANT_API_KEY` in your shell or CI secret environment. Alternatively, `--api-key-env YOUR_ENV_NAME` selects another environment variable. A read-only Qdrant credential is sufficient. Do not put credentials in URLs or commit them to files. Remote API keys require HTTPS; HTTP with a key is permitted only on literal loopback hostnames.

By default, source metadata comes from `/payload/documentId`, `/payload/sourceVersion`, `/payload/tenantId`, `/payload/contentHash`, `/payload/embeddingModel`, and `/payload/chunkId` on the returned point. Configure nested payload layouts with `--mapping examples/qdrant-mapping.json` from this repository. Qdrant mappings require `/payload/` paths with simple object keys; generic exports support escaped JSON Pointer keys.

Limits: 256 records/page, 100,000 points, 10,000 pages, 15-second timeout/request, and 10 MB/response by default. CLI flags configure page size, point/page caps, and timeout. The library also exposes response-size limits and cancellation. Reaching a scan cap produces **partial** coverage. Failed requests, malformed responses, repeated cursors, redirects, and unsafe numeric IDs produce errors, not successful reports.

## Tenant scope and completeness

For a tenant-specific audit, put the same scope in both JSON inputs and explicitly label every source document:

```json
{ "scope": { "tenantId": "acme" } }
```

This is an additional property on the full manifest/snapshot objects above, not a complete input by itself. For Qdrant, the manifest scope automatically becomes a tenant filter, and the adapter declares the matching snapshot scope. Identity is `(tenantId, documentId)`; identical document IDs in different tenants remain distinct. A tenant-aware source manifest must label every source document.

A filtered live scan cannot see rows that lack the tenant field or belong to other tenants. Run an unfiltered audit with an authoritative multi-tenant manifest to inspect those rows. The tool checks metadata consistency; it does not verify retrieval-time authorization or prove tenant isolation.

| Input condition | Behavior |
|---|---|
| Complete source inventory; unknown source ID | Orphaned-chunk finding |
| Partial source inventory; unknown source ID | Unverifiable source; never infer deletion |
| Explicit deleted-source tombstone; retained chunk | Retained-deletion finding |
| Complete index scan | Enable missing-document, missing-ID, and count checks |
| Partial index scan | Suppress absence/count checks and mark coverage incomplete |
| Mismatched source/index scopes | Input error; no misleading comparison |

A live scroll is an exhausted enumeration, **not an atomic database snapshot**. Pause ingestion or audit an immutable export when absence guarantees matter.

## Library

```ts
import { audit, parseManifest, parseSnapshot, readQdrantSnapshot, toHtml } from 'rag-audit';
import { readFile, writeFile } from 'node:fs/promises';

const manifest = parseManifest(JSON.parse(await readFile('manifest.json', 'utf8')));
const index = await readQdrantSnapshot({
  url: 'https://YOUR-QDRANT-HOST',
  collection: 'knowledge',
  apiKey: process.env.QDRANT_API_KEY,
  tenantId: manifest.scope?.tenantId,
});

const report = audit(manifest, index);
console.log(report.status, report.summary.byCode);
await writeFile('audit.html', toHtml(report), { flag: 'wx' });

// Offline exports use the same engine:
const exported = parseSnapshot(JSON.parse(await readFile('index.json', 'utf8')));
const offline = audit(manifest, exported, { maxFindings: 1000 });
```

Reports contain normalized record paths, source-document paths, IDs, counts, coverage, and caveats. They omit raw chunk payloads and credentials. IDs themselves can be sensitive: handle reports according to your data policies. Neither versions/hashes nor embedding-model labels are independently recomputed or verified.

## Findings

| Category | Examples |
|---|---|
| Source lifecycle | `ORPHANED_CHUNK`, `DELETED_SOURCE_RETAINED`, `MISSING_DOCUMENT` |
| Freshness | `STALE_VERSION`, `STALE_CONTENT_HASH`, `FRESHNESS_NOT_VERIFIABLE` |
| Chunk inventory | `MISSING_CHUNK`, `UNEXPECTED_CHUNK`, `DUPLICATE_CHUNK`, `CHUNK_COUNT_MISMATCH` |
| Metadata | `MISSING_METADATA`, `INVALID_METADATA`, `DUPLICATE_RECORD`, `TENANT_SCOPE_MISMATCH` |
| Embeddings | `EMBEDDING_MODEL_MISMATCH`, `MIXED_EMBEDDING_MODELS` |
| Coverage | `SOURCE_INVENTORY_PARTIAL`, `INDEX_SCAN_PARTIAL`, `SOURCE_NOT_VERIFIABLE` |

Mixed embedding labels produce a warning: named-vector or other intentionally mixed arrangements may be legitimate. A per-document `embeddingModel` overrides the manifest default. Physical duplicate rows are reported and excluded from subsequent counts; different physical rows with the same logical chunk ID remain visible as duplicates.

## CI and reports

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with:
    node-version: 22
- run: npx --yes rag-audit@0.1.0 audit manifest.json index.json --format markdown --out audit.md
```

Reports support text, JSON, Markdown, standalone HTML, and SARIF. SARIF uses file and logical JSON Pointer locations; line numbers are not fabricated. Qdrant findings refer to a normalized metadata snapshot, not source line numbers in the database.

| Exit | Meaning |
|---|---|
| `0` | Passed the selected finding threshold |
| `1` | Findings reached threshold, or audit is inconclusive |
| `2` | Input, file, configuration, or network error |

`--fail-on warning` is the default. `--fail-on error` permits review warnings but still fails inconclusive audits. `--fail-on never` produces an informational report. Finding thresholds never suppress diagnostics.

`--max-findings` caps detailed output at 10,000 by default; total error/warning counts still include every finding, and the report states how much detail was omitted. CLI input files/stdin are limited to 20 MB each. The library accepts up to 1,000,000 source documents and records per audit and operates in memory.

`clean` means no findings in implemented metadata checks. It does not certify answer quality, source truth, source-inventory completeness, vector provenance, cache deletion, or access-control enforcement.

## Evidence and development

OWASP recommends auditing orphaned RAG chunks and propagating source deletion through derived indexes: [RAG Security Cheat Sheet](https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/RAG_Security_Cheat_Sheet.md). The adapter follows the official [Qdrant scroll API](https://api.qdrant.tech/api-reference/points/scroll-points). These references motivate the checks; they do not establish product adoption or detection accuracy on an external dataset.

```sh
npm ci
npm run check
npm run demo -- --fail-on never
npm pack
```

Tests cover inventory semantics, partial scans, tenant identities, drift, mappings, duplicate rows, reports, CLI exit codes, and HTTP failures. CI additionally runs a real Qdrant service test; local runs skip that test unless `QDRANT_TEST_URL` is set to an isolated test instance. The integration test creates and deletes only its own uniquely named collection.

See [format reference](docs/FORMATS.md), [roadmap](docs/ROADMAP.md), and [release process](docs/RELEASING.md). Contributions should include minimal redacted fixtures, expected findings, and adapter/API version information. Never include credentials or customer text in issues.
