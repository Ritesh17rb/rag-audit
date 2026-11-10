#!/usr/bin/env node
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { audit, parseManifest, parseSnapshot, parseMapping, readQdrantSnapshot, formatText, toMarkdown, toHtml, toSarif } from './index';
import type { AuditReport } from './types';

const HELP = `RAG Audit — inspect an existing RAG index against a source contract

Usage:
  rag-audit audit manifest.json index.json
  rag-audit qdrant manifest.json --url https://cluster.example --collection knowledge
  rag-audit demo

Options:
  --mapping file.json        Metadata field → JSON Pointer mapping
  --format                   text | json | markdown | html | sarif (default: text)
  --out                      Write report to a NEW file
  --fail-on                   warning | error | never (default: warning)
  --max-findings              Maximum detailed findings (default: 10000)
  --url, --collection         Qdrant endpoint and collection
  --api-key-env               Environment variable holding a Qdrant key
                             Default: QDRANT_API_KEY; never pass a key directly
  --batch-size                Qdrant page size (default: 256)
  --max-points                Qdrant scan cap (default: 100000)
  --max-pages                 Qdrant page cap (default: 10000)
  --timeout-ms                Per-request Qdrant timeout (default: 15000)
  --help, -h                  Show help
  --version, -v               Show package version

Explicit source and index completeness is required. '-' reads one JSON input
from stdin (20 MB limit). Reports never contain original chunk text or API keys.
Exit: 0 passed threshold; 1 findings or inconclusive; 2 input/network error.
The Qdrant adapter only reads metadata using points/scroll.
`;

async function readJson(file: string): Promise<unknown> {
  let content: string;
  if (file === '-') {
    const parts: Buffer[] = []; let size = 0;
    for await (const chunk of process.stdin) {
      const part = Buffer.from(chunk); size += part.length;
      if (size > 20_000_000) throw new Error('Input exceeds the 20 MB limit.');
      parts.push(part);
    }
    content = Buffer.concat(parts).toString('utf8');
  } else {
    if ((await stat(file)).size > 20_000_000) throw new Error('Input exceeds the 20 MB limit. Use the library for larger inventories.');
    content = await readFile(file, 'utf8');
  }
  try { return JSON.parse(content.replace(/^\uFEFF/, '')); }
  catch { throw new Error('Invalid JSON input. Check syntax; input contents are omitted from this error.'); }
}
function number(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`--${name} must be a positive safe integer.`);
  return Number(value);
}
const uri = (file: string) => file === '-' ? 'stdin.json' : pathToFileURL(resolve(file)).href;

async function main() {
  const { values, positionals, tokens } = parseArgs({ allowPositionals: true, strict: true, tokens: true, options: {
    mapping: { type: 'string' }, format: { type: 'string', default: 'text' }, out: { type: 'string' }, 'fail-on': { type: 'string', default: 'warning' }, 'max-findings': { type: 'string' },
    url: { type: 'string' }, collection: { type: 'string' }, 'api-key-env': { type: 'string' }, 'batch-size': { type: 'string' }, 'max-points': { type: 'string' }, 'max-pages': { type: 'string' }, 'timeout-ms': { type: 'string' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } });
  if (values.help || !positionals.length && !values.version) { process.stdout.write(HELP); return; }
  if (values.version) { process.stdout.write(`${JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version}\n`); return; }
  const [command, manifestFile, indexFile] = positionals;
  if (!['audit', 'qdrant', 'demo'].includes(command)) throw new Error('Unknown command. Run rag-audit --help.');
  if (!['text', 'json', 'markdown', 'html', 'sarif'].includes(values.format!)) throw new Error('Unknown report format.');
  if (!['warning', 'error', 'never'].includes(values['fail-on']!)) throw new Error('--fail-on must be warning, error, or never.');
  const allowed = ['format', 'out', 'fail-on', 'max-findings', ...(command !== 'demo' ? ['mapping'] : []), ...(command === 'qdrant' ? ['url', 'collection', 'api-key-env', 'batch-size', 'max-points', 'max-pages', 'timeout-ms'] : [])];
  for (const token of tokens) if (token.kind === 'option' && !allowed.includes(token.name)) throw new Error(`--${token.name} does not apply to ${command}.`);
  const expectedArgs = command === 'demo' ? 1 : command === 'audit' ? 3 : 2;
  if (positionals.length !== expectedArgs) throw new Error(`Wrong arguments for ${command}. Run rag-audit --help.`);
  if (positionals.filter(arg => arg === '-').length + (values.mapping === '-' ? 1 : 0) > 1) throw new Error('Only one input may use stdin.');
  const maxFindings = number(values['max-findings'], 'max-findings');
  let report: AuditReport;
  let sourceUri = 'manifest.json', indexUri = 'index.json';
  if (command === 'demo') {
    const manifest = parseManifest(JSON.parse(await readFile(new URL('../examples/manifest.json', import.meta.url), 'utf8')));
    const snapshot = parseSnapshot(JSON.parse(await readFile(new URL('../examples/index.broken.json', import.meta.url), 'utf8')));
    report = audit(manifest, snapshot, { maxFindings });
    sourceUri = 'examples/manifest.json'; indexUri = 'examples/index.broken.json';
  } else {
    const manifest = parseManifest(await readJson(manifestFile));
    const mapping = values.mapping ? parseMapping(await readJson(values.mapping)) : {};
    sourceUri = uri(manifestFile);
    if (command === 'qdrant') {
      if (!values.url || !values.collection) throw new Error('qdrant requires --url and --collection.');
      const envName = values['api-key-env'] ?? 'QDRANT_API_KEY';
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(envName)) throw new Error('--api-key-env must name an environment variable.');
      const apiKey = process.env[envName];
      if (values['api-key-env'] && !apiKey) throw new Error('The requested API-key environment variable is unset or empty.');
      const snapshot = await readQdrantSnapshot({ url: values.url, collection: values.collection, apiKey, tenantId: manifest.scope?.tenantId, mapping,
        batchSize: number(values['batch-size'], 'batch-size'), maxPoints: number(values['max-points'], 'max-points'), maxPages: number(values['max-pages'], 'max-pages'), timeoutMs: number(values['timeout-ms'], 'timeout-ms') });
      report = audit(manifest, snapshot, { maxFindings }); indexUri = 'qdrant-metadata.json';
    } else {
      report = audit(manifest, parseSnapshot(await readJson(indexFile), mapping), { maxFindings }); indexUri = uri(indexFile);
    }
  }
  const output = values.format === 'json' ? JSON.stringify(report, null, 2) : values.format === 'markdown' ? toMarkdown(report) : values.format === 'html' ? toHtml(report) : values.format === 'sarif' ? JSON.stringify(toSarif(report, sourceUri, indexUri), null, 2) : formatText(report);
  if (values.out) await writeFile(values.out, `${output}\n`, { flag: 'wx' }); else process.stdout.write(`${output}\n`);
  process.exitCode = values['fail-on'] === 'never' ? 0 : report.status === 'inconclusive' || report.summary.errors > 0 || values['fail-on'] === 'warning' && report.summary.warnings > 0 ? 1 : 0;
}
process.stdout.on('error', (error: NodeJS.ErrnoException) => { if (error.code === 'EPIPE') process.exitCode = 0; else throw error; });
main().catch((error: unknown) => { process.stderr.write(`RAG Audit: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; });
