export interface Scope { tenantId: string }
export interface SourceDocument {
  id: string;
  tenantId?: string;
  status?: 'active' | 'deleted';
  sourceVersion?: string;
  contentHash?: string;
  embeddingModel?: string;
  expectedChunkCount?: number;
  expectedChunkIds?: string[];
}
export interface Manifest {
  formatVersion: 1;
  completeness: 'complete' | 'partial';
  scope?: Scope;
  embeddingModel?: string;
  documents: SourceDocument[];
}
export type MetadataField = 'documentId' | 'tenantId' | 'sourceVersion' | 'contentHash' | 'embeddingModel' | 'chunkId';
/** Metadata fields are unknown until audited so corrupt records produce findings. */
export interface Chunk {
  id: string | number;
  documentId?: unknown;
  tenantId?: unknown;
  sourceVersion?: unknown;
  contentHash?: unknown;
  embeddingModel?: unknown;
  chunkId?: unknown;
}
export interface Snapshot {
  formatVersion: 1;
  completeness: 'complete' | 'partial';
  scope?: Scope;
  records: Chunk[];
}
export type Mapping = Partial<Record<MetadataField, string>>;
export type Severity = 'error' | 'warning';
export type FindingCode = 'SOURCE_INVENTORY_PARTIAL' | 'INDEX_SCAN_PARTIAL' | 'MISSING_METADATA' | 'INVALID_METADATA' |
  'TENANT_SCOPE_MISMATCH' | 'DUPLICATE_RECORD' | 'DUPLICATE_CHUNK' | 'DELETED_SOURCE_RETAINED' | 'ORPHANED_CHUNK' |
  'SOURCE_NOT_VERIFIABLE' | 'STALE_VERSION' | 'STALE_CONTENT_HASH' | 'EMBEDDING_MODEL_MISMATCH' |
  'MISSING_DOCUMENT' | 'MISSING_CHUNK' | 'UNEXPECTED_CHUNK' | 'CHUNK_COUNT_MISMATCH' |
  'FRESHNESS_NOT_VERIFIABLE' | 'MIXED_EMBEDDING_MODELS';
export interface Finding {
  code: FindingCode;
  severity: Severity;
  path: string;
  documentId?: string;
  tenantId?: string;
  recordId?: string | number;
  message: string;
  recommendation: string;
}
export interface AuditReport {
  formatVersion: 1;
  status: 'clean' | 'issues-found' | 'inconclusive';
  scope: Scope | null;
  summary: { documents: number; records: number; uniqueRecords: number; matchedRecords: number; errors: number; warnings: number; totalFindings: number; omittedFindings: number; byCode: Partial<Record<FindingCode, number>> };
  coverage: { sourceComplete: boolean; indexComplete: boolean; findingsTruncated: boolean; freshnessComparableRecords: number; sourceUnverifiableRecords: number };
  findings: Finding[];
  caveats: string[];
}
