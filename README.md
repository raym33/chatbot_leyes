# ⚖️ chatbot_leyes

**A local, open-source AI chatbot to ask questions about Spanish law.**
Ask in plain language; it retrieves the relevant articles of Spanish legislation and answers **citing each source**, with a link to the official text (BOE). **100% local — your questions and data never leave your machine.**

> Built for privacy: no cloud APIs, no telemetry. Ideal where confidentiality matters (e.g. law firms, RGPD/GDPR).

---

## ✨ What it does

- **Natural-language Q&A over Spanish legislation** (Constitution, Civil/Criminal/Commercial codes, Workers' Statute, Civil Procedure, data-protection law, consumer law… and optionally *all* state laws).
- **Grounded answers with citations**: the model may only use the retrieved articles and must cite each statement `[n]`. If the sources don't cover it, it says so — it won't invent articles.
- **Always shows the sources** (article + official BOE link) so a human can verify. This is a search/assistant tool, **not legal advice**.
- **Hybrid retrieval** tuned for law: keyword (BM25) + semantic (embeddings) + source-authority weighting + chapter-heading awareness + Spanish morphology — because in law the *exact term* matters as much as the meaning.

## 📦 What's inside

| File | Purpose |
|------|---------|
| `docker-compose.yml` | One-command stack: **Ollama** (local LLM + embeddings) + the app |
| `server.mjs` | HTTP server: hybrid retrieval + grounded RAG answer + web UI (pure Node, no deps) |
| `ingest.mjs` | Downloads consolidated law text from the **BOE open-data API**, split per article |
| `embed.mjs` | Embeds the corpus into a compact binary vector store (resumable) |
| `public/index.html` | Clean chat UI with a live "sources" panel |
| `entrypoint.sh` | First-boot: pulls models → ingests law → builds index → serves |

The text of Spanish laws is in the **public domain**. Jurisprudence (case law) is **not** included.

---

## 🚀 Quick start (one command)

**Requirements:** [Docker](https://docs.docker.com/get-docker/) (Desktop on macOS/Windows, Engine on Linux). That's it.

```bash
git clone https://github.com/raym33/chatbot_leyes.git
cd chatbot_leyes
docker compose up
```

Then open **http://localhost:8080**

**First boot** downloads the models (a few GB) and builds the index, so it takes a while — progress shows in the terminal and the header says "preparing…". After that it starts instantly (models and index are cached in Docker volumes / `./data`).

To stop: `Ctrl+C`, or `docker compose down`.

---

## ⚙️ Configuration (optional)

Copy `.env.example` to `.env` and tweak:

```bash
CHAT_MODEL=qwen2.5:7b-instruct   # any Ollama model; smaller = faster on CPU
EMBED_MODEL=bge-m3               # multilingual embedder (recommended for Spanish)
INGEST_ALL=0                     # 1 = ingest ALL ~4000 state laws (slow first boot)
```

- **Default corpus** = the main codes (~4,600 articles) so the first run is reasonable.
- **`INGEST_ALL=1`** = every state-level *Ley / Ley Orgánica / Real Decreto Legislativo* (~4,000 laws, hundreds of thousands of articles). Big download + long first embed.

### Performance notes
- **Linux / Windows with an NVIDIA GPU:** uncomment the `deploy.devices` block in `docker-compose.yml` for a big speedup.
- **macOS:** Docker can't use the Mac GPU (Metal), so the in-container models run on CPU (slower). For best speed on a Mac, install the native [Ollama](https://ollama.com) app and point the app at it with `OPENAI_BASE=http://host.docker.internal:11434/v1`.
- Low-end machine? Set `CHAT_MODEL=llama3.2:3b`.

---

## 🧠 How it works (RAG)

1. Your question is embedded and matched against the law corpus with **hybrid search** (BM25 + vectors), boosting foundational codes and indexing chapter/section headings (where concept names like "hurto" or "homicidio" actually live).
2. The top articles are passed to a **local LLM** with a strict prompt: *answer only from these sources, cite each claim `[n]`, don't invent, don't extrapolate.*
3. The UI renders the answer (Markdown) and lists the **cited sources** with official links.

## 🔌 API

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/api/ask` | `{ "query": "…" }` | `{ answer, sources, ms, model }` |
| `POST` | `/api/search` | `{ "query": "…", "k": 8 }` | `{ sources }` (retrieval only, no LLM) |
| `GET` | `/api/status` | — | `{ ready, articles, chatModel, embedModel }` |

---

## ⚠️ Disclaimer

Educational/research tool. It can be wrong or incomplete; **no RAG system is 100% accurate**. The cited sources are shown precisely so a qualified professional can verify. **This is not legal advice.**

## 📄 License

MIT — see [LICENSE](LICENSE). Law texts © public domain, retrieved from the [BOE](https://www.boe.es/datosabiertos/).
