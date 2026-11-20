// Markdown report of an upgrade plan (and, after a run, its results): the run summary and the
// body of the rolling "Upgrades that need a human" issue.

const cell = text => String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const short = text => (String(text).length > 90 ? `${String(text).slice(0, 87)}...` : text);

/** @param plan entries from planUpgrades; @param results optional Map key -> { ok, reason } */
export function reportMarkdown(plan, results = new Map()) {
  const key = e => `${e.app}#${e.index}#${e.name}`;
  const auto = plan.filter(e => e.auto && !e.error);
  const manual = plan.filter(e => !e.auto && !e.error);
  const errors = plan.filter(e => e.error);
  const lines = ['## WebPC upgrades', ''];
  if (!plan.length) return [...lines, 'Everything is up to date.', ''].join('\n');
  if (auto.length) {
    lines.push('### Automatic', '', '| App | Source | From | To | Result |', '|---|---|---|---|---|');
    for (const e of auto) {
      const r = results.get(key(e));
      lines.push(`| ${e.app} | ${cell(e.name)} | ${cell(short(e.from))} | ${cell(short(e.to))} | ${r ? (r.ok ? 'committed' : `reverted: ${cell(r.reason)}`) : 'planned'} |`);
    }
    lines.push('');
  }
  if (manual.length) {
    lines.push('### Needs a human (manual sources and new majors)', '', '| App | Source | From | To | Why |', '|---|---|---|---|---|');
    for (const e of manual) lines.push(`| ${e.app} | ${cell(e.name)} | ${cell(short(e.from))} | ${cell(short(e.to))} | ${cell(e.note ?? 'upgrade: manual in catalog.yaml')} |`);
    lines.push('');
  }
  if (errors.length) {
    lines.push('### Could not check', '', '| App | Source | Error |', '|---|---|---|');
    for (const e of errors) lines.push(`| ${e.app} | ${cell(e.name)} | ${cell(short(e.error))} |`);
    lines.push('');
  }
  return lines.join('\n');
}
