// npm run schemas — fetches the LIVE schemas from Composio and diffs them against tools.js.
// Exit code 1 if a slug is missing or an argument name no longer matches.
import 'dotenv/config';
import { Composio } from '@composio/core';
import { EXPECTED } from './tools.js';

if (!process.env.COMPOSIO_API_KEY) { console.error('Set COMPOSIO_API_KEY'); process.exit(1); }
const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
const slugs = Object.keys(EXPECTED);

async function fetchAll() {
  const out = {};
  try {
    const list = await composio.tools.getRawComposioTools({ tools: slugs, limit: 100 });
    for (const t of list) out[t.slug] = t;
  } catch (e) { console.warn('Bulk fetch failed, trying one by one:', e.message); }
  for (const s of slugs) {
    if (out[s]) continue;
    try { out[s] = await composio.tools.getRawComposioToolBySlug(s); } catch (e) { console.warn(`  ${s}: ${e.message}`); }
  }
  return out;
}

const live = await fetchAll();
let bad = 0;
for (const slug of slugs) {
  const t = live[slug];
  if (!t) { console.log(`✗ ${slug}: not found`); bad++; continue; }
  const schema = t.inputParameters || t.input_parameters || {};
  const props = Object.keys(schema.properties || {});
  const required = schema.required || [];
  const exp = EXPECTED[slug];
  const unknown = exp.sends.filter((a) => !props.includes(a));
  const unmet = required.filter((a) => !exp.sends.includes(a));
  const ok = !unknown.length && !unmet.length;
  console.log(`${ok ? '✓' : '✗'} ${slug}\n    required: ${required.join(', ') || '-'}\n    params:   ${props.join(', ')}`);
  if (unknown.length) console.log(`    !! we send args the schema doesn't have: ${unknown.join(', ')}`);
  if (unmet.length) console.log(`    !! schema requires args we never send: ${unmet.join(', ')}`);
  if (!ok) bad++;
}
console.log(bad ? `\n${bad} mismatch(es). Update tools.js + the exec() calls in automation.js.` : '\nAll tool schemas match.');
process.exit(bad ? 1 : 0);
