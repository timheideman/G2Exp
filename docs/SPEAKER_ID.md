# Speaker Identification — How It Works

Putting a known **name** to each voice in a conversation, shown on the glasses
as `[Tim]` instead of `[A]`. This runs entirely server-side, in parallel with
transcription — it never blocks or delays captions.

## Pipeline

```
Deepgram diarization (anonymous index 0,1,2…)
        │  per-final word time-ranges
        ▼
Per-index audio extracted from the global ring buffer
        │
        ▼  VAD strips silence (silence is similar across all speakers)
Voice embedding   (MFCC default, or ONNX neural — see below)
        │
        ▼
SpeakerIdentityResolver
   • online per-index centroid (duration-weighted)
   • per-(index,name) leaky-decayed evidence
   • global 1:1 assignment, re-run every segment (open-set UNKNOWN)
   • display hysteresis (the shown name never flickers)
        │
        ▼  speaker_identified / speaker_unidentified (only on change)
Client maps index → name on the caption display
```

### Why the resolver, not "match once"

Deepgram's streaming diarization indices are **session-local and unstable** —
the same person can flip index mid-conversation. The resolver treats indices as
disposable *tracks* and re-derives *names* every segment, so:

- a name is **never assigned to two indices** at once (global 1:1 matching);
- when a speaker flips index, their evidence migrates and the name **follows
  them automatically**;
- a single noisy segment can't flip the shown name (hysteresis);
- a voice we're unsure about stays **`Speaker A`** rather than getting a wrong
  name — a wrong name is worse than no name for the reader.

## Enrollment quality

Enrollment (saving a voiceprint) is gated: we require enough **net (voiced)
speech**, an acceptable **SNR**, and not-mostly-silence, and reject otherwise so
a bad sample can't poison a voiceprint you'll trust for months. Re-enrolling the
same name **averages** the new sample into the existing voiceprint (multi-sample
centroids materially lower error).

## Embedding backend

| Backend | Default? | Notes |
|---|---|---|
| **MFCC** (pure-TS) | ✅ yes | No deps, deterministic, runs anywhere. With VAD + CMVN. |
| **ONNX neural** (WeSpeaker ECAPA, 192-dim) | opt-in | ~10× lower error on real far-field audio. |

### Enabling the neural embedder (on the server / VPS)

1. Install the optional runtime (already in `optionalDependencies`):
   ```bash
   npm install onnxruntime-node
   ```
2. Download the model (24.9 MB) onto the server:
   ```bash
   mkdir -p models
   curl -L -o models/voiceprint_ECAPA512_LM.onnx \
     https://huggingface.co/Wespeaker/wespeaker-ecapa-tdnn512-LM/resolve/main/voxceleb_ECAPA512_LM.onnx
   ```
3. Set environment variables:
   ```env
   EMBEDDER=onnx
   SPEAKER_MODEL_PATH=/opt/livecaption/models/voiceprint_ECAPA512_LM.onnx
   # optional overrides if a different export is used:
   # SPEAKER_MODEL_INPUT=feats
   # SPEAKER_MODEL_OUTPUT=embs
   # SPEAKER_MODEL_DIM=192
   ```
4. Restart. At startup the provider runs a **self-check** (same-voice vs
   different-voice separation). If the fbank frontend doesn't match the model —
   which would otherwise silently produce garbage — init fails and the server
   **automatically falls back to MFCC**. Watch the log line:
   ```
   🧠 Embedding backend: ONNX neural (…)        ← success
   ❌ ONNX embedder init/self-check failed …     ← fell back to MFCC
   ```

> **Re-enrollment note:** MFCC and ONNX embeddings are not comparable. Switching
> backends means re-enrolling contacts. (There's no user impact today — enroll
> after you flip the backend.)

### Verifying the frontend against the reference (recommended before trusting ONNX)

The fbank in `src/server/kaldi-fbank.ts` is pinned to the WeSpeaker /
`torchaudio.compliance.kaldi.fbank` spec (80 mel, 25/10 ms, hamming, power
spectrum, log, FFT 512, low 20 / high 8000, preemph 0.97, snip_edges, dither 0,
per-utterance CMN). To be fully confident, on a machine with Python+torchaudio:

1. Dump `torchaudio.compliance.kaldi.fbank(...)` for a test WAV with those exact
   params, apply per-utterance mean subtraction, and compare to `computeFbank()`
   on the same WAV — they should match to ~1e-3.
2. Feed your fbank into the same `.onnx` via Python ORT and compare the 192-dim
   embedding to WeSpeaker's `infer_onnx.py` — cosine should be > 0.99.

The runtime self-check catches gross mismatches; this offline check confirms
exact parity.
