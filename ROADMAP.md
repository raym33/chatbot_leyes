# 🛣️ Roadmap & ideas to improve this project

These are concrete, prioritized hints for anyone who wants to take `chatbot_leyes`
further. Contributions welcome.

## Search quality (highest impact)
- **Add a cross-encoder reranker.** Retrieve a wide candidate set (top-40) with the
  hybrid scorer, then re-rank with a model like `bge-reranker-v2-m3` for much better
  precision. Blend its score with the hybrid score + a source-authority bonus so it
  doesn't bury obvious foundational articles (e.g. a brief Constitution article losing
  to a long sectoral law). Keep it deterministic (a cross-encoder, not an LLM judge).
- **Fine-tune the embedder** on Spanish question→article pairs to close *vocabulary
  gaps* (the law often doesn't contain the doctrinal name — e.g. art. 54 ET never says
  "despido disciplinario", art. 20 CP never says "legítima defensa"). Generate the
  dataset with an LLM + hard-negative mining, then LoRA-train `bge-m3`. Make the dataset
  **targeted** at the concepts that fail, not random — and large.
- **Curated legal synonym/alias dictionary** (deterministic, no LLM noise): map common
  terms to the words the statute actually uses (`compraventa`↔`compra y venta`,
  `despido disciplinario`→`incumplimiento grave y culpable`, etc.).

## Coverage
- **Jurisprudence (case law).** Currently only legislation. CENDOJ has no public API and
  scraping is restricted — explore ECLI datasets / open judicial data and licensing.
- **Autonomous-community (regional) law**, not just state-level.
- **Track versions/dates** per article and surface "in force as of <date>"; warn on
  recently amended provisions.

## Evaluation (do this before tuning anything)
- Ship a **labeled eval set of 200+ questions** with known canonical articles, across
  legal areas, and report **Hit@k / MRR**. Without it, "improvements" are guesses.
- Beware **overfitting to a small eval**: measure on a broad, held-out set.
- Add **recall@N diagnostics** to separate retrieval misses (article not in the pool)
  from ranking misses (in the pool but mis-ordered) — they need different fixes.

## Product / UX
- **Stream tokens** to the UI (SSE) so answers feel instant instead of waiting ~minutes
  on CPU.
- **Document drafting** assist (demands, contracts) grounded in cited clauses.
- **Conversation memory** / follow-up questions over the same retrieved context.
- **Highlight the exact passage** inside each cited article.
- **Multi-tenant accounts** (firms) with auth if deployed for teams.

## Performance & deployment
- **GPU profiles** in `docker-compose.yml` for NVIDIA; document Apple Silicon (native
  Ollama via `host.docker.internal`) for Metal acceleration.
- **Parallelize ingest/embed** across workers; cache the prebuilt index as a downloadable
  artifact (release asset) so users skip the long first build.
- Offer **smaller default models** for low-end machines and a "quality" profile for GPUs.
- Consider a real **vector index (HNSW)** if scaling beyond a few hundred thousand
  articles (the current linear scan is fine up to ~hundreds of thousands).

## Engineering
- Tests + **GitHub Actions** (lint, `node --check`, a tiny ingest smoke test).
- A **prebuilt demo corpus** committed as a release so `docker compose up` is instant.
- Configurable prompt and retrieval weights via env, with a small admin page.

## Safety & correctness
- Strengthen the anti-hallucination prompt (no extrapolation to un-asked scenarios).
- Add a **confidence/abstention** signal when top scores are low.
- Always keep the **"verify with the official source"** design — never present answers
  as legal advice.
