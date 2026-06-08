// chatbot_leyes — local RAG chatbot over Spanish law.
// 100% local: talks to an OpenAI-compatible backend (Ollama by default) for the LLM
// and the embedding model. No data leaves your machine.
//
// Pipeline: question -> hybrid retrieval (BM25 + vector + source authority) ->
//           LLM answers ONLY from the retrieved articles, citing each one [n].

import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const CORPUS_DIR = join(__dirname, 'corpus');
const BIN_PATH = join(__dirname, 'data', 'embeddings.bin');
const IDS_PATH = join(__dirname, 'data', 'embeddings.ids.txt');
const META_PATH = join(__dirname, 'data', 'embeddings.meta.json');

const PORT = process.env.PORT || 8080;
const OPENAI_BASE = process.env.OPENAI_BASE || 'http://127.0.0.1:11434/v1'; // Ollama by default
const CHAT_MODEL = process.env.CHAT_MODEL || 'qwen2.5:7b-instruct';
const EMBED_MODEL = process.env.EMBED_MODEL || 'bge-m3';
const TOP_K = Number(process.env.TOP_K || 6);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

async function embed(texts) {
  const r = await fetch(`${OPENAI_BASE}/embeddings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!r.ok) throw new Error(`embeddings ${r.status}: ${await r.text()}`);
  return (await r.json()).data.map((d) => d.embedding);
}

async function chat(messages, { temperature = 0.1 } = {}) {
  const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: CHAT_MODEL, messages, temperature, stream: false }),
  });
  if (!r.ok) throw new Error(`chat ${r.status}: ${await r.text()}`);
  return (await r.json()).choices[0].message.content;
}

// --------------------------------------------------------------------------
// Index: corpus in memory + embeddings in a binary float32 store.
// --------------------------------------------------------------------------
let INDEX = [], VEC = null, DIM = 0, AUTH = null, LEX = null;

async function loadCorpus() {
  const files = (await readdir(CORPUS_DIR)).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort();
  const docs = [];
  for (const f of files) { for (const d of JSON.parse(await readFile(join(CORPUS_DIR, f), 'utf-8'))) docs.push(d); }
  return docs;
}

async function buildIndex() {
  const corpus = await loadCorpus();
  if (!corpus.length || !existsSync(META_PATH) || !existsSync(BIN_PATH) || !existsSync(IDS_PATH)) {
    console.warn('⚠ No corpus/embeddings yet. Run ingest + embed (the container does this on first boot).');
    INDEX = []; return;
  }
  DIM = JSON.parse(await readFile(META_PATH, 'utf-8')).dim;
  const buf = await readFile(BIN_PATH);
  VEC = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const ids = (await readFile(IDS_PATH, 'utf-8')).split('\n').filter(Boolean);
  const usable = Math.min(ids.length, Math.floor(VEC.length / DIM));
  const rowOf = new Map(); for (let i = 0; i < usable; i++) rowOf.set(ids[i], i);
  INDEX = [];
  for (const d of corpus) { const r = rowOf.get(d.id); if (r !== undefined) INDEX.push({ ...d, row: r }); }
  console.log(`✓ Index: ${INDEX.length}/${corpus.length} articles embedded (dim ${DIM})`);
}

function cosineRow(q, row) {
  const base = row * DIM; let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < DIM; i++) { const a = q[i], b = VEC[base + i]; dot += a * b; na += a * a; nb += b * b; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

// --------------------------------------------------------------------------
// Hybrid retrieval: BM25 (inverted index) + vector + source-authority weight.
// In law, exact terms matter as much as meaning, so we combine both.
// --------------------------------------------------------------------------
const STOP = new Set('de la el en y a los las del que se un una por con no para es su al lo como mas o pero sus le ya este si porque esta entre cuando muy sin sobre tambien me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto entonces cual sea cualquier'.split(' '));
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function stem(t) {
  if (t.length > 6 && t.endsWith('ciones')) return t.slice(0, -5) + 'on';
  if (t.length > 5 && t.endsWith('es') && /[lrndj]es$/.test(t)) return t.slice(0, -2);
  if (t.length > 4 && t.endsWith('s')) return t.slice(0, -1);
  return t;
}
const SYN = { compraventa: ['compra', 'venta'], nulidad: ['nulo'], nulo: ['nulidad'], mayoria: ['mayor'], arrendamiento: ['alquiler'], alquiler: ['arrendamiento'], disciplinario: ['incumplimiento'] };
const tokenize = (s) => {
  const base = (norm(s).match(/[a-z0-9ñ]{3,}/g) || []).filter((t) => !STOP.has(t)).map(stem);
  const out = []; for (const t of base) { out.push(t); if (Object.hasOwn(SYN, t)) for (const e of SYN[t]) out.push(e); }
  return out;
};

const CANON = new Set(['CE', 'CC', 'CP', 'CCom', 'ET', 'LEC', 'LAU', 'LGT', 'LGSS', 'LPACAP', 'LRJSP', 'LJCA', 'LRJS', 'LO 3/2018', 'RDLeg 1/2007']);
function buildIndexes() {
  const N = INDEX.length; if (!N) return;
  AUTH = new Float64Array(N);
  const inv = new Map(), df = new Map(), len = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const d = INDEX[i];
    let w = 1;
    if (CANON.has(d.materia)) w *= 1.8; else if (d.rango === 'Ley Orgánica') w *= 1.15; else if (d.rango === 'Real Decreto Legislativo') w *= 1.1;
    w *= /^Art\.\s*\d/.test(d.cita) ? 1.2 : 0.6;
    AUTH[i] = w;
    const toks = tokenize(`${d.cita} ${d.contexto || ''} ${d.texto}`);
    len[i] = toks.length; const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, f] of tf) { let a = inv.get(t); if (!a) { a = []; inv.set(t, a); } a.push(i, f); df.set(t, (df.get(t) || 0) + 1); }
  }
  const idf = new Map(); for (const [t, n] of df) idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  let tot = 0; for (let i = 0; i < N; i++) tot += len[i];
  LEX = { inv, idf, len, avgdl: tot / N || 1 };
  console.log(`✓ BM25 inverted index: ${idf.size} terms`);
}

function bm25(query) {
  const sc = new Map(); if (!LEX) return sc;
  const { inv, idf, len, avgdl } = LEX, k1 = 1.5, b = 0.75;
  for (const t of new Set(tokenize(query))) {
    const a = inv.get(t); if (!a) continue; const w = idf.get(t) || 0;
    for (let j = 0; j < a.length; j += 2) { const di = a[j], f = a[j + 1]; sc.set(di, (sc.get(di) || 0) + w * (f * (k1 + 1)) / (f + k1 * (1 - b + b * len[di] / avgdl))); }
  }
  return sc;
}

async function retrieve(query, k = TOP_K) {
  if (!INDEX.length) return [];
  const [qv] = await embed([query]); const n = INDEX.length;
  const vraw = new Float64Array(n); let vmn = Infinity, vmx = -Infinity;
  for (let i = 0; i < n; i++) { const v = cosineRow(qv, INDEX[i].row); vraw[i] = v; if (v < vmn) vmn = v; if (v > vmx) vmx = v; }
  const vr = (vmx - vmn) || 1;
  const bm = bm25(query); let bmx = 0; for (const v of bm.values()) if (v > bmx) bmx = v; bmx = bmx || 1;
  const scored = new Array(n);
  for (let i = 0; i < n; i++) scored[i] = { doc: INDEX[i], score: (0.6 * ((bm.get(i) || 0) / bmx) + 0.4 * ((vraw[i] - vmn) / vr)) * AUTH[i] };
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

const SYSTEM = `Eres un asistente jurídico para España. Respondes en español, con rigor.
REGLAS:
1. Responde SOLO con la información de las FUENTES proporcionadas. No uses conocimiento externo ni inventes artículos, números ni jurisprudencia.
2. Cada afirmación jurídica lleva su cita entre corchetes [n], según el número de la fuente.
3. No extrapoles a supuestos que no se preguntan salvo que la fuente lo diga literalmente.
4. Si las fuentes no bastan, dilo claramente. No sustituyes el criterio del profesional.`;

function buildMessages(query, hits) {
  const ctx = hits.map((h, i) => `[${i + 1}] ${h.doc.cita} (${h.doc.fuente})\n${h.doc.texto}`).join('\n\n');
  return [{ role: 'system', content: SYSTEM }, { role: 'user', content: `FUENTES:\n${ctx}\n\nCONSULTA:\n${query}\n\nResponde citando [n].` }];
}

const sources = (hits) => hits.map((h, i) => ({ n: i + 1, cita: h.doc.cita, fuente: h.doc.fuente, url: h.doc.url, score: Number(h.score.toFixed(3)) }));

async function readBody(req) { let b = ''; for await (const c of req) b += c; return b ? JSON.parse(b) : {}; }
const sendJSON = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

async function handleAsk(req, res) {
  const { query } = await readBody(req);
  if (!query || !query.trim()) return sendJSON(res, 400, { error: 'Empty query' });
  if (!INDEX.length) return sendJSON(res, 503, { error: 'Index not ready (still ingesting/embedding on first boot)' });
  const t0 = Date.now();
  const hits = await retrieve(query);
  const answer = await chat(buildMessages(query, hits));
  sendJSON(res, 200, { answer, sources: sources(hits), ms: Date.now() - t0, model: CHAT_MODEL });
}

async function handleSearch(req, res) {
  const { query, k } = await readBody(req);
  if (!query) return sendJSON(res, 400, { error: 'Empty query' });
  const hits = await retrieve(query, Math.min(Number(k) || TOP_K, 20));
  sendJSON(res, 200, { sources: sources(hits) });
}

function handleStatus(req, res) { sendJSON(res, 200, { ready: INDEX.length > 0, articles: INDEX.length, chatModel: CHAT_MODEL, embedModel: EMBED_MODEL }); }

async function serveStatic(req, res) {
  const path = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
  const file = join(PUBLIC_DIR, path);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  try { const data = await readFile(file); res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' }); res.end(data); }
  catch { res.writeHead(404); res.end('Not found'); }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/ask') return await handleAsk(req, res);
    if (req.method === 'POST' && req.url === '/api/search') return await handleSearch(req, res);
    if (req.method === 'GET' && req.url === '/api/status') return handleStatus(req, res);
    return await serveStatic(req, res);
  } catch (e) { console.error(e); sendJSON(res, 500, { error: String(e.message || e) }); }
});

await buildIndex();
buildIndexes();
server.listen(PORT, () => console.log(`\n  chatbot_leyes ⚖️  http://localhost:${PORT}\n  LLM: ${CHAT_MODEL} · Embeddings: ${EMBED_MODEL} · backend: ${OPENAI_BASE}\n`));
