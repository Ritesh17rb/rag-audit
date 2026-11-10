import type { AuditReport } from './types';

const plain = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const md = (text: string) => plain(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/`/g, "'");
const html = (text: string) => plain(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
export function formatText(report: AuditReport): string {
  return [`RAG Audit · ${report.status}`,
    `${report.summary.documents} source documents · ${report.summary.records} records · ${report.summary.errors} errors · ${report.summary.warnings} warnings`,
    `Coverage: source ${report.coverage.sourceComplete ? 'complete' : 'partial'}, index ${report.coverage.indexComplete ? 'complete' : 'partial'}; ${report.coverage.freshnessComparableRecords} records with comparable freshness metadata.`,
    ...report.findings.map(f => `\n${f.severity.toUpperCase()} ${f.code} ${plain(f.path)}${f.documentId ? ` document=${plain(f.documentId)}` : ''}${f.tenantId ? ` tenant=${plain(f.tenantId)}` : ''}${f.recordId !== undefined ? ` record=${plain(String(f.recordId))}` : ''}\n  ${plain(f.message)}\n  → ${plain(f.recommendation)}`),
    ...(report.summary.omittedFindings ? [`\n${report.summary.omittedFindings} findings omitted from detail; summary includes all findings.`] : []),
    '\nLimits:', ...report.caveats.map(c => `  ${c}`)].join('\n');
}
export function toMarkdown(report: AuditReport): string {
  return [`# RAG Audit: ${report.status}`, `\n${report.summary.errors} errors · ${report.summary.warnings} warnings · ${report.summary.records} records`,
    '\n| Severity | Code | Document | Tenant | Record | Finding | Next step |', '|---|---|---|---|---|---|---|',
    ...report.findings.map(f => `| ${f.severity} | ${f.code} | ${md(f.documentId ?? '')} | ${md(f.tenantId ?? '')} | ${md(String(f.recordId ?? ''))} | ${md(f.message)} | ${md(f.recommendation)} |`),
    `\nOmitted detail: ${report.summary.omittedFindings}. Counts include all findings.`, '\n## Coverage and limits',
    `\nSource complete: ${report.coverage.sourceComplete}. Index complete: ${report.coverage.indexComplete}. Comparable freshness records: ${report.coverage.freshnessComparableRecords}.`,
    ...report.caveats.map(c => `\n- ${md(c)}`)].join('\n');
}
export function toHtml(report: AuditReport): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>RAG Audit · ${report.status}</title><style>body{font:16px/1.6 system-ui,sans-serif;margin:40px auto;padding:0 24px;max-width:1200px;background:#f6f8fb;color:#17233b}h1{letter-spacing:-1px}table{border-collapse:collapse;width:100%;background:white}th,td{text-align:left;vertical-align:top;padding:12px;border-bottom:1px solid #dce3ee}th{background:#e8eef7}code{font-size:12px;word-break:break-word}.summary{padding:20px;background:#17233b;color:white;border-radius:12px;margin:24px 0}.table{overflow:auto}li{margin:8px 0}</style></head><body><h1>RAG Audit</h1><p>Index integrity report · ${report.status}</p><div class="summary">${report.summary.documents} sources · ${report.summary.records} records · ${report.summary.errors} errors · ${report.summary.warnings} warnings</div><p>Source inventory: ${report.coverage.sourceComplete ? 'complete' : 'partial'}. Index: ${report.coverage.indexComplete ? 'complete' : 'partial'}. Comparable freshness records: ${report.coverage.freshnessComparableRecords}.</p><div class="table"><table><thead><tr><th>Severity</th><th>Finding</th><th>Evidence</th><th>Next step</th></tr></thead><tbody>${report.findings.map(f => `<tr><td>${f.severity}</td><td><code>${f.code}</code><br>${html(f.message)}</td><td>Document: ${html(f.documentId ?? '—')}<br>Tenant: ${html(f.tenantId ?? '—')}<br>Record: ${html(String(f.recordId ?? '—'))}<br><code>${html(f.path)}</code></td><td>${html(f.recommendation)}</td></tr>`).join('')}</tbody></table></div><p>${report.summary.omittedFindings} findings omitted from detail; totals include all findings.</p><h2>Coverage and limits</h2><ul>${report.caveats.map(c => `<li>${html(c)}</li>`).join('')}</ul></body></html>`;
}
export function toSarif(report: AuditReport, manifestUri = 'manifest.json', indexUri = 'index.json') {
  const codes = Object.keys(report.summary.byCode);
  return { $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0', runs: [{ tool: { driver: { name: 'RAG Audit', informationUri: 'https://github.com/Ritesh17rb/rag-audit', rules: codes.map(id => ({ id })) } }, properties: { status: report.status, coverage: report.coverage, summary: report.summary, caveats: report.caveats },
    results: report.findings.map(f => ({ ruleId: f.code, level: f.severity, message: { text: `${f.message} ${f.recommendation}` }, locations: [{ physicalLocation: { artifactLocation: { uri: f.path.startsWith('/documents') ? manifestUri : indexUri } }, logicalLocations: [{ fullyQualifiedName: f.path, kind: 'element' }] }], properties: { documentId: f.documentId, tenantId: f.tenantId, recordId: f.recordId } })) }] };
}
