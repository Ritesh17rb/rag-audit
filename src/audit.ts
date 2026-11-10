import type { AuditReport, Chunk, Finding, FindingCode, Manifest, Snapshot } from './types';
import { fields, identity, parseManifest, parseSnapshot, recordIdentity, string } from './input';

export function audit(sourceInput: Manifest, indexInput: Snapshot, options: { maxFindings?: number } = {}): AuditReport {
  const manifest = parseManifest(sourceInput);
  const snapshot = parseSnapshot(indexInput);
  if (manifest.scope?.tenantId !== snapshot.scope?.tenantId) throw new Error('Source and index scopes must match exactly. Use equally scoped inventories; a filtered index cannot prove global absence.');
  const maxFindings = options.maxFindings ?? 10_000;
  if (!Number.isSafeInteger(maxFindings) || maxFindings < 1 || maxFindings > 1_000_000) throw new Error('maxFindings must be an integer from 1 to 1,000,000.');
  const findings: Finding[] = [];
  const byCode: Partial<Record<FindingCode, number>> = {};
  let errors = 0, warnings = 0, totalFindings = 0, matchedRecords = 0, freshnessComparableRecords = 0, sourceUnverifiableRecords = 0;
  const add = (finding: Finding) => {
    totalFindings++;
    byCode[finding.code] = (byCode[finding.code] ?? 0) + 1;
    if (finding.severity === 'error') errors++; else warnings++;
    if (findings.length < maxFindings) findings.push(finding);
  };
  const sourceComplete = manifest.completeness === 'complete';
  const indexComplete = snapshot.completeness === 'complete';
  if (!sourceComplete) add({ code: 'SOURCE_INVENTORY_PARTIAL', severity: 'warning', path: '/completeness', message: 'The source inventory is partial. Unknown source identities cannot be proven deleted.', recommendation: 'Supply an authoritative source inventory for the same scope, or explicit deletion tombstones.' });
  if (!indexComplete) add({ code: 'INDEX_SCAN_PARTIAL', severity: 'warning', path: '/completeness', message: 'The index scan is partial. Missing documents, chunk IDs, and counts cannot be established.', recommendation: 'Complete the scan and audit again. Absence checks are suppressed for this input.' });
  const documents = new Map(manifest.documents.map((doc, i) => [identity(doc.tenantId, doc.id), { doc, i }]));
  const expectedIds = new Map(manifest.documents.filter(doc => doc.expectedChunkIds).map(doc => [identity(doc.tenantId, doc.id), new Set(doc.expectedChunkIds)]));
  const recordsByDocument = new Map<string, Array<{ record: Chunk; i: number }>>();
  const seenIds = new Set<string>();
  const logicalIds = new Map<string, Set<string>>();
  const models = new Set<string>();
  const tenantAware = !!manifest.scope || manifest.documents.some(doc => doc.tenantId !== undefined);
  for (const [i, record] of snapshot.records.entries()) {
    const base = { path: `/records/${i}`, recordId: record.id, ...(string(record.documentId) ? { documentId: record.documentId } : {}), ...(string(record.tenantId) ? { tenantId: record.tenantId } : {}) };
    const idKey = recordIdentity(record.id);
    if (seenIds.has(idKey)) {
      add({ ...base, code: 'DUPLICATE_RECORD', severity: 'error', message: 'The same physical record ID occurs more than once in the index export.', recommendation: 'Check export pagination and index stability. Duplicate physical rows are excluded from coverage counts.' });
      continue;
    }
    seenIds.add(idKey);
    const badFields = new Set<string>();
    for (const field of fields) {
      if (record[field] !== undefined && !string(record[field])) {
        badFields.add(field);
        add({ ...base, path: `${base.path}/${field}`, code: 'INVALID_METADATA', severity: 'error', message: `${field} must be a nonempty string.`, recommendation: 'Correct the metadata producer or configure an explicit field mapping; values are never coerced.' });
      }
    }
    if (record.documentId === undefined) add({ ...base, path: `${base.path}/documentId`, code: 'MISSING_METADATA', severity: 'error', message: 'documentId is missing; the record cannot be linked to a source.', recommendation: 'Store a stable document ID in every chunk and configure its metadata mapping.' });
    if (tenantAware && record.tenantId === undefined) add({ ...base, path: `${base.path}/tenantId`, code: 'MISSING_METADATA', severity: 'error', message: 'tenantId is missing in a tenant-aware audit.', recommendation: 'Store explicit tenant identity on every chunk. Tenant identity is never inferred from a document ID.' });
    if (manifest.scope && string(record.tenantId) && record.tenantId !== manifest.scope.tenantId) {
      add({ ...base, code: 'TENANT_SCOPE_MISMATCH', severity: 'error', message: 'The record tenant differs from the declared audit scope.', recommendation: 'Review export filtering, metadata mapping, and tenant routing. This finding does not by itself prove a retrieval authorization bypass.' });
      continue;
    }
    if (string(record.embeddingModel)) models.add(record.embeddingModel);
    if (!string(record.documentId) || badFields.has('tenantId') || tenantAware && !string(record.tenantId)) continue;
    const key = identity(string(record.tenantId) ? record.tenantId : undefined, record.documentId);
    const source = documents.get(key);
    if (!source) {
      sourceUnverifiableRecords++;
      add({ ...base, code: sourceComplete ? 'ORPHANED_CHUNK' : 'SOURCE_NOT_VERIFIABLE', severity: sourceComplete ? 'error' : 'warning', message: sourceComplete ? 'The source identity is absent from the authoritative manifest.' : 'The source identity is absent from a partial manifest; deletion cannot be inferred.', recommendation: sourceComplete ? 'Verify the source inventory, then repair the ingestion/deletion pipeline. This tool never deletes data.' : 'Expand the source inventory or include an explicit deletion tombstone.' });
      continue;
    }
    if (source.doc.status === 'deleted') {
      add({ ...base, code: 'DELETED_SOURCE_RETAINED', severity: 'error', message: 'A chunk remains indexed for an explicitly deleted source.', recommendation: 'Propagate the source deletion through the index and any separate response caches; rerun the audit.' });
      continue;
    }
    matchedRecords++;
    const grouped = recordsByDocument.get(key) ?? [];
    grouped.push({ record, i }); recordsByDocument.set(key, grouped);
    const logicalId = string(record.chunkId) ? record.chunkId : String(record.id);
    const seenLogical = logicalIds.get(key) ?? new Set<string>();
    if (seenLogical.has(logicalId)) add({ ...base, code: 'DUPLICATE_CHUNK', severity: 'error', message: 'Multiple physical records share the same logical chunk ID for this source.', recommendation: 'Use idempotent upserts and stable chunk identities. Review duplicates before cleanup.' });
    seenLogical.add(logicalId); logicalIds.set(key, seenLogical);
    let comparable = false;
    for (const field of ['sourceVersion', 'contentHash', 'embeddingModel'] as const) {
      const expected = field === 'embeddingModel' ? source.doc.embeddingModel ?? manifest.embeddingModel : source.doc[field];
      if (expected === undefined) continue;
      if (record[field] === undefined) add({ ...base, path: `${base.path}/${field}`, code: 'MISSING_METADATA', severity: 'error', message: `${field} is required by the source contract but missing from this chunk.`, recommendation: `Persist the source ${field} with every derived chunk and re-index affected records.` });
      else if (string(record[field])) {
        if (field !== 'embeddingModel') comparable = true;
        if (record[field] !== expected) {
          const code = field === 'sourceVersion' ? 'STALE_VERSION' : field === 'contentHash' ? 'STALE_CONTENT_HASH' : 'EMBEDDING_MODEL_MISMATCH';
          add({ ...base, path: `${base.path}/${field}`, code, severity: 'error', message: `${field} differs from the value declared by the source contract.`, recommendation: field === 'embeddingModel' ? 'Re-embed with the configured model or update the explicitly versioned ingestion contract.' : 'Re-index the current source revision and retire obsolete chunks.' });
        }
      }
    }
    if (comparable) freshnessComparableRecords++;
    if (expectedIds.has(key) && !expectedIds.get(key)!.has(logicalId)) add({ ...base, code: 'UNEXPECTED_CHUNK', severity: 'error', message: 'The logical chunk ID is not in the source contract’s expected set.', recommendation: 'Inspect stale chunk cleanup or update the authoritative expected chunk inventory.' });
  }
  for (const [key, { doc, i }] of documents) {
    if (doc.status === 'deleted') continue;
    const base = { documentId: doc.id, ...(doc.tenantId ? { tenantId: doc.tenantId } : {}), path: `/documents/${i}` };
    const records = recordsByDocument.get(key) ?? [];
    if (doc.sourceVersion === undefined && doc.contentHash === undefined) add({ ...base, code: 'FRESHNESS_NOT_VERIFIABLE', severity: 'warning', message: 'This source has neither a version nor a content hash, so chunk freshness cannot be assessed.', recommendation: 'Record source revision or a consistently computed source-content hash in both inventories.' });
    if (!indexComplete) continue;
    const expectedCount = doc.expectedChunkCount ?? doc.expectedChunkIds?.length;
    if (records.length === 0 && expectedCount !== 0) add({ ...base, code: 'MISSING_DOCUMENT', severity: 'error', message: 'No linkable chunks for this active source were found in the complete scan.', recommendation: 'Check ingestion failures and metadata mapping; sources intentionally producing zero chunks should declare expectedChunkCount: 0.' });
    if (expectedCount !== undefined && records.length !== expectedCount) add({ ...base, code: 'CHUNK_COUNT_MISMATCH', severity: 'error', message: `Expected ${expectedCount} physical chunks; found ${records.length} unique physical records linked to this source.`, recommendation: 'Compare the ingestion chunk inventory with indexed records and repair omissions or duplicates.' });
    if (doc.expectedChunkIds) {
      const present = logicalIds.get(key) ?? new Set<string>();
      for (const id of doc.expectedChunkIds) if (!present.has(id)) add({ ...base, code: 'MISSING_CHUNK', severity: 'error', message: `Expected logical chunk ${id} was not found in the complete scan.`, recommendation: 'Re-ingest the missing chunk and verify stable chunk IDs and metadata mapping.' });
    }
  }
  if (models.size > 1) add({ code: 'MIXED_EMBEDDING_MODELS', severity: 'warning', path: '/records', message: 'More than one embedding-model label occurs in the scanned metadata.', recommendation: 'Confirm whether this is intentional. Metadata labels do not verify actual vector provenance or dimensional compatibility.' });
  findings.sort((a, b) => a.code.localeCompare(b.code, 'en') || (a.tenantId ?? '').localeCompare(b.tenantId ?? '', 'en') || (a.documentId ?? '').localeCompare(b.documentId ?? '', 'en') || a.path.localeCompare(b.path, 'en'));
  const inconclusive = !sourceComplete || !indexComplete || (byCode.FRESHNESS_NOT_VERIFIABLE ?? 0) > 0 || sourceUnverifiableRecords > 0;
  return { formatVersion: 1, status: errors > 0 ? 'issues-found' : inconclusive ? 'inconclusive' : totalFindings > 0 ? 'issues-found' : 'clean', scope: manifest.scope ?? null,
    summary: { documents: manifest.documents.length, records: snapshot.records.length, uniqueRecords: seenIds.size, matchedRecords, errors, warnings, totalFindings, omittedFindings: totalFindings - findings.length, byCode },
    coverage: { sourceComplete, indexComplete, findingsTruncated: totalFindings > findings.length, freshnessComparableRecords, sourceUnverifiableRecords }, findings,
    caveats: ['Completeness is a caller-supplied assertion for the declared scope, not independently proven by this tool.', 'Checks compare declared metadata; hashes, model labels, source contents, vector values, retrieval authorization, and response caches are not independently verified.', 'A complete live scroll is an exhausted enumeration, not a transactionally consistent snapshot. Pause writes or use an immutable export when absence proofs matter.', 'Report paths beginning /documents refer to the manifest; /records refers to the normalized snapshot. Clean means no issues in implemented checks, not end-to-end RAG correctness.'] };
}
