# Input and report contracts

Format version: 1. All source fields are explicit declarations by the ingestion system or inventory producer. RAG Audit does not scrape your original documents or reconstruct their history.

## Source manifest

Required: `formatVersion: 1`, `completeness: "complete" | "partial"`, and `documents: []`.

Optional top-level fields: `scope: { tenantId: string }` and `embeddingModel: string`.

Each document accepts:

| Field | Contract |
|---|---|
| `id` | Required nonempty string, stable within a tenant |
| `tenantId` | Nonempty string; mandatory on every document in a tenant-aware manifest |
| `status` | `active` (default) or `deleted` |
| `sourceVersion` | Nonempty string; compare exactly with chunk metadata |
| `contentHash` | Nonempty string representing the original source revision's hash |
| `embeddingModel` | Per-source override of the manifest model label |
| `expectedChunkCount` | Nonnegative safe integer; a physical-record count |
| `expectedChunkIds` | Unique nonempty strings; the exact expected logical ID set |

If both expected count and IDs are supplied, their sizes must agree. Deleted sources cannot expect retained chunks. Duplicate source identities and unknown manifest fields are input errors. Mixed tenant-labeled/unlabeled source documents are rejected; use explicit, consistent scope.

No records for an active source produce `MISSING_DOCUMENT` on a complete scan, unless zero chunks were explicitly expected. An empty `expectedChunkIds` array also declares zero expected chunks.

## Snapshot

Required: `formatVersion: 1`, `completeness`, and `records: []`. Optional `scope` must match the source scope exactly, including the distinction between global and tenant-filtered inventories.

Each physical record needs an `id`: nonempty string or nonnegative safe integer. Metadata fields are `documentId`, `tenantId`, `sourceVersion`, `contentHash`, `embeddingModel`, and `chunkId`. Missing/invalid metadata is audited instead of silently coerced. Unknown raw payload fields are discarded. Mappings relocate metadata fields using JSON Pointers, but never change the physical ID.

Canonicalize physical record IDs consistently at export time. The numeric ID `1` and string ID `"1"` are distinct physical identities; their logical fallback string is the same. Prefer explicit stable `chunkId` values.

## Freshness and inventory

Compare source versions or source-document hashes, never source-document hashes against individual chunk-text hashes. The tool uses exact string equality and does not independently compute either side. Accurate matching labels cannot prove the underlying vectors were regenerated.

`expectedChunkIds` is an authoritative output inventory for one source revision. Physical rows with unexpected IDs are flagged, even if the total row count happens to match. Logical duplicate IDs are scoped to a tenant and source document.

## Output

`formatVersion: 1`, `status`, `scope`, `summary`, `coverage`, `findings`, and `caveats` form the report contract. The first release is an initial public contract; future changes will be documented in the changelog.

- `issues-found`: known errors, or review findings without incomplete coverage.
- `inconclusive`: incomplete inventories or insufficient source freshness evidence, without known errors.
- `clean`: no findings in implemented checks.

Summary totals include findings omitted by the detail cap. `/documents/...` evidence paths refer to the manifest, and `/records/...` to the normalized snapshot. Deterministic reports omit timestamps; retain the package version and scan/inventory timestamps in your own job metadata.

## Qdrant contract

Official source reviewed November 10, 2026: [Qdrant points/scroll](https://api.qdrant.tech/api-reference/points/scroll-points), v1.20.x documentation. Integration CI targets Qdrant v1.20.0.

The adapter requests metadata projection, disables vectors, follows opaque offsets, and treats only explicit end-of-pagination as complete. Requests may still consume server resources; apply appropriate scheduling and read-only credentials.

Tenant filtering necessarily excludes unlabeled and other-tenant rows. Exhaustion does not establish snapshot isolation when concurrent writes are occurring. Sampling or reaching a local cap yields a partial snapshot and suppresses missing/count checks.
