# 🧭 The engineering journey: building a legal RAG, step by step

A candid, beginner-friendly write-up of **how this project's retrieval went from ~16% to ~90% accuracy**, what we tried, what worked, what didn't, and the **real metrics** at each step. If you're building your first RAG chatbot or trying your first fine-tune, this is the stuff nobody tells you.

> Honesty first: every number below is from our own evaluation. Some "wins" turned out to be measurement artifacts or overfitting — we call those out, because that's the most useful part.

---

## How we measured (read this first)

We built a small **eval set of questions with a known correct article** (e.g. *"How is severance for unfair dismissal calculated?"* → `Art. 56 ET`). For each query we check whether the right article appears in the top-k retrieved results and report:

- **Hit@1 / Hit@3 / Hit@8** — is the correct article in the top 1/3/8?
- **MRR** — Mean Reciprocal Rank (rewards putting the right answer higher).

**Lesson 0 — without metrics you are guessing.** We started with 25 questions, later expanded to 50. That expansion alone exposed failures we'd been blind to. *Build the eval before you optimize.*

---

## The scoreboard (50-question eval)

| Stage | Hit@1 | Hit@3 | Hit@8 | MRR | Note |
|---|---|---|---|---|---|
| Pure vector search | — | — | low | low | "homicidio" didn't even retrieve the homicide article |
| Hybrid (BM25 + vectors) | — | — | ~baseline | — | exact legal terms matter |
| + authority + headings + stemming | 21 | 30 | **38** | 0.53 | biggest classic-IR gains |
| **Embedder: nomic → bge-m3** | 26 | 33 | **41** | 0.61 | the single biggest lever |
| + cross-encoder reranker (ensemble) | 27–30 | 41–42 | **45** | 0.68–0.71 | deterministic; hit the recall ceiling |
| Fine-tuned embedder (LoRA) | 29 | 41 | 44 | 0.70 | **≈ a wash** (see below) |

From **8/50 → 45/50 (90%) in Hit@8**. The two highest-leverage moves were *(1) a better embedding model* and *(2) a real reranker* — not prompt tweaking.

---

## What each lever actually did

### 1. Vector-only search is not enough for law
Embeddings match *meaning*, but legal queries hinge on *exact terms* (article numbers, defined concepts). Pure semantic search missed obvious matches. **Fix: hybrid search** = **BM25** (keyword, via an inverted index) + **embeddings**, scores normalized and combined.

### 2. Classic IR tricks gave the first big jump (8 → 38)
- **Source authority weighting.** With thousands of laws, foundational codes get buried under obscure regional/secondary norms. We multiply scores by a weight so the Civil/Criminal codes etc. win ties. *Relevance ≠ similarity alone.*
- **Index the chapter/section headings.** Surprise: the article punishing theft (`Art. 234 CP`) **does not contain the word "hurto"** — that word lives in the chapter title. If you only index article bodies you lose this. We attach the heading hierarchy to each article.
- **Spanish morphology (light stemming).** `"hurto"` ≠ `"hurtos"`, `"mueble"` ≠ `"muebles"`. Without normalizing plurals, recall silently drops.
- **A tiny synonym dictionary** for term mismatches (`compraventa` ↔ `compra y venta`).

### 3. The embedding model was the single biggest lever (38 → 41, and better recall)
We started with `nomic-embed-text` (84 MB, English-centric). It was **mediocre on Spanish legal text**. Switching to **`bge-m3`** (568M params, multilingual) was the biggest quality jump per hour of work. **Takeaway: before fine-tuning anything, check your embedder actually understands your language/domain.**

### 4. Reranking: choose your reranker carefully (41 → 45)
- We first tried an **LLM as a judge** (ask a 7B model to reorder candidates). It *looked* great on the 25-set… and then **overfit** — on the broader 50-set it *hurt*. It was also **non-deterministic** (±2 between identical runs).
- We replaced it with a real **cross-encoder reranker** (`bge-reranker-v2-m3`, served via `llama.cpp`). Deterministic and more accurate. Two refinements mattered:
  - **Ensemble, don't override:** blend the cross-encoder score with the hybrid score (≈0.65/0.35). The reranker sometimes *demoted* answers the hybrid nailed (e.g. constitutional rights) — the blend protects them.
  - **Authority bonus at rerank time:** the cross-encoder only judges textual relevance and preferred long sectoral laws over a 1-line Constitution article; a small bonus restores the canonical source.
- After this we hit **45/50 = exactly our recall ceiling**: the reranker can only reorder what retrieval already fetched. **To go higher you must improve *recall*, not ranking.**

### 5. Things that surprised us / didn't work
- **LLM query expansion** (rewriting the question with legal synonyms before search) **hurt recall** with a good embedder — it injected broad terms that *buried* the right article. We turned it off. (It had looked helpful only because a reranker masked the damage.)
- A throughput benchmark that said "142 embeddings/s" was a **measurement artifact** (we tested with 1-token strings). Real, long legal articles ran ~8/s. *Benchmark with realistic inputs.*
- **Apple MPS** would *hang* on long unattended embedding jobs. Reliability matters for multi-hour batch work — we moved heavy embedding to a more robust serving path.

