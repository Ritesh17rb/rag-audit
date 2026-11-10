import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const spec = process.argv[2];
if (!spec || !process.env.npm_execpath) throw new Error('Use npm run smoke -- <tarball-or-registry-spec>.');
const installSpec = spec.endsWith('.tgz') ? resolve(spec) : spec;
const consumer = await mkdtemp(join(tmpdir(), 'rag-audit-consumer-'));
function run(args, expected = 0) {
  const result = spawnSync(process.execPath, args, { cwd: consumer, encoding: 'utf8', timeout: 120000 });
  if (result.error || result.status !== expected) throw new Error(`Consumer command failed: ${result.stderr || result.error || result.stdout}`);
  return result;
}
try {
  await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}');
  run([process.env.npm_execpath, 'install', '--ignore-scripts', '--no-audit', '--no-fund', installSpec]);
  await writeFile(join(consumer, 'smoke.mjs'), `
    import assert from 'node:assert/strict';
    import {audit} from 'rag-audit';
    const source={formatVersion:1,completeness:'complete',documents:[{id:'a',sourceVersion:'2'}]};
    const index={formatVersion:1,completeness:'complete',records:[{id:1,documentId:'a',sourceVersion:'2'}]};
    assert.equal(audit(source,index).status,'clean');
    index.records[0].sourceVersion='1';
    assert.ok(audit(source,index).findings.some(f=>f.code==='STALE_VERSION'));
  `);
  run(['smoke.mjs']);
  run(['--input-type=commonjs', '-e', "if(typeof require('rag-audit').audit!=='function')process.exit(1)"]);
  const cli = join(consumer, 'node_modules', 'rag-audit', 'dist', 'cli.js');
  const demo = JSON.parse(run([cli, 'demo', '--format', 'json'], 1).stdout);
  assert.equal(demo.status, 'issues-found');
  const example = join(consumer, 'node_modules', 'rag-audit', 'examples');
  const healthy = JSON.parse(run([cli, 'audit', join(example, 'manifest.json'), join(example, 'index.fixed.json'), '--format', 'json']).stdout);
  assert.equal(healthy.status, 'clean');
  const installed = JSON.parse(await readFile(join(consumer, 'node_modules', 'rag-audit', 'package.json'), 'utf8'));
  console.log(`Clean consumer passed: ${installed.name}@${installed.version} (ESM, CommonJS, CLI demo, healthy audit and stale-version detection)`);
} finally {
  if (!resolve(consumer).startsWith(resolve(join(tmpdir(), 'rag-audit-consumer-')))) throw new Error('Unexpected consumer cleanup path.');
  await rm(consumer, { recursive: true, force: true });
}
