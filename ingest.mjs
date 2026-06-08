// chatbot_leyes — ingest consolidated Spanish law from the official BOE open-data API.
// By default ingests a STARTER set of the main codes (fast first boot). Set INGEST_ALL=1
// to fetch every state-level Ley / Ley Orgánica / Real Decreto Legislativo (~4000 laws).
//
// Output: corpus/boe.json  [{ id, fuente, cita, rango, materia, contexto, url, texto }]
// The text of Spanish laws is in the public domain.

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const OUT = join(__dirname, 'corpus', 'boe.json');
const API = 'https://www.boe.es/datosabiertos/api/legislacion-consolidada';
const INGEST_ALL = process.env.INGEST_ALL === '1';

// Foundational codes (always included). Abbreviation -> BOE consolidated id.
const SEEDS = [
  { id: 'BOE-A-1978-31229', abrev: 'CE', rango: 'Constitución', titulo: 'Constitución Española' },
  { id: 'BOE-A-1889-4763', abrev: 'CC', rango: 'Real Decreto', titulo: 'Código Civil' },
  { id: 'BOE-A-1995-25444', abrev: 'CP', rango: 'Ley Orgánica', titulo: 'Código Penal (LO 10/1995)' },
  { id: 'BOE-A-2015-11430', abrev: 'ET', rango: 'Real Decreto Legislativo', titulo: 'Estatuto de los Trabajadores (RDL 2/2015)' },
  { id: 'BOE-A-2000-323', abrev: 'LEC', rango: 'Ley', titulo: 'Ley de Enjuiciamiento Civil (1/2000)' },
  { id: 'BOE-A-1994-26003', abrev: 'LAU', rango: 'Ley', titulo: 'Ley de Arrendamientos Urbanos (29/1994)' },
  { id: 'BOE-A-1885-6627', abrev: 'CCom', rango: 'Real Decreto', titulo: 'Código de Comercio' },
  { id: 'BOE-A-2018-16673', abrev: 'LO 3/2018', rango: 'Ley Orgánica', titulo: 'Protección de Datos (LOPDGDD)' },
  { id: 'BOE-A-2007-20555', abrev: 'RDLeg 1/2007', rango: 'Real Decreto Legislativo', titulo: 'Defensa de Consumidores (TRLGDCU)' },
];

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (m) => ENT[m]).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
const strip = (s) => decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const xget = async (u) => { const r = await fetch(u, { headers: { Accept: 'application/xml' } }); if (!r.ok) throw new Error(r.status); return r.text(); };
const jget = async (u) => { const r = await fetch(u, { headers: { Accept: 'application/json' } }); if (!r.ok) throw new Error(r.status); return r.json(); };

const LEVELS = { parte: 0, libro: 1, titulo: 2, capitulo: 3, seccion: 4, subseccion: 5 };
function parseLaw(xml, ley) {
  const out = [], stack = {};
  const re = /<bloque id="([^"]*)" tipo="([^"]*)"(?: titulo="([^"]*)")?>([\s\S]*?)<\/bloque>/g;
  let m;
  while ((m = re.exec(xml))) {
    const [, bid, tipo, titulo, body] = m;
    const vers = [...body.matchAll(/<version\b[^>]*>([\s\S]*?)<\/version>/g)];
    const ver = vers.length ? vers[vers.length - 1][1] : body;
    const paras = [...ver.matchAll(/<p class="([^"]*)">([\s\S]*?)<\/p>/g)];
    if (tipo === 'encabezado') {
      let level = null, num = '', tit = '';
      for (const [, cls, raw] of paras) {
        const t = strip(raw); if (!t) continue;
        let mm = cls.match(/^(parte|libro|titulo|capitulo|seccion|subseccion)_(num|tit)$/);
        if (mm) { level = mm[1]; if (mm[2] === 'tit') tit = t; else num = t; continue; }
        mm = cls.match(/^(parte|libro|titulo|capitulo|seccion|subseccion)$/);
        if (mm) { level = mm[1]; tit = t; }
      }
      if (level != null) { const lv = LEVELS[level]; stack[lv] = tit || num; for (const k of Object.keys(stack)) if (+k > lv) delete stack[k]; }
      continue;
    }
    if (tipo !== 'precepto') continue;
    let articulo = ''; const parts = [];
    for (const [, cls, raw] of paras) { const t = strip(raw); if (!t) continue; if (cls === 'articulo') articulo = t; else parts.push(t); }
    const texto = parts.join('\n');
    if (!texto || /\(suprimid|\(derogad/i.test(texto)) continue;
    const lab = (titulo || articulo).replace(/\.$/, '').trim();
    const num = lab.replace(/^art(?:[íi]culo)?\b\.?\s*/i, '').trim();
    const cita = /^\d/.test(num) ? `Art. ${num} ${ley.abrev}` : `${lab} ${ley.abrev}`;
    const contexto = Object.keys(stack).sort((a, b) => a - b).map((k) => stack[k]).join(' · ');
    out.push({ id: `${ley.id}#${bid}`, fuente: ley.titulo, cita, rango: ley.rango, materia: ley.abrev, contexto, url: `https://www.boe.es/buscar/act.php?id=${ley.id}`, texto: texto.slice(0, 3000) });
  }
  return out;
}

async function catalogue() {
  const RANGOS = { '1290': 'LO', '1300': 'Ley', '1310': 'RDLeg' };
  const leyes = []; let off = 0;
  for (;;) {
    const data = (await jget(`${API}?limit=500&offset=${off}`)).data;
    if (!data || !data.length) break;
    for (const i of data) { const rc = i.rango.codigo; if (RANGOS[rc] && i.vigencia_agotada !== 'S') leyes.push({ id: i.identificador, abrev: `${RANGOS[rc]} ${i.numero_oficial || ''}`.trim(), rango: i.rango.texto, titulo: i.titulo }); }
    off += 500; process.stdout.write(`\r  catalogue: ${off} norms, ${leyes.length} laws`); await sleep(250);
  }
  console.log();
  const ids = new Set(leyes.map((l) => l.id));
  return [...SEEDS.filter((s) => !ids.has(s.id)), ...leyes];
}

const laws = INGEST_ALL ? await catalogue() : SEEDS;
console.log(`Ingesting ${laws.length} law(s)${INGEST_ALL ? ' (full catalogue)' : ' (starter set — set INGEST_ALL=1 for all)'}`);
if (!existsSync(join(__dirname, 'corpus'))) await mkdir(join(__dirname, 'corpus'), { recursive: true });
const all = []; let done = 0;
for (const ley of laws) {
  try { all.push(...parseLaw(await xget(`${API}/id/${ley.id}/texto`), ley)); } catch (e) { /* skip */ }
  if (++done % 50 === 0 || done === laws.length) process.stdout.write(`\r  ${done}/${laws.length} laws · ${all.length} articles`);
  await sleep(120);
}
await writeFile(OUT, JSON.stringify(all));
console.log(`\n✓ ${all.length} articles written to corpus/boe.json`);
