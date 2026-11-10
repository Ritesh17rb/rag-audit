import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const run = (...args) => spawnSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8', timeout: 15000 });

test('help, version and installed-example demo work', () => {
  assert.equal(run('--help').status, 0); assert.match(run('--version').stdout, /^0\.1\.0/);
  const result = run('demo', '--format', 'json'); assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).status, 'issues-found');
});
test('broken and repaired exports have correct CI exit codes', () => {
  const broken = run('audit', 'examples/manifest.json', 'examples/index.broken.json', '--format', 'json');
  assert.equal(broken.status, 1); assert.ok(JSON.parse(broken.stdout).summary.errors > 0);
  assert.equal(run('audit', 'examples/manifest.json', 'examples/index.fixed.json').status, 0);
  assert.equal(run('audit', 'examples/manifest.json', 'examples/index.broken.json', '--fail-on', 'never').status, 0);
});
test('invalid arguments and unsupported flags are errors', () => {
  for (const args of [['wat'], ['demo', '--url', 'http://localhost'], ['demo', '--fail-on', 'bad'], ['demo', '--format', 'bad'], ['demo', '--max-findings', '0'], ['qdrant', 'examples/manifest.json'], ['audit', '-', '-']]) assert.equal(run(...args).status, 2, args.join(' '));
});
test('stdin accepts a manifest without changing scope or completeness', async () => {
  const result = spawnSync(process.execPath, ['dist/cli.js', 'audit', '-', 'examples/index.fixed.json', '--format', 'json'], { encoding: 'utf8', input: await readFile('examples/manifest.json', 'utf8'), timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'clean');
});
test('HTML, Markdown and SARIF outputs are available', () => {
  assert.match(run('demo', '--format', 'html').stdout, /<!doctype html>/);
  assert.match(run('demo', '--format', 'markdown').stdout, /# RAG Audit/);
  assert.equal(JSON.parse(run('demo', '--format', 'sarif').stdout).version, '2.1.0');
});
test('BOM input, mapped exports, partial coverage, and overwrite protection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rag-audit-cli-'));
  try {
    const source = join(dir, 'source.json'), index = join(dir, 'index.json'), mapping = join(dir, 'mapping.json'), output = join(dir, 'report.html');
    await writeFile(source, '\uFEFF' + JSON.stringify({ formatVersion: 1, completeness: 'complete', documents: [{ id: 'a', sourceVersion: '1' }] }));
    await writeFile(index, JSON.stringify({ formatVersion: 1, completeness: 'complete', records: [{ id: 1, metadata: { source: 'a', rev: '1' } }] }));
    await writeFile(mapping, JSON.stringify({ documentId: '/metadata/source', sourceVersion: '/metadata/rev' }));
    assert.equal(run('audit', source, index, '--mapping', mapping, '--format', 'html', '--out', output).status, 0);
    assert.match(await readFile(output, 'utf8'), /clean/);
    assert.equal(run('audit', source, index, '--mapping', mapping, '--out', source).status, 2);
    assert.equal(run('audit', source, index, '--mapping', mapping, '--out', output).status, 2);
    await writeFile(index, '{"formatVersion":1,"completeness":"partial","records":[]}');
    assert.equal(run('audit', source, index, '--fail-on', 'error').status, 1);
    await writeFile(index, 'SECRET-INPUT is invalid JSON');
    const invalid = run('audit', source, index); assert.equal(invalid.status, 2); assert.ok(!invalid.stderr.includes('SECRET-INPUT'));
  } finally {
    if (!resolve(dir).startsWith(resolve(join(tmpdir(), 'rag-audit-cli-')))) throw new Error('Unexpected cleanup path.');
    await rm(dir, { recursive: true, force: true });
  }
});
