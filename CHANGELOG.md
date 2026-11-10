# Changelog

## 0.1.0

- Initial read-only source-manifest auditing against JSON exports and Qdrant metadata.
- Stale versions/hashes, retained deletions, orphans, missing documents/chunks, duplicates, tenant metadata, and model-label checks.
- Explicit completeness/scoping with inconclusive reports and suppressed absence checks for partial scans.
- Configurable mappings, bounded pagination, timeouts, metadata projection, and guarded HTTP handling.
- Text, JSON, Markdown, standalone HTML, and SARIF reporting with CI exit policies.
- ESM/CommonJS builds, TypeScript types, synchronization demo, regression tests, and real Qdrant CI integration.
