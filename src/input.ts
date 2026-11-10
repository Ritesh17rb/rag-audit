import type { Chunk, Manifest, Mapping, MetadataField, Scope, Snapshot, SourceDocument } from './types';

export const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const string = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
export const fields: MetadataField[] = ['documentId', 'tenantId', 'sourceVersion', 'contentHash', 'embeddingModel', 'chunkId'];
export const identity = (tenant: string | undefined, documentId: string) => JSON.stringify([tenant ?? null, documentId]);
export const recordIdentity = (id: string | number) => JSON.stringify([typeof id, id]);
const own = (value: Record<string, unknown>, key: string) => Object.hasOwn(value, key);

function exactKeys(value: Record<string, unknown>, keys: string[], location: string) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown field at ${location}/${key}. Check the input format or metadata mapping.`);
}

function readScope(value: unknown): Scope | undefined {
  if (value === undefined) return;
  if (!object(value) || !string(value.tenantId)) throw new Error('scope must contain a nonempty tenantId.');
  exactKeys(value, ['tenantId'], '/scope');
  return { tenantId: value.tenantId };
}

function header(value: unknown, listKey: string): asserts value is Record<string, unknown> {
  if (!object(value) || value.formatVersion !== 1 || value.completeness !== 'complete' && value.completeness !== 'partial' || !Array.isArray(value[listKey])) {
    throw new Error(`Expected formatVersion: 1, explicit completeness: complete|partial, and a ${listKey} array.`);
  }
}

export function parseManifest(value: unknown): Manifest {
  header(value, 'documents');
  exactKeys(value, ['formatVersion', 'completeness', 'scope', 'embeddingModel', 'documents'], '');
  const scope = readScope(value.scope);
  if (value.embeddingModel !== undefined && !string(value.embeddingModel)) throw new Error('embeddingModel must be a nonempty string.');
  const seen = new Set<string>();
  if ((value.documents as unknown[]).length > 1_000_000) throw new Error('Manifest exceeds the 1,000,000 document limit.');
  const documents = (value.documents as unknown[]).map((doc, i) => {
    if (!object(doc) || !string(doc.id)) throw new Error(`documents/${i} requires a nonempty string id.`);
    exactKeys(doc, ['id', 'tenantId', 'status', 'sourceVersion', 'contentHash', 'embeddingModel', 'expectedChunkCount', 'expectedChunkIds'], `/documents/${i}`);
    for (const key of ['tenantId', 'sourceVersion', 'contentHash', 'embeddingModel']) if (own(doc, key) && !string(doc[key])) throw new Error(`documents/${i}/${key} must be a nonempty string.`);
    if (doc.status !== undefined && doc.status !== 'active' && doc.status !== 'deleted') throw new Error(`documents/${i}/status must be active or deleted.`);
    if (scope && doc.tenantId !== scope.tenantId) throw new Error(`documents/${i}/tenantId must match the manifest scope explicitly.`);
    if (doc.expectedChunkCount !== undefined && (!Number.isSafeInteger(doc.expectedChunkCount) || (doc.expectedChunkCount as number) < 0)) throw new Error(`documents/${i}/expectedChunkCount must be a nonnegative safe integer.`);
    if (doc.expectedChunkIds !== undefined) {
      if (!Array.isArray(doc.expectedChunkIds) || !doc.expectedChunkIds.every(string) || new Set(doc.expectedChunkIds).size !== doc.expectedChunkIds.length) throw new Error(`documents/${i}/expectedChunkIds must contain unique nonempty string IDs.`);
      if (doc.expectedChunkCount !== undefined && doc.expectedChunkCount !== doc.expectedChunkIds.length) throw new Error(`documents/${i} has contradictory expected chunk count and IDs.`);
    }
    if (doc.status === 'deleted' && ((doc.expectedChunkCount !== undefined && doc.expectedChunkCount !== 0) || (Array.isArray(doc.expectedChunkIds) && doc.expectedChunkIds.length > 0))) throw new Error(`Deleted documents/${i} cannot expect retained chunks.`);
    const key = identity(doc.tenantId as string | undefined, doc.id);
    if (seen.has(key)) throw new Error(`Duplicate source identity at documents/${i}. Document identity includes tenantId.`);
    seen.add(key);
    return { ...doc, id: doc.id } as SourceDocument;
  });
  if (documents.some(doc => doc.tenantId !== undefined) && documents.some(doc => doc.tenantId === undefined)) throw new Error('A tenant-aware manifest must declare tenantId on every source document.');
  return { formatVersion: 1, completeness: value.completeness as Manifest['completeness'], ...(scope ? { scope } : {}), ...(value.embeddingModel ? { embeddingModel: value.embeddingModel as string } : {}), documents } as Manifest;
}

export function parseMapping(value: unknown): Mapping {
  if (!object(value)) throw new Error('Mapping must be an object of metadata fields to JSON Pointers.');
  exactKeys(value, fields, '/mapping');
  for (const [key, path] of Object.entries(value)) {
    if (typeof path !== 'string' || !path.startsWith('/') || /~(?:[^01]|$)/.test(path)) throw new Error(`Mapping ${key} must be an RFC 6901 JSON Pointer beginning with '/'.`);
  }
  return { ...value } as Mapping;
}

export function readPointer(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.slice(1).split('/')) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if ((!object(current) && !Array.isArray(current)) || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function normalizeRecord(value: unknown, mapping: Mapping = {}): Chunk {
  if (!object(value) || !Object.hasOwn(value, 'id') || !(string(value.id) || typeof value.id === 'number' && Number.isSafeInteger(value.id) && value.id >= 0)) {
    throw new Error('Every index record needs an id: nonempty string or nonnegative safe integer. Export uint64 IDs outside the safe range as strings.');
  }
  const result: Chunk = { id: value.id as string | number };
  for (const field of fields) {
    const found = readPointer(value, mapping[field] ?? `/${field}`);
    if (found !== undefined) result[field] = found;
  }
  return result;
}

export function parseSnapshot(value: unknown, mapping: Mapping = {}): Snapshot {
  header(value, 'records');
  exactKeys(value, ['formatVersion', 'completeness', 'scope', 'records'], '');
  parseMapping(mapping);
  const scope = readScope(value.scope);
  if ((value.records as unknown[]).length > 1_000_000) throw new Error('Snapshot exceeds the 1,000,000 record limit.');
  return { formatVersion: 1, completeness: value.completeness as Snapshot['completeness'], ...(scope ? { scope } : {}), records: (value.records as unknown[]).map(record => normalizeRecord(record, mapping)) };
}
