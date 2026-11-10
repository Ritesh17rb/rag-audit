import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { audit, readQdrantSnapshot } from '../dist/index.js';

async function serverTest(handler, exercise) {
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      let text = ''; for await (const part of req) text += part;
      const request = { method: req.method, url: req.url, headers: req.headers, body: text ? JSON.parse(text) : undefined };
      requests.push(request); await handler(request, res, requests.length);
    } catch { res.writeHead(500); res.end('test server handler failed'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await exercise(`http://127.0.0.1:${server.address().port}`, requests); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const respond = (res, points = [], next = null) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'ok', result: { points, next_page_offset: next } })); };

test('adapter scrolls all pages, disables vectors and requests metadata only', async () => {
  await serverTest((req, res, n) => respond(res, [{ id: n, payload: { documentId: 'a', sourceVersion: '2', text: 'DO NOT RETURN' } }], n === 1 ? 2 : null), async (url, requests) => {
    const result = await readQdrantSnapshot({ url, collection: 'knowledge', batchSize: 1, apiKey: 'test-only-key' });
    assert.equal(result.completeness, 'complete'); assert.equal(result.records.length, 2);
    assert.equal(requests[0].method, 'POST'); assert.equal(requests[0].url, '/collections/knowledge/points/scroll');
    assert.equal(requests[0].headers['api-key'], 'test-only-key');
    assert.equal(requests[0].body.with_vector, false);
    assert.ok(!requests[0].body.with_payload.include.includes('text'));
    assert.equal(requests[1].body.offset, 2);
    assert.ok(!JSON.stringify(result).includes('DO NOT RETURN'));
  });
});
test('cursor zero is included on the next request', async () => {
  await serverTest((req, res, n) => respond(res, [], n === 1 ? 0 : null), async (url, requests) => {
    assert.equal((await readQdrantSnapshot({ url, collection: 'x' })).completeness, 'complete');
    assert.equal(requests[1].body.offset, 0);
  });
});
test('scan caps return partial coverage and never claim missing documents', async () => {
  await serverTest((req, res) => respond(res, [{ id: 1, payload: { documentId: 'a', sourceVersion: '2' } }], 2), async url => {
    const result = await readQdrantSnapshot({ url, collection: 'x', maxPoints: 1 });
    assert.equal(result.completeness, 'partial');
    const report = audit({ formatVersion: 1, completeness: 'complete', documents: [{ id: 'a', sourceVersion: '2' }, { id: 'b', sourceVersion: '1' }] }, result);
    assert.equal(report.status, 'inconclusive'); assert.ok(!report.findings.some(f => f.code === 'MISSING_DOCUMENT'));
    assert.equal((await readQdrantSnapshot({ url, collection: 'x', maxPages: 1 })).completeness, 'partial');
  });
});
test('repeated cursors reject instead of looping or returning false success', async () => {
  await serverTest((req, res) => respond(res, [], 'cursor'), async url => {
    await assert.rejects(readQdrantSnapshot({ url, collection: 'x' }), /repeated.*cursor/);
  });
});
test('tenant filter uses explicit mapping and returned scope matches', async () => {
  await serverTest((req, res) => respond(res, [{ id: 1, payload: { metadata: { tenant: 'A', source: 'a', rev: '2' } } }]), async (url, requests) => {
    const result = await readQdrantSnapshot({ url, collection: 'x', tenantId: 'A', mapping: { tenantId: '/payload/metadata/tenant', documentId: '/payload/metadata/source', sourceVersion: '/payload/metadata/rev' } });
    assert.deepEqual(requests[0].body.filter, { must: [{ key: 'metadata.tenant', match: { value: 'A' } }] });
    assert.deepEqual(result.scope, { tenantId: 'A' }); assert.equal(result.records[0].documentId, 'a');
  });
});
test('collection paths are encoded and reverse-proxy base paths are preserved', async () => {
  await serverTest((req, res) => respond(res), async (url, requests) => {
    await readQdrantSnapshot({ url: `${url}/proxy/`, collection: 'a/b' });
    assert.equal(requests[0].url, '/proxy/collections/a%2Fb/points/scroll');
  });
});
test('HTTP failures omit response bodies and credentials', async () => {
  await serverTest((req, res) => { res.writeHead(403); res.end('SECRET-CUSTOMER-CONTENT test-only-key'); }, async url => {
    await assert.rejects(readQdrantSnapshot({ url, collection: 'x', apiKey: 'test-only-key' }), error => {
      assert.match(error.message, /HTTP 403/); assert.ok(!error.message.includes('SECRET')); assert.ok(!error.message.includes('test-only-key')); return true;
    });
  });
});
test('redirects are not followed with credentials', async () => {
  await serverTest((req, res) => { res.writeHead(302, { location: '/unexpected' }); res.end(); }, async (url, requests) => {
    await assert.rejects(readQdrantSnapshot({ url, collection: 'x', apiKey: 'test-only-key' }), /request failed/);
    assert.equal(requests.length, 1);
  });
});
test('request timeout and cancellation produce errors instead of partial reports', async () => {
  await serverTest(async (req, res) => { await delay(150); respond(res); }, async url => {
    await assert.rejects(readQdrantSnapshot({ url, collection: 'x', timeoutMs: 20 }), /request failed/);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(readQdrantSnapshot({ url, collection: 'x', signal: abort.signal }), /request failed/);
  });
});
test('invalid JSON and malformed envelopes never become empty complete scans', async () => {
  await serverTest((req, res) => res.end('not json'), async url => {
    await assert.rejects(readQdrantSnapshot({ url, collection: 'x' }), /invalid JSON/);
  });
  await serverTest((req, res) => res.end(JSON.stringify({ status: 'ok', result: { points: [] } })), async url => {
    await assert.rejects(readQdrantSnapshot({ url, collection: 'x' }), /invalid scroll response/);
  });
});
test('response byte limits and unsafe cursors fail explicitly', async () => {
  await serverTest((req, res) => respond(res), async url => {
    await assert.rejects(readQdrantSnapshot({ url, collection: 'x', maxResponseBytes: 10 }), /exceeded maxResponseBytes/);
  });
  await serverTest((req, res) => respond(res, [], Number.MAX_SAFE_INTEGER + 1), async url => {
    await assert.rejects(readQdrantSnapshot({ url, collection: 'x' }), /unsafe pagination cursor/);
  });
});
test('configuration validation prevents accidental credential leakage', async () => {
  for (const url of ['file:///etc/passwd', 'https://user:pass@example.com', 'https://example.com?key=secret']) await assert.rejects(readQdrantSnapshot({ url, collection: 'x' }), /Qdrant URL/);
  await assert.rejects(readQdrantSnapshot({ url: 'http://example.com', collection: 'x', apiKey: 'secret' }), /HTTPS/);
  await assert.rejects(readQdrantSnapshot({ url: 'https://example.com', collection: 'x', mapping: { tenantId: '/metadata/tenant' } }), /Qdrant mappings/);
  await assert.rejects(readQdrantSnapshot({ url: 'https://example.com', collection: 'x', maxPoints: 0 }), /maxPoints/);
});

