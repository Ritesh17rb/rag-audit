import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { audit, parseManifest, parseSnapshot, parseMapping, toHtml, toMarkdown, toSarif, formatText } from '../dist/index.js';

const manifest = (documents = [{ id: 'a', sourceVersion: '2' }], extras = {}) => ({ formatVersion: 1, completeness: 'complete', documents, ...extras });
const snapshot = (records = [{ id: 1, documentId: 'a', sourceVersion: '2' }], extras = {}) => ({ formatVersion: 1, completeness: 'complete', records, ...extras });
const codes = report => report.findings.map(f => f.code);
const fixtures = async name => JSON.parse(await readFile(new URL(`../examples/${name}`, import.meta.url), 'utf8'));

test('healthy source and index are clean with comparable freshness', () => {
  const result = audit(manifest(), snapshot());
  assert.equal(result.status, 'clean'); assert.equal(result.coverage.freshnessComparableRecords, 1);
  assert.equal(result.summary.matchedRecords, 1);
});
test('ESM and CommonJS expose the same usable API', () => {
  const require = createRequire(import.meta.url);
  assert.equal(require('../dist/index.cjs').audit(manifest(), snapshot()).status, 'clean');
});
test('orphan determination requires authoritative sources', () => {
  const index = snapshot([{ id: 1, documentId: 'unknown' }]);
  assert.ok(codes(audit(manifest([]), index)).includes('ORPHANED_CHUNK'));
  const partial = audit(manifest([], { completeness: 'partial' }), index);
  assert.equal(partial.status, 'inconclusive');
  assert.ok(codes(partial).includes('SOURCE_NOT_VERIFIABLE'));
  assert.ok(!codes(partial).includes('ORPHANED_CHUNK'));
});
test('explicit tombstones establish retained deletions even with a partial manifest', () => {
  const result = audit(manifest([{ id: 'a', status: 'deleted' }], { completeness: 'partial' }), snapshot());
  assert.ok(codes(result).includes('DELETED_SOURCE_RETAINED'));
  assert.equal(result.status, 'issues-found');
});
test('complete scan identifies missing documents and expected chunks', () => {
  const result = audit(manifest([{ id: 'a', sourceVersion: '2', expectedChunkIds: ['c0', 'c1'] }]), snapshot([]));
  assert.equal(result.summary.byCode.MISSING_DOCUMENT, 1);
  assert.equal(result.summary.byCode.MISSING_CHUNK, 2);
  assert.equal(result.summary.byCode.CHUNK_COUNT_MISMATCH, 1);
});
test('partial scan suppresses all absence and count checks', () => {
  const result = audit(manifest([{ id: 'a', sourceVersion: '2', expectedChunkIds: ['c0'] }]), snapshot([], { completeness: 'partial' }));
  assert.equal(result.status, 'inconclusive');
  assert.deepEqual(codes(result), ['INDEX_SCAN_PARTIAL']);
});
test('known freshness errors are still identified in partial scans', () => {
  const result = audit(manifest(), snapshot([{ id: 1, documentId: 'a', sourceVersion: '1' }], { completeness: 'partial' }));
  assert.ok(codes(result).includes('STALE_VERSION')); assert.equal(result.status, 'issues-found');
});
test('version and source hash drift are separate findings', () => {
  const result = audit(manifest([{ id: 'a', sourceVersion: '2', contentHash: 'new' }]), snapshot([{ id: 1, documentId: 'a', sourceVersion: '1', contentHash: 'old' }]));
  assert.ok(codes(result).includes('STALE_VERSION')); assert.ok(codes(result).includes('STALE_CONTENT_HASH'));
});
test('missing expected metadata is never coerced or treated as matching', () => {
  const record = { id: 1, documentId: 'a', sourceVersion: 2 };
  const result = audit(manifest(), snapshot([record]));
  assert.ok(codes(result).includes('INVALID_METADATA'));
  assert.equal(record.sourceVersion, 2);
  assert.ok(codes(audit(manifest(), snapshot([{ id: 1, documentId: 'a' }]))).includes('MISSING_METADATA'));
});
test('freshness with no source evidence is explicitly inconclusive', () => {
  const result = audit(manifest([{ id: 'a' }]), snapshot());
  assert.equal(result.status, 'inconclusive'); assert.ok(codes(result).includes('FRESHNESS_NOT_VERIFIABLE'));
});
test('zero-chunk sources are permitted when explicitly declared', () => {
  const result = audit(manifest([{ id: 'a', sourceVersion: '2', expectedChunkCount: 0 }]), snapshot([]));
  assert.equal(result.status, 'clean');
});
test('deleted sources absent from index do not produce missing findings', () => {
  assert.equal(audit(manifest([{ id: 'a', status: 'deleted' }]), snapshot([])).status, 'clean');
});
test('tenant plus document ID is the identity, not document ID alone', () => {
  const sources = manifest([{ id: 'same', tenantId: 'A', sourceVersion: '1' }, { id: 'same', tenantId: 'B', sourceVersion: '2' }]);
  const index = snapshot([{ id: 1, documentId: 'same', tenantId: 'A', sourceVersion: '1' }, { id: 2, documentId: 'same', tenantId: 'B', sourceVersion: '2' }]);
  assert.equal(audit(sources, index).status, 'clean');
});
test('tenant identity cannot be inferred from the document ID', () => {
  const result = audit(manifest([{ id: 'a', tenantId: 'A', sourceVersion: '2' }]), snapshot());
  assert.ok(result.findings.some(f => f.code === 'MISSING_METADATA' && f.path.endsWith('/tenantId')));
  assert.equal(result.summary.matchedRecords, 0);
  assert.equal(result.coverage.sourceUnverifiableRecords, 1);
});
test('mismatched audit scopes fail instead of inventing orphan/missing findings', () => {
  assert.throws(() => audit(manifest(), snapshot([], { scope: { tenantId: 'A' } })), /scopes must match/);
  assert.throws(() => audit(manifest([], { scope: { tenantId: 'B' } }), snapshot([], { scope: { tenantId: 'A' } })), /scopes must match/);
});
test('records outside a declared tenant scope are diagnosed and not linked', () => {
  const result = audit(manifest([{ id: 'a', tenantId: 'A', sourceVersion: '2' }], { scope: { tenantId: 'A' } }), snapshot([{ id: 1, documentId: 'a', tenantId: 'B', sourceVersion: '2' }], { scope: { tenantId: 'A' } }));
  assert.ok(codes(result).includes('TENANT_SCOPE_MISMATCH')); assert.equal(result.summary.matchedRecords, 0);
});
test('compound identities cannot collide through delimiters', () => {
  const result = audit(manifest([{ id: 'b:c', tenantId: 'a', sourceVersion: '1' }, { id: 'c', tenantId: 'a:b', sourceVersion: '2' }]), snapshot([{ id: 1, documentId: 'b:c', tenantId: 'a', sourceVersion: '1' }, { id: 2, documentId: 'c', tenantId: 'a:b', sourceVersion: '2' }]));
  assert.equal(result.status, 'clean');
});
test('duplicate physical records are reported and excluded from coverage counts', () => {
  const result = audit(manifest([{ id: 'a', sourceVersion: '2', expectedChunkCount: 1 }]), snapshot([{ id: 1, documentId: 'a', sourceVersion: '2' }, { id: 1, documentId: 'a', sourceVersion: '2' }]));
  assert.ok(codes(result).includes('DUPLICATE_RECORD'));
  assert.equal(result.summary.uniqueRecords, 1); assert.equal(result.summary.matchedRecords, 1);
  assert.ok(!codes(result).includes('CHUNK_COUNT_MISMATCH'));
});
test('logical chunk duplicates and unexpected IDs are identified separately', () => {
  const result = audit(manifest([{ id: 'a', sourceVersion: '2', expectedChunkIds: ['c0'] }]), snapshot([{ id: 1, documentId: 'a', sourceVersion: '2', chunkId: 'c0' }, { id: 2, documentId: 'a', sourceVersion: '2', chunkId: 'c0' }, { id: 3, documentId: 'a', sourceVersion: '2', chunkId: 'stale' }]));
  assert.ok(codes(result).includes('DUPLICATE_CHUNK')); assert.ok(codes(result).includes('UNEXPECTED_CHUNK'));
});
test('missing chunk IDs use physical record IDs as the documented fallback', () => {
  assert.equal(audit(manifest([{ id: 'a', sourceVersion: '2', expectedChunkIds: ['1'] }]), snapshot()).status, 'clean');
});
test('document-specific model contracts override collection defaults', () => {
  const sources = manifest([{ id: 'a', sourceVersion: '2', embeddingModel: 'special' }], { embeddingModel: 'default' });
  assert.equal(audit(sources, snapshot([{ id: 1, documentId: 'a', sourceVersion: '2', embeddingModel: 'special' }])).status, 'clean');
  assert.ok(codes(audit(sources, snapshot([{ id: 1, documentId: 'a', sourceVersion: '2', embeddingModel: 'default' }]))).includes('EMBEDDING_MODEL_MISMATCH'));
});
test('mixed model labels raise a review warning', () => {
  const result = audit(manifest(), snapshot([{ id: 1, documentId: 'a', sourceVersion: '2', embeddingModel: 'one' }, { id: 2, documentId: 'a', sourceVersion: '2', embeddingModel: 'two' }]));
  assert.ok(codes(result).includes('MIXED_EMBEDDING_MODELS'));
});
test('truncated finding details preserve total error counts and failure status', () => {
  const result = audit(manifest([]), snapshot([{ id: 1, documentId: 'a' }, { id: 2, documentId: 'b' }]), { maxFindings: 1 });
  assert.equal(result.findings.length, 1); assert.equal(result.summary.errors, 2);
  assert.equal(result.summary.omittedFindings, 1); assert.equal(result.coverage.findingsTruncated, true);
  assert.equal(result.status, 'issues-found');
  assert.throws(() => audit(manifest(), snapshot(), { maxFindings: 0 }), /maxFindings/);
});
test('input contracts reject ambiguous or contradictory source inventories', () => {
  for (const value of [null, {}, { formatVersion: 1, documents: [] }]) assert.throws(() => parseManifest(value));
  assert.throws(() => parseManifest(manifest([{ id: 'a' }, { id: 'a' }])), /Duplicate source/);
  assert.throws(() => parseManifest(manifest([{ id: 'a', tenantId: 'A' }, { id: 'b' }])), /tenant-aware/);
  assert.throws(() => parseManifest(manifest([{ id: 'a', expectedChunkCount: 2, expectedChunkIds: ['one'] }])), /contradictory/);
  assert.throws(() => parseManifest(manifest([{ id: 'a', status: 'deleted', expectedChunkCount: 1 }])), /Deleted/);
  assert.throws(() => parseManifest(manifest([{ id: 'a', sourceVersion: 1 }])), /nonempty string/);
  assert.throws(() => parseManifest(manifest([], { complete: true })), /Unknown field/);
  assert.throws(() => parseManifest(manifest([], { completeness: ['complete'] })), /explicit completeness/);
});
test('unsafe numeric IDs and malformed mappings are rejected', () => {
  assert.throws(() => parseSnapshot(snapshot([{ id: Number.MAX_SAFE_INTEGER + 1 }])), /safe integer/);
  assert.throws(() => parseSnapshot(snapshot([{ documentId: 'a' }])), /Every index record/);
  assert.throws(() => parseMapping({ documentId: 'metadata.id' }), /JSON Pointer/);
  assert.throws(() => parseMapping({ documentId: '/bad~2escape' }), /JSON Pointer/);
  assert.throws(() => parseMapping({ documentID: '/id' }), /Unknown field/);
});
test('JSON Pointer mapping handles escaped keys without reading prototype properties', () => {
  const index = parseSnapshot(snapshot([{ id: 1, metadata: { 'source/id~': 'a', version: '2' }, text: 'CUSTOMER SECRET' }]), { documentId: '/metadata/source~1id~0', sourceVersion: '/metadata/version' });
  assert.equal(audit(manifest(), index).status, 'clean');
  assert.equal(JSON.stringify(index).includes('CUSTOMER SECRET'), false);
  const inherited = Object.create({ documentId: 'a' }); inherited.id = 1;
  assert.equal(parseSnapshot(snapshot([inherited])).records[0].documentId, undefined);
});
test('reports escape HTML and terminal controls and retain coverage caveats', () => {
  const report = audit(manifest([]), snapshot([{ id: 'x', documentId: '<script>alert(1)</script>\u001b[31m|bad' }]));
  assert.ok(!toHtml(report).includes('<script>'));
  assert.ok(toHtml(report).includes('&lt;script&gt;'));
  assert.ok(!formatText(report).includes('\u001b'));
  assert.ok(toMarkdown(report).includes('\\|bad'));
  const sarif = toSarif(report); assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs[0].results[0].ruleId, 'ORPHANED_CHUNK');
});
test('source and index evidence locations remain distinct in SARIF', () => {
  const report = audit(manifest(), snapshot([]));
  assert.equal(toSarif(report, 'source.json', 'chunks.json').runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, 'source.json');
  const partial = audit(manifest([], { completeness: 'partial' }), snapshot([]));
  assert.equal(toSarif(partial, 'source.json', 'chunks.json').runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, 'source.json');
});
test('audit does not mutate inputs and is reproducible', () => {
  const sources = manifest(), index = snapshot(); const before = JSON.stringify([sources, index]);
  assert.deepEqual(audit(sources, index), audit(sources, index)); assert.equal(JSON.stringify([sources, index]), before);
});
test('broken synchronization demo exposes issues; repaired export is clean', async () => {
  const sources = await fixtures('manifest.json');
  const broken = audit(sources, await fixtures('index.broken.json'));
  for (const code of ['STALE_VERSION', 'STALE_CONTENT_HASH', 'DELETED_SOURCE_RETAINED', 'ORPHANED_CHUNK', 'MISSING_DOCUMENT', 'MISSING_CHUNK', 'MISSING_METADATA', 'EMBEDDING_MODEL_MISMATCH']) assert.ok(codes(broken).includes(code), code);
  assert.equal(audit(sources, await fixtures('index.fixed.json')).status, 'clean');
});
