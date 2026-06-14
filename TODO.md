# TODO — G2Exp LiveCaption

> **⚠️ AGENT INSTRUCTION:** When this file is loaded, present the TODO list to Tim before taking any action. Ask what he wants to tackle. See `HANDOFF.md` for full context.

## 🎯 NEXT SESSION — Make the caption UX feel fast & fluid

The app now runs on real G2 glasses, fills the full canvas, and captions appear
quickly. The next goal is **making the reading experience feel smooth and
low-latency**, not jumpy. Tim's brief, verbatim:

> "lines just suddenly jump up when we give newer ones and words just suddenly
> flash into view. We want to make this as fast as possible, as low latency as
> possible. Maybe show words sooner and earlier. Increase the rate at which we
> try to transcribe, and as we stream words we might want to correct sentences
> as they form."

Concrete workstreams (pick with Tim):

1. **Smooth scroll instead of jump.** When a new line pushes content up, the
   text currently snaps. Reference: broadcast/Japanese-TV live captions where
   text slides in from the right / rolls up smoothly. On the glasses this is
   constrained (text container, no animation API, ~3 updates/sec BLE ceiling) —
   investigate what smooth motion is actually possible: character-by-character
   reveal, line-by-line roll with intermediate frames, or a marquee-style feed.
   The browser simulator can do true smooth scroll; the glasses may only
   approximate it. Decide per-target.
2. **Show words sooner / higher transcribe rate.** Interim text already streams
   (smart_format is off), but push further: are interims arriving as fast as
   Deepgram allows? Tune the client→server→DG chunking and the 300ms display
   throttle (lower it? adaptive?). Measure real mic→lens latency end to end.
3. **Live sentence correction as words form.** Today finalized words are locked
   and never rewritten (anti-flicker). Tim wants the *opposite* for the live
   tail: let the in-progress sentence visibly refine/correct as Deepgram revises
   its hypothesis. Reconcile this with the flicker research — likely: allow the
   *interim* (unlocked) region to correct freely + smoothly, keep *finalized*
   text stable. May need to widen the "live" region beyond the current tail.
4. **Re-tune anti-flicker for "fast" feel.** The current stabilization was tuned
   to NEVER move text (fatigue research). Tim's feedback says it now reads as
   "flashing/jumping." Find the balance: smooth transitions > hard stability.

## 🔴 Still needs on-device verification

- [ ] **Diarization name-swapping** — Tim saw speaker A/B names swap mid-session
      once (not reproduced deliberately yet). The SpeakerIdentityResolver has
      anti-swap logic (hysteresis, global assignment) but the tuning may let
      close voices cross. Needs a deliberate repro + a swap-specific test +
      tuning toward "rather show a letter than a wrong name." (Tim deprioritized
      vs. UX, but it's the most damaging correctness bug.)
- [ ] Confirm the capture-state badge + double-tap pause/resume work on-device.
- [ ] Speaker-ID accuracy with real voices in a real room (MFCC default).
- [ ] Name-alert (Porcupine wake word) firing on real glasses PCM framing.

## 🟡 Should Have

- [ ] **Verify + enable the ONNX neural embedder** on the VPS — download the
      WeSpeaker model, set `EMBEDDER=onnx`, and run the offline torchaudio fbank
      cross-check (see `docs/SPEAKER_ID.md`) before trusting it in production.
- [ ] Display-size calibration is wired (📐 Calibrate button in Settings +
      `__cal()`/`__fit(l,c)` console helpers) — confirm the chosen lines/chars
      feel right on Tim's unit and bake the value in as the default.
- [ ] User-adjustable line count + reveal style (DHH preference is split).

## 🟢 Nice to Have

- [ ] Deploy to VPS (`DEPLOY_PLAN.md` — DNS, systemd, Caddy).
- [ ] Multi-language auto-detect.
- [ ] Transcript history / session log (exportable).
- [ ] Non-speech cues in captions (`[laughter]`, `[music]`).
- [ ] Passive/continuous enrollment from quality-gated conversation segments.
- [ ] Whisper / on-device STT fallback for offline.
- [ ] App-submission requirements (double-tap → `shutDownPageContainer` exit;
      see the pre-flight audit) before any store upload.

## ✅ Done

### On-device milestone (this session)
- [x] App loads & runs on real G2 via `evenhub qr` sideload
- [x] **Full-canvas captions** — stopped pre-wrapping; the firmware wraps to the
      real panel width (was leaving the right side empty)
- [x] **Caption latency fixed** — `smart_format` off (it held text until
      sentence end) → `punctuate`+`numerals` for readability with no delay;
      interims stream word-by-word; mic frames coalesced to ~50ms for DG
- [x] Manifest corrected to the CLI validator (g2-microphone permission, edition,
      required fields) — `evenhub pack` succeeds
- [x] WS server binds 0.0.0.0 (LAN-reachable for QR sideload)
- [x] Fail-visible glasses init (errors surface on the lens, not a silent wedge)
- [x] On-phone display calibration (📐 Calibrate button + persisted layout)

### Caption UX engine (research-driven, for DHH readers)
- [x] Stable rolling window; finalized words don't reflow; flicker-free interim
- [x] Speaker turn labels + current-speaker emphasis (monochrome-safe)
- [x] Interim text rendered distinct from finalized; BLE-safe display throttling
- [x] Always-visible capture-state badge (anti silent-failure) + server errors

### Speaker identification
- [x] SpeakerIdentityResolver — online centroids + global 1:1 assignment +
      hysteresis (fixes lock-forever / index-flip / double-naming)
- [x] VAD strips silence before embedding; CMVN channel normalization
- [x] Multi-sample enrollment averaging; enrollment quality gates
- [x] Opt-in ONNX neural embedder (WeSpeaker ECAPA) + self-check + MFCC fallback

### Foundation
- [x] WebSocket proxy + Deepgram Nova-3; browser fallback; privacy-first storage
- [x] Enrollment (mic + session-buffer); name-alert wake word; GDPR export/delete
- [x] Settings, auto-reconnect, CI (typecheck + test), 209 tests / 17 files
