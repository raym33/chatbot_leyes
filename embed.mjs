// chatbot_leyes — embed the corpus into a binary float32 store (resumable, consistent).
// Uses the OpenAI-compatible /embeddings endpoint (Ollama by default).
// Store: data/embeddings.bin (float32) + embeddings.ids.txt (1 id/line) + embeddings.meta.json

import { readFile, writeFile, readdir, appendFile, stat, truncate, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CORPUS_DIR = join(__dirname, 'corpus');
const DATA = join(__dirname, 'data');
const BIN = join(DATA, 'embeddings.bin'), IDS = join(DATA, 'embeddings.ids.txt'), META = join(DATA, 'embeddings.meta.json');
const OPENAI_BASE = process.env.OPENAI_BASE || 'http://127.0.0.1:11434/v1';
const EMBED_MODEL = process.env.EMBED_MODEL || 'bge-m3';
const BATCH = Number(process.env.EMBED_BATCH || 32);

async function embed(texts) {
  const r = await fetch(`${OPENAI_BASE}/embeddings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: EMBED_MODEL, input: texts }) });
  if (!r.ok) throw new Error(`embeddings ${r.status}: ${await r.text()}`);
  return (await r.json()).data.map((d) => d.embedding);
}
async function loadCorpus() {
  const files = (await readdir(CORPUS_DIR)).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort();
  const docs = []; for (const f of files) { for (const d of JSON.parse(await readFile(join(CORPUS_DIR, f), 'utf-8'))) docs.push(d); }
  return docs;
}

if (!existsSync(DATA)) await mkdir(DATA, { recursive: true });
const corpus = await loadCorpus();
let dim = 0;
if (existsSync(META)) { const m = JSON.parse(await readFile(META, 'utf-8')); if (m.model === EMBED_MODEL) dim = m.dim; }
let ids = existsSync(IDS) ? (await readFile(IDS, 'utf-8')).split('\n').filter(Boolean) : [];
if (dim && existsSync(BIN)) { // realign bin <-> ids after an interruption
  const rows = Math.floor((await stat(BIN)).size / (dim * 4));
  if (rows < ids.length) { ids = ids.slice(0, rows); await writeFile(IDS, ids.length ? ids.join('\n') + '\n' : ''); }
  else if (rows > ids.length) await truncate(BIN, ids.length * dim * 4);
}
const done = new Set(ids);
const pending = corpus.filter((d) => !done.has(d.id));
console.log(`Corpus ${corpus.length} · embedded ${ids.length} · pending ${pending.length}`);
if (!pending.length) { console.log('✓ Nothing to embed.'); process.exit(0); }

for (let i = 0; i < pending.length; i += BATCH) {
  const batch = pending.slice(i, i + BATCH);
  let vecs;
  try { vecs = await embed(batch.map((d) => `${d.cita} — ${d.materia}\n${d.texto}`)); }
  catch (e) { console.error(`\n⚠ batch ${i}: ${e.message}; retry in 3s`); await new Promise((r) => setTimeout(r, 3000)); i -= BATCH; continue; }
  if (!dim) { dim = vecs[0].length; await writeFile(META, JSON.stringify({ model: EMBED_MODEL, dim })); }
  const flat = new Float32Array(batch.length * dim); vecs.forEach((v, k) => flat.set(v, k * dim));
  await appendFile(BIN, Buffer.from(flat.buffer));
  await appendFile(IDS, batch.map((d) => d.id).join('\n') + '\n');
  process.stdout.write(`\r  embedded ${Math.min(i + BATCH, pending.length)}/${pending.length}`);
}
console.log(`\n✓ Binary store complete: ${done.size + pending.length} vectors, dim ${dim}.`);
