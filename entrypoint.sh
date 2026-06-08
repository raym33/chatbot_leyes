#!/bin/sh
# First-boot orchestration: wait for Ollama, pull models, build the index, serve.
set -e
OLLAMA_HOST="${OLLAMA_HOST:-http://ollama:11434}"

echo "⏳ Waiting for Ollama at $OLLAMA_HOST ..."
until curl -sf "$OLLAMA_HOST/api/tags" >/dev/null 2>&1; do sleep 2; done
echo "✓ Ollama is up."

echo "⬇️  Pulling embedding model: $EMBED_MODEL (first run only)"
curl -s "$OLLAMA_HOST/api/pull" -d "{\"name\":\"$EMBED_MODEL\"}" >/dev/null
echo "⬇️  Pulling chat model: $CHAT_MODEL (first run only, can be several GB)"
curl -s "$OLLAMA_HOST/api/pull" -d "{\"name\":\"$CHAT_MODEL\"}" >/dev/null
echo "✓ Models ready."

if [ ! -f corpus/boe.json ]; then
  echo "📚 Ingesting Spanish law from the BOE (INGEST_ALL=$INGEST_ALL) ..."
  node ingest.mjs
fi

echo "🧠 Building embeddings index (resumable) ..."
node embed.mjs

echo "🚀 Starting chatbot_leyes on :$PORT"
exec node server.mjs
