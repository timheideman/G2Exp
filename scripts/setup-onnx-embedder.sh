#!/usr/bin/env bash
#
# setup-onnx-embedder.sh — download + verify the neural speaker-embedding model
# (WeSpeaker ECAPA-TDNN, 192-dim) and print the .env lines to enable it.
#
# Why this matters: the default embedder is MFCC (pure-TS), which is weak at
# SPEAKER identity — it's the reason similar voices get matched to the wrong
# person. The ONNX neural embedder has ~10× lower error. The code path already
# exists and self-checks at startup (falling back to MFCC if the model/frontend
# mismatch), so enabling it is just "get the model file + set two env vars".
#
# Safe to re-run: if a valid model is already present it is NOT re-downloaded.
# The model is gitignored (models/, *.onnx) so it never gets committed.
#
# Usage:  bash scripts/setup-onnx-embedder.sh
set -euo pipefail

# Resolve repo root from this script's location (works regardless of CWD).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

MODEL_DIR="${REPO_ROOT}/models"
MODEL_FILE="${MODEL_DIR}/voiceprint_ECAPA512_LM.onnx"
MODEL_URL="https://huggingface.co/Wespeaker/wespeaker-ecapa-tdnn512-LM/resolve/main/voxceleb_ECAPA512_LM.onnx"
# The published model is ~24.9 MB; treat anything under 10 MB as a failed/HTML
# download (HuggingFace serves an HTML error page with HTTP 200 in some cases).
MIN_BYTES=$((10 * 1024 * 1024))

# ── file-size helper (portable across macOS/BSD and Linux) ──────────────────
filesize() {
  if stat -f%z "$1" >/dev/null 2>&1; then stat -f%z "$1"   # BSD/macOS
  else stat -c%s "$1"; fi                                  # GNU/Linux
}

# ── validate an existing/just-downloaded model ─────────────────────────────
# Checks: exists, big enough, and starts with the ONNX protobuf magic (0x08).
# A valid serialized ONNX ModelProto begins with field 1 (ir_version) → byte 0x08.
validate_model() {
  local f="$1"
  [ -f "$f" ] || return 1
  local sz; sz="$(filesize "$f")"
  if [ "$sz" -lt "$MIN_BYTES" ]; then
    echo "   ✗ ${f} is only ${sz} bytes (< ${MIN_BYTES}) — likely an error page, not the model." >&2
    return 1
  fi
  # Magic-byte sniff: first byte of an ONNX ModelProto is 0x08. Reject an HTML
  # page (which would start with '<', 0x3c) masquerading as a download.
  local first; first="$(head -c1 "$f" | od -An -tu1 | tr -d ' ')"
  if [ "$first" != "8" ]; then
    echo "   ✗ ${f} doesn't start with the ONNX magic byte (got byte ${first}) — corrupt or wrong file." >&2
    return 1
  fi
  echo "   ✓ valid ONNX model (${sz} bytes)"
  return 0
}

echo "▶ Neural speaker-embedder setup"
echo "  repo:  ${REPO_ROOT}"
echo "  model: ${MODEL_FILE}"
echo

mkdir -p "${MODEL_DIR}"

if validate_model "${MODEL_FILE}"; then
  echo "✓ Model already present and valid — skipping download."
else
  echo "⬇ Downloading WeSpeaker ECAPA model (~25 MB)…"
  # Pick an available downloader.
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --retry-delay 2 -o "${MODEL_FILE}.part" "${MODEL_URL}"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "${MODEL_FILE}.part" "${MODEL_URL}"
  else
    echo "✗ Neither curl nor wget is installed. Install one, or download manually:" >&2
    echo "    ${MODEL_URL}" >&2
    echo "  → save it to: ${MODEL_FILE}" >&2
    exit 1
  fi
  mv "${MODEL_FILE}.part" "${MODEL_FILE}"
  if ! validate_model "${MODEL_FILE}"; then
    echo "✗ Downloaded file failed validation — not enabling ONNX. See messages above." >&2
    echo "  (Left the file in place for inspection: ${MODEL_FILE})" >&2
    exit 1
  fi
  echo "✓ Download complete and validated."
fi

# ── ensure onnxruntime-node is actually installed (it's an optionalDependency,
#    which npm may skip on platforms without a prebuilt binary) ──────────────
if [ ! -d "${REPO_ROOT}/node_modules/onnxruntime-node" ]; then
  echo
  echo "⚠ onnxruntime-node isn't installed (it's an optionalDependency)."
  echo "  Install it before starting the server:"
  echo "      npm install onnxruntime-node"
fi

cat <<EOF

──────────────────────────────────────────────────────────────────────────
Add these lines to your .env (then restart the server):

  EMBEDDER=onnx
  SPEAKER_MODEL_PATH=${MODEL_FILE}

On restart, watch the server log:
  🧠 Embedding backend: ONNX neural (…)         ← success (and a self-check line)
  ❌ ONNX embedder init/self-check failed …      ← fell back to MFCC (model/frontend mismatch)

The self-check prints  same-voice cos=… diff-voice cos…  — "same" should clearly
beat "diff". If it falls back, the server still runs on MFCC (no outage).

⚠ Re-enroll voiceprints after switching: MFCC and ONNX embeddings are NOT
  comparable, so old enrollments won't match under the new backend.
──────────────────────────────────────────────────────────────────────────
EOF
