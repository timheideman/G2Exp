# TODO — G2Exp LiveCaption

> **⚠️ AGENT INSTRUCTION:** When this file is loaded, present the TODO list to Tim before taking any action. Ask what he wants to tackle.

## 🔴 Needs hardware to verify

These are built and unit-tested but should be confirmed on physical G2 glasses:

- [ ] Caption rendering on the real 576×288 display — confirm the 3-line window,
      turn markers, current-speaker brightness/bold, and interim dimming look
      right (font metrics differ from the simulator).
- [ ] BLE update throttle (~300ms) — confirm no flicker/saturation when captions
      stream fast; tune `GLASSES_UPDATE_INTERVAL_MS` if needed.
- [ ] Capture-state badge legibility on-device (live / reconnecting / error).
- [ ] End-to-end latency profiling (mic → glasses), and whether `endpointing:300`
      feels right for conversation.
- [ ] Speaker-ID accuracy with real voices in a real room (MFCC default).

## 🟡 Should Have

- [ ] **Verify + enable the ONNX neural embedder** on the VPS — download the
      WeSpeaker model, set `EMBEDDER=onnx`, and run the offline torchaudio fbank
      cross-check (see docs/SPEAKER_ID.md) before trusting it in production.
- [ ] "Privacy mode" quick toggle on glasses (double-tap variant to switch
      Anonymous ↔ Contacts).
- [ ] User-adjustable line count (2 vs 3) and scroll/reveal preference — DHH
      preference is genuinely split; customization is a near-universal ask.

## 🟢 Nice to Have

- [ ] Deploy to VPS (DEPLOY_PLAN.md — DNS, systemd, Caddy).
- [ ] Multi-language auto-detect (let Deepgram pick the language).
- [ ] Transcript history / session log (exportable).
- [ ] Non-speech cues in captions (`[laughter]`, `[music]`) — WCAG-valued.
- [ ] Passive/continuous enrollment — refine voiceprints from high-confidence,
      single-speaker, quality-gated conversation segments.
- [ ] Whisper / on-device STT fallback for offline / low-connectivity.

## ✅ Done

### Caption UX engine (research-driven, for DHH readers)
- [x] Stable rolling 3-line window; finalized words never reflow
- [x] Flicker-free interim stabilization (only the live tail mutates)
- [x] Phrase/word-boundary wrapping (never mid-word); pixel-aware in the renderer
- [x] Turn-change markers + current-speaker emphasis (monochrome-safe)
- [x] Interim text rendered distinct (dimmer) from finalized text
- [x] BLE-safe display throttling (newest-wins, ~300ms) + partial updates
- [x] Always-visible capture-state badge (anti silent-failure) + server error forwarding

### Speaker identification
- [x] SpeakerIdentityResolver — online centroids + global 1:1 assignment +
      hysteresis (fixes the lock-forever / index-flip / double-naming bugs)
- [x] VAD strips silence before every embedding
- [x] CMVN channel normalization in the MFCC provider (far-field robustness)
- [x] Multi-sample enrollment averaging (ContactStore.addOrMerge)
- [x] Enrollment quality gates (net-speech duration, SNR, silence ratio)
- [x] Opt-in ONNX neural embedder (WeSpeaker ECAPA) with self-check + MFCC fallback
- [x] Deepgram endpointing tuned to 300ms for stable diarization indices

### Earlier foundation
- [x] WebSocket proxy + Deepgram Nova-3 integration; browser fallback
- [x] Privacy-first architecture (ContactStore, SessionLabels, mode toggle); GDPR export/delete
- [x] Enrollment flow (mic + from-session-buffer); name-alert wake word (Porcupine)
- [x] Settings (13 languages, smart formatting, profanity filter, font size)
- [x] Auto-reconnect with backoff; user-friendly Deepgram error messages
- [x] CI (typecheck + test) — fixed a pre-existing tsc failure on main
- [x] 209 tests passing across 17 test files
