# TODO — G2Exp LiveCaption

> **⚠️ AGENT INSTRUCTION:** When this file is loaded, present the TODO list to Tim before taking any action. Ask what he wants to tackle. See `HANDOFF.md` for full context.

## 🎯 NEXT SESSION — Feel-test smoothness, then optional deferred items

The caption-UX smoothness pass is **done in code** (see ✅ below). The headline
"jumpy/flashy" root causes were all fixed and verified by tests + a headless sim
driver. What's left is **Tim feel-testing it on the lens** (see the on-device
checklist in `HANDOFF.md`), then optionally the two items Tim chose to **defer**:

1. **Live sentence self-correction ("revisable tier")** — *deferred this
   session by Tim* (the other 4 fixes deliver most of the felt improvement; this
   one adds real engine complexity). Net-new work: a bounded tier between interim
   and committed so the in-progress sentence can refine before it commits
   (`REVISE_GRACE_MS≤800`, `COMMIT_AFTER_WORDS≤6`; freeze line = *committed*
   words, not DG-`is_final`; renders identically-to-committed on glasses). The
   token-id contract (`CaptionToken.key`, shipped this session) is already
   designed for it: a revised word gets a NEW key / non-append.
2. **Per-speaker horizontal tracks in the sim** — *deferred by Tim*, gated on
   diarization robustness (the name-swapping bug is unverified). Give different
   speakers different horizontal lanes for the slide-in. Revisit once diarization
   is proven robust in a real room.

Tim's original brief, verbatim (now addressed):

> "lines just suddenly jump up when we give newer ones and words just suddenly
> flash into view. We want to make this as fast as possible, as low latency as
> possible. Maybe show words sooner and earlier. Increase the rate at which we
> try to transcribe, and as we stream words we might want to correct sentences
> as they form."

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

### Caption-UX smoothness pass (this session)
Root causes of "lines jump / words flash" found via a 6-agent design workflow
(4 mechanism experts → adversarial reconciliation → synthesis), then fixed:
- [x] **Killed the display-throttle's self-perpetuating 300ms beat** — the free-
      running cadence (re-armed after every flush) was misaligned with word
      arrivals and made interims clump. Now the trailing flush fires relative to
      the last real flush and doesn't auto-re-arm; leading edge kept (first word
      instant), ≥300ms BLE floor kept. (`display-throttle.ts`)
- [x] **Server→Deepgram time-flush (`DG_SEND_MAX_WAIT_MS=30`)** — a quiet
      phrase's tail no longer waits to hit the 1600B batch; it forwards within
      ~30ms. (`server/index.ts`)
- [x] **Trim hysteresis (`TRIM_HYSTERESIS_LINES=2`) + monologue safety valve** —
      the window holds steady through normal growth and rolls only at a real
      overflow (no mid-sentence jump); a long single turn never loses its live
      tail. (`caption-engine.ts buildTurns`)
- [x] **Word-paced interim reveal (~2 words/BLE-tick)** — the live tail crawls in
      instead of flashing; finals always snap in full (never delayed). New
      `reveal-pacer.ts` (pure, clock-injectable, unit-tested); glasses-path only.
- [x] **Stable per-token identity (`CaptionToken.key`)** — a word keeps its key
      across interim re-slice and interim→final promotion, so the sim animates
      only genuinely-new words and never re-fades settled text.
- [x] **True smooth motion in the browser sim** — per-token fade-in + eased
      scroll-baseline glide, via a **self-quiescing rAF loop** (animates only
      while moving; idles to a slow blink, then to nothing — least phone compute,
      per Tim). `setMatchGlassesCadence()` A/Bs silky vs real ~3fps.
      (`display-simulator.ts`)
- [x] **`?lat` latency instrumentation** + `__lat()` / `__cadence()` console
      helpers (server→render leg; bridge→photons stays a 240fps clap test).
- [x] Corrected the misleading "flicker-free partial-update" comment — the
      glasses path is a full-content replace; a true tail-splice is a future
      on-device probe.
- [x] **229 tests** (was 209), typecheck + build + pack all clean.

### On-device milestone (prior session)
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