---

## The fine-tuning experiment (and an honest verdict)

We ran the **full pipeline end-to-end, 100% locally**:

1. **Dataset generation** — for a sample of articles, an LLM wrote natural questions whose answer is that article; we mined **hard negatives** with our own search engine. Output: ~2,700 `(query, positive, negatives)` pairs (FlagEmbedding format).
2. **LoRA fine-tune** of `bge-m3` with `sentence-transformers` + `peft` on Apple Silicon (MPS). 1 epoch, train loss ≈ 0.30.
3. **Merge** the LoRA adapter into the base, **convert to GGUF**, load in the local model server.
4. **Re-embed** all ~216k articles with the fine-tuned model.
5. **Evaluate.**

**Result: basically a wash** (Hit@1 +2, MRR +0.01; Hit@3/8 −1). It did **not** close the targeted vocabulary gaps (e.g. *"despido disciplinario"* → `Art. 54 ET`, *"legítima defensa"* → `Art. 20 CP`).

**Why — the lesson:** our training set was **small and random** (877 of 216k articles). It was unlikely to contain those specific concept→article mappings, so the model learned general Spanish-legal matching but not the exact cases we wanted to fix.

**Takeaways for your first fine-tune:**
- **Fine-tuning is not magic.** A great base embedder + good retrieval beats a sloppy fine-tune.
- **Data > epochs.** If you want to fix specific failures, your dataset must *target* them. Random data teaches general behavior, not your edge cases.
- **Measure against a held-out set**, never the one you tuned on.
- **The pipeline itself is the asset.** Now that dataset→LoRA→merge→GGUF→serve→eval works, a better, larger, *targeted* dataset is the easy next iteration.
- **Hardware:** LoRA fits a 568M model on 16 GB and trains on a Mac (slow, hours). A one-off rented cloud GPU does it in minutes — often the better trade.

---

## On LLM size: should I just use the biggest model (Gemma 26B, Qwen 30B…)?

Short answer: **a bigger LLM does not improve retrieval — only generation.** Know what you're buying.

- **It does NOT raise Hit@k / recall.** In RAG the LLM doesn't search; it reads the articles *you already retrieved* and writes the answer. A 70B model **cannot cite an article that retrieval didn't fetch.** If your problem is "it can't find the law", a bigger LLM fixes *nothing* — fix embeddings/reranker.
- **It DOES help the answer quality.** We saw it directly: a 12B model **invented** a wrong claim ("despido nulo" → indemnización); a 26B model avoided it and synthesized better. Bigger models hallucinate less, follow "don't extrapolate / cite the source" better, and handle Spanish better — **with diminishing returns.**

**The costs are real:** latency (a 26–30B on CPU = minutes per answer), RAM (~16 GB for a 27B → on a 24 GB machine you must unload other models), and lower throughput.

**The sweet spot we landed on:**
1. **Prefer MoE models** (e.g. `gemma-4-26b-a4b`: 26B quality, ~4B active → fast). Best quality/latency trade — our default.
2. Otherwise a **strong 7B–14B instruct** model is usually enough for RAG, because you supply the context. 14B→30B buys little for a lot of latency.
3. **Quantization:** a big model at Q4 often follows instructions better than a small one at Q8 — but **measure it**.
4. **Fit the model to your hardware and latency budget**, not the other way around.

**How to decide (not by vibes):** evaluate *generation* with a rubric on the same questions — is it correct? does it hallucinate? does it cite properly? does it stay on-topic? — and pick the **biggest model that meets your latency budget.**

## Infrastructure & scaling lessons

- **JSON does not scale for vectors.** Storing embeddings as JSON exploded to 243 MB for 14k articles (≈3.6 GB projected for the full corpus) and was slow to parse. We switched to a **binary `float32` store**: a `.bin` of contiguous vectors + an append-only `ids.txt` kept **in lockstep**, auto-realigned on restart. Compact and instant to load.
- **Make long jobs resumable.** Ingest and embed checkpoint their progress; killing and restarting continues where it left off. Essential for multi-hour runs.
- **Incremental embedding.** Only embed new/changed articles; reuse the rest. Lets the corpus grow in batches without recomputing everything.
- **Don't run two writers on the same store** (we corrupted-risked a binary file once with two processes). One writer, always.

---

## TL;DR for someone building their first RAG
1. **Build an eval set first.** Hit@k + MRR. Expand it; small sets lie.
2. **Use hybrid retrieval** (BM25 + vectors), not vectors alone.
3. **Pick the right embedder for your language/domain** — it's the biggest lever.
4. **Add domain signals**: source authority, structural headings, morphology/synonyms.
5. **Add a *deterministic* reranker**, blended with your base score; ensemble, don't override.
6. **Diagnose misses**: is the answer *not retrieved* (recall) or *mis-ranked* (ranking)? Different fixes.
7. **Fine-tune last, with targeted data**, and only after measuring that it actually helps.
8. **Always show your sources.** No RAG is 100% correct; let a human verify.

See [`ROADMAP.md`](ROADMAP.md) for where to take it next.
