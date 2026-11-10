import { fields, normalizeRecord, object, parseMapping, string } from './input';
import type { Mapping, Snapshot } from './types';

export interface QdrantOptions {
  url: string;
  collection: string;
  apiKey?: string;
  tenantId?: string;
  mapping?: Mapping;
  batchSize?: number;
  maxPoints?: number;
  maxPages?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

function bounded(value: number | undefined, fallback: number, max: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new Error(`${name} must be an integer from 1 to ${max}.`);
  return result;
}

async function responseJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new Error('Qdrant returned an empty response body.');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Qdrant response exceeded maxResponseBytes; reduce batchSize.');
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new Error('Qdrant returned invalid JSON.'); }
}

/** Calls only POST points/scroll with vectors disabled. Never writes to Qdrant. */
export async function readQdrantSnapshot(options: QdrantOptions): Promise<Snapshot> {
  let base: URL;
  try { base = new URL(options.url); } catch { throw new Error('Qdrant URL must be an absolute HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Qdrant URL must use HTTP(S), with no credentials, query, or fragment.');
  if (!string(options.collection)) throw new Error('A nonempty Qdrant collection is required.');
  if (options.apiKey !== undefined && (!string(options.apiKey) || /[\r\n]/.test(options.apiKey))) throw new Error('apiKey must be a nonempty single-line string.');
  if (options.apiKey && base.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('Use HTTPS when sending a Qdrant API key to a remote host.');
  if (options.tenantId !== undefined && !string(options.tenantId)) throw new Error('tenantId must be a nonempty string.');
  const batchSize = bounded(options.batchSize, 256, 10_000, 'batchSize');
  const maxPoints = bounded(options.maxPoints, 100_000, 1_000_000, 'maxPoints');
  const maxPages = bounded(options.maxPages, 10_000, 100_000, 'maxPages');
  const timeoutMs = bounded(options.timeoutMs, 15_000, 300_000, 'timeoutMs');
  const maxResponseBytes = bounded(options.maxResponseBytes, 10_000_000, 100_000_000, 'maxResponseBytes');
  const mapping = parseMapping(options.mapping ?? {});
  const paths = Object.fromEntries(fields.map(field => [field, mapping[field] ?? `/payload/${field}`])) as Required<Mapping>;
  const payloadKeys = fields.map(field => {
    const segments = paths[field].slice(1).split('/');
    if (segments[0] !== 'payload' || segments.length < 2 || segments.slice(1).some(part => !/^[a-zA-Z0-9_-]+$/.test(part))) {
      throw new Error('Qdrant mappings must use /payload/ paths with simple object keys (letters, digits, underscore, hyphen). Use a JSON export for other key syntax.');
    }
    return segments.slice(1).join('.');
  });
  const endpoint = new URL(`${base.href.replace(/\/$/, '')}/collections/${encodeURIComponent(options.collection)}/points/scroll`);
  const records: Snapshot['records'] = [];
  const cursors = new Set<string>();
  let offset: string | number | undefined;
  let complete = false;
  for (let page = 0; page < maxPages; page++) {
    const limit = Math.min(batchSize, maxPoints - records.length);
    const body = { limit, with_vector: false, with_payload: { include: [...new Set(payloadKeys)] }, ...(offset !== undefined ? { offset } : {}),
      ...(options.tenantId !== undefined ? { filter: { must: [{ key: payloadKeys[fields.indexOf('tenantId')], match: { value: options.tenantId } }] } } : {}) };
    let result: unknown;
    try {
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(options.apiKey ? { 'api-key': options.apiKey } : {}) }, redirect: 'error', body: JSON.stringify(body), signal });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Qdrant HTTP ${response.status}. Check access, collection, or service availability.`); }
      result = await responseJson(response, maxResponseBytes);
    } catch (error) {
      if (error instanceof Error && /^Qdrant /.test(error.message)) throw error;
      throw new Error('Qdrant request failed (network, timeout, cancellation, or redirect). No partial success report was produced.');
    }
    if (!object(result) || result.status !== 'ok' || !object(result.result) || !Array.isArray(result.result.points) || !Object.hasOwn(result.result, 'next_page_offset')) throw new Error('Qdrant returned an invalid scroll response envelope.');
    const points = result.result.points;
    if (points.length > limit) throw new Error('Qdrant returned more points than requested.');
    for (const point of points) {
      if (!object(point) || point.payload !== null && point.payload !== undefined && !object(point.payload)) throw new Error('Qdrant returned an invalid point or payload.');
      records.push(normalizeRecord({ id: point.id, payload: point.payload ?? {} }, paths));
    }
    const next = result.result.next_page_offset;
    if (next === null) { complete = true; break; }
    if (!(string(next) || typeof next === 'number' && Number.isSafeInteger(next) && next >= 0)) throw new Error('Qdrant returned an invalid or unsafe pagination cursor.');
    const cursor = JSON.stringify([typeof next, next]);
    if (cursors.has(cursor)) throw new Error('Qdrant repeated a pagination cursor; the scan cannot be certified complete.');
    cursors.add(cursor);
    offset = next as number | string;
    if (records.length >= maxPoints) break;
  }
  return { formatVersion: 1, completeness: complete ? 'complete' : 'partial', ...(options.tenantId !== undefined ? { scope: { tenantId: options.tenantId } } : {}), records };
}
