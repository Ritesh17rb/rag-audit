# Roadmap and adoption

## Initial release

- Source-manifest reconciliation against JSON exports and Qdrant.
- Freshness, deletion, identity, expected-chunk, and embedding-label checks.
- Explicit scope/completeness and incomplete-scan behavior.
- Read-only operation, metadata-only reports, CI thresholds, and portable library builds.
- Broken/repaired synchronization fixtures and real Qdrant CI integration.

## Validate with users

Recruit five engineers maintaining an existing RAG index. Request redacted inventories and minimal metadata exports. Measure actionable findings, false positives, missing mappings, and repeat use in CI or scheduled checks. The initial release has no external adoption or accuracy claims.

Prioritize metadata onboarding and clear remediation based on that feedback. A small real-world benchmark should label known defects and clean cases independently of the implementation.

## Possible follow-ups

- pgvector and other adapters driven by demand.
- Streaming exports and larger-index memory budgets.
- First-party manifest generation for selected ingestion frameworks.
- Immutable export provenance and better scan-consistency checks.
- Separate retrieval authorization probes and cache adapters with explicit scopes.
- Finding baselines and scheduled report comparisons.

Automatic deletion, pipeline repair, hosted storage of customer exports, and claims of end-to-end RAG correctness are outside the first release.