test('real Qdrant: pagination, projection, tenant filtering and audit', { skip: !process.env.QDRANT_TEST_URL }, async () => {
  const base = process.env.QDRANT_TEST_URL.replace(/\/$/, '');
  const collection = `rag_audit_test_${randomUUID().replace(/-/g, '')}`;
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
    assert.equal(response.ok, true, `Qdrant ${method} ${path}: ${response.status}`);
    return response.json();
  };
  for (let i = 0; i < 50; i++) { try { await request('/collections'); break; } catch (error) { if (i === 49) throw error; await delay(100); } }
  await request(`/collections/${collection}`, 'PUT', { vectors: { size: 2, distance: 'Cosine' } });
  try {
    await request(`/collections/${collection}/points?wait=true`, 'PUT', { points: [1, 2, 3].map(id => ({ id, vector: [1, 0], payload: { metadata: { doc: 'a', tenant: id === 3 ? 'B' : 'A', rev: '2' }, text: 'not requested' } })) });
    const mapping = { documentId: '/payload/metadata/doc', tenantId: '/payload/metadata/tenant', sourceVersion: '/payload/metadata/rev' };
    const result = await readQdrantSnapshot({ url: base, collection, tenantId: 'A', mapping, batchSize: 1 });
    assert.equal(result.records.length, 2); assert.equal(result.completeness, 'complete');
    assert.equal(JSON.stringify(result).includes('not requested'), false);
    const sources = { formatVersion: 1, completeness: 'complete', scope: { tenantId: 'A' }, documents: [{ id: 'a', tenantId: 'A', sourceVersion: '2', expectedChunkCount: 2 }] };
    assert.equal(audit(sources, result).status, 'clean');
    assert.equal((await readQdrantSnapshot({ url: base, collection, mapping, maxPoints: 1 })).completeness, 'partial');
  } finally {
    assert.match(collection, /^rag_audit_test_[a-f0-9]{32}$/);
    await request(`/collections/${collection}`, 'DELETE');
  }
});
