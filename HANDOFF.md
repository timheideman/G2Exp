# HANDOFF — G2Exp LiveCaption

Context for continuing this project in a new session. Read this, then see
`TODO.md` for the prioritized work and `docs/SPEAKER_ID.md` for the speaker
pipeline.

---

## Copy-paste prompt to start the next session

> This is **G2Exp / LiveCaption** — a live-caption app for **Even Realities G2**
> smart glasses, built for **deaf and hard-of-hearing** users: it transcribes
> the speech of people around the wearer and shows subtitles on the glasses,
> with **speaker identification** (putting known names to voices) for group
> conversations.
>
> Architecture: the app is an **Even Hub web app** (HTML/TS, in `src/glass/` +
> `src/main.ts`) that runs in the **Even phone app's WebView**. The glasses are
> just a mic + a 576×288 green monochrome display over BLE. The phone streams
> glasses-mic PCM over a **WebSocket** to a **Node server** (`src/server/`) which
> proxies to **Deepgram Nova-3** (streaming STT + diarization) and runs the
> **speaker-ID pipeline** (VAD → voice embedding → identity resolver). Voiceprints
> stay on-device (privacy-first). The server runs on a laptop in dev (or a VPS in
> prod); the 25MB neural-embedder model, if enabled, lives on the server only.
>
> It already **runs on real G2 hardware** via `evenhub qr` sideload, fills the
> full display canvas, and captions appear quickly. The caption-UX smoothness
> pass is **done in code** (smooth-feel fixes below); **229 tests pass;
> typecheck and build are clean.** Read `HANDOFF.md` and `TODO.md` first.
>
> **What just shipped (caption-UX smoothness, needs on-device feel-testing):**
> killed the display-throttle's self-perpetuating 300ms beat (clumping), added a
> 30ms server→Deepgram time-flush (sooner words), trim hysteresis so lines roll
> at phrase boundaries instead of jumping mid-sentence, word-paced interim reveal
> (~2 words/BLE-tick so the tail crawls instead of flashing — finals never
> delayed), true smooth fade+glide in the **browser sim only** (self-quiescing
> rAF = zero idle CPU), and `?lat` latency instrumentation. The on-glasses font
> can't animate, so the lens gets a clean *stepped* reveal, not silky motion.
> **Focus for THIS session:** feel-test those on the lens (checklist below),
> then optionally pick up the two DEFERRED items — live sentence self-correction
> (the "revisable tier") and per-speaker horizontal tracks. Verify in the sim AND
> describe what to check on-device — I (Tim) am the on-glasses tester.

---

## What this is, in one diagram

```
G2 glasses (mic + 576×288 green display)
   │  BLE
   ▼
Even phone app  →  WebView runs our web app (src/glass/*, src/main.ts)
   │  WebSocket (audio out, captions in)
   ▼
Node server (src/server/index.ts)  →  Deepgram Nova-3 (cloud STT + diarization)
   │
   └─ speaker-ID: VAD → embedding (MFCC default / ONNX opt-in) → SpeakerIdentityResolver
```

## Key files

| File | What it does |
|---|---|
| `src/glass/caption-engine.ts` | **Pure caption core** — rolling window, interim stabilization. `buildFrame()` (pixel-wrapped, for the browser sim) and `buildTurns()` (unwrapped full-width, for the glasses). Fully unit-tested. |
| `src/glass/transcript-display.ts` | Adapter over the engine. `render()` → flat string for the glasses text container (one full-width line per turn — the firmware wraps it). `renderFrame()` → structured frame for the sim. |
| `src/glass/app.ts` | Orchestration: bridge/audio/WS/display, capture-state, BLE-safe display throttle, calibration. `GLASSES_CAPTION_CONFIG` / `BROWSER_CAPTION_CONFIG` set the layout. Reveal-pacing wired here (glasses path only); `?lat` latency + `__cadence()` sim-preview helpers. |
| `src/glass/reveal-pacer.ts` | **Word-paced interim reveal** for the glasses path: crawls ~2 new interim words per BLE tick so the tail doesn't flash. Interim-only; finals snap in full. Pure + clock-injectable, unit-tested. |
| `src/glass/display-throttle.ts` | BLE-safe newest-wins coalescing (300ms). Now fires the trailing flush relative to the last real flush and does NOT self-re-arm a fresh beat (that beat was a clumping source). Leading edge kept (first word instant). |
| `src/glass/display-simulator.ts` | Browser canvas renderer. Now does **true smooth motion** (per-token fade-in keyed by `CaptionToken.key`, eased scroll-baseline glide) via a **self-quiescing rAF loop** — animates only while something moves, idles to a slow blink timer, then to *nothing* (least phone compute). `setMatchGlassesCadence(on)` A/Bs silky-vs-real-3fps. Sim font is *scalable*; the real G2 font is *fixed* — don't trust the sim for absolute size OR for the lens's update smoothness. |
| `src/server/index.ts` | WS proxy → Deepgram; per-turn audio extraction; feeds the speaker pipeline. Deepgram config + audio coalescing live here. |
| `src/server/speaker-identity-resolver.ts` | Robust Deepgram-index → name mapping (online centroids + global assignment + hysteresis). |
| `src/server/vad.ts`, `enrollment-quality.ts`, `real-embedding-provider.ts`, `onnx-embedding-provider.ts`, `kaldi-fbank.ts` | Speaker-ID building blocks. See `docs/SPEAKER_ID.md`. |

## Hard-won facts about the G2 (don't re-learn these)

- **Fixed firmware font. No size/weight/family control.** Container size doesn't
  zoom it. "Bigger text" is impossible; "use the screen" = fill the full-width
  text container with the fixed font.
- **The text container word-wraps itself, but does NOT auto-scroll.** Two
  separate facts, both measured on-device:
  - *Wrapping:* the firmware wraps to the real panel width with a proportional
    font — so a chars-per-line guess is meaningless. Do NOT pre-wrap and do NOT
    model line geometry. `buildTurns()` takes no size args and applies no
    line/char budget. (Pre-wrapping left the right side empty; the later 38-cpl
    *estimate* ran at ~half the true width and over-counted lines → "wraps too
    early / only ~5 visible lines". Both gone.)
  - *Scrolling:* when content exceeds the panel the firmware APPENDS at the
    bottom and PARKS the viewport (a scrollbar appears) — it does NOT follow the
    newest text. It renders from the TOP of what we send. So to keep captions
    auto-following we send only a rolling **~one-panel live window anchored at
    the tail** (`LIVE_WINDOW_CHARS` in `transcript-display.ts`), re-trimmed every
    render so the live tail always lands on-screen and older text rolls off the
    top. `MAX_CHARS` (1800) is the hard backstop under that. The window is
    char-based and approximate by design (proportional font) — it's "about a
    screen", not a wrap width; erring small just leaves bottom whitespace.
- **Speaker turns merge by RESOLVED tag, not Deepgram index.** `render()` joins
  consecutive turns that resolve to the same display name into one flowing
  block (tag printed once, joined by spaces — the firmware wraps it as a
  paragraph). Plus the engine relabels a turn IN PLACE when the diarizer flips
  its index mid-utterance (`updateInterim`/`addFinal` honor `isRelabel`).
  Together these fix the "new line broke my sentence the instant my name was
  assigned" bug: an index flip / rename no longer starts a new line. A genuinely
  different speaker (different resolved tag) still breaks to a new line.
- **No smooth motion / pixel animation exists — verified against the full SDK
  type defs + official docs (Jun 2026).** The bridge has exactly 5 display calls:
  `createStartUpPageContainer`, `rebuildPageContainer`, `updateImageRawData`,
  `textContainerUpgrade`, `shutDownPageContainer`. Docs state plainly: *"no
  programmatic scroll position, no animations… no arbitrary pixel drawing."* So
  the smooth right-to-left "Japanese-TV ticker" slide is NOT reproducible via the
  text system — all text motion is discrete whole-line steps on string updates,
  capped at the ~3/sec BLE rate. Two levers we are NOT yet using, if scroll
  jolt becomes a real fatigue problem (parked as polish — Tim's call):
  - **`textContainerUpgrade` tail-splice:** `contentOffset`/`contentLength` send
    only the changed tail instead of the whole string. Docs: *"faster than a full
    rebuild and flicker-free on hardware."* Our HANDOFF previously called this
    "unverified" — the official docs now confirm it. Lowest-risk way to soften
    the re-wrap jolt; still discrete, no pixel glide.
  - **Bitmap re-blit (high risk, unverified speed):** `ImageRawDataUpdate` /
    `ImageRawDataUpdateFields` is actually a FRAGMENTED + COMPRESSED transfer
    (`mapSessionId`, `mapTotalSize`, `mapFragmentIndex`, `mapFragmentPacketSize`,
    `compressMode`) — NOT the "one slow 1.6–3s full blit" the old note claimed.
    But: image width caps at 288 (HALF the 576 panel → a full-width ticker needs
    two side-by-side image containers), `updateImageRawData` forbids concurrent
    sends, and NO frame-rate figure is documented. Whether it can re-blit fast
    enough to animate is unknown and would need an on-device FPS probe before any
    bet. Pursuing it = rebuilding the caption renderer in pixels.
- **BLE display update ceiling ~3/sec.** `app.ts` throttles to 300ms
  (`GLASSES_UPDATE_INTERVAL_MS`) with newest-wins coalescing. Updating faster is
  dropped/coalesced by the firmware anyway.
- **`smart_format: true` on Deepgram streaming HOLDS text** until entity
  completion / ~3s silence — it made captions appear only at sentence end. It's
  now OFF; readability comes from `punctuate` + `numerals` (no delay).
- **Deepgram streaming diarization indices are unstable** (a speaker can flip
  index). That's why the resolver re-derives names every segment instead of
  matching once. `endpointing` gates *finals* only, not interim text.
- **Streaming diarization is the WEAK, unimproved model.** Deepgram's next-gen
  diarizer (≈53% better) is **batch/pre-recorded only** — `diarize_model` does
  not exist on streaming; streaming has just `diarize` (on/off) + `diarize_version`.
  Two failure modes: (a) a speaker flips index — handled in the caption engine by
  relabel-in-place; (b) **two similar voices in one room collapse onto ONE index**
  — Deepgram's word labels can't separate them, so the per-index audio is a blend.
- **Mixed-segment guard** (`src/server/segment-homogeneity.ts`): before embedding
  an index's accumulated audio, we split it, embed each half, and compare. If the
  halves disagree (cosine < threshold) the segment spans two voices → we DROP it
  rather than poison the voiceprint (the "speaker B is two people, then matched to
  me" bug). The threshold is **embedder-dependent and needs on-device calibration**:
  watch the `🚫 Dropped MIXED` / `📝 [FINAL] … ⚠️MULTI` server logs, read the
  half-similarity values for real same-speaker vs. two-speaker segments, and set
  `SEGMENT_MIN_HALF_SIM` (env) between those distributions. Default 0.5 is a guess.
  This stops the *wrong name*; it does NOT make Deepgram separate the voices — that
  needs a real diarizer (pyannote) or our own voiceprint-clustering diarizer.
- **Mic-AGC runs SERVER-SIDE, on the Deepgram branch only** (`index.ts` `sendAudio`
  + `MicAgc`). The ring buffer that feeds voice embeddings stays RAW — AGC
  normalizes loudness and would collapse the inter-speaker differences the
  embedder needs (it broke diarization when it briefly ran client-side on the WS
  copy). Gated by the `micAgc` config flag (glasses on, browser off — browser
  already auto-gains). `?agc=off` / `__agc(false)` disables for an A/B.
- **Mic delivers ~10ms / ~640B PCM frames**; the server coalesces to ~50ms
  before sending to Deepgram (sending 100 msgs/sec added overhead, not speed).
- **Audio path:** `event.audioEvent.audioPcm` (normalized to Uint8Array) from
  `bridge.onEvenHubEvent`; start with `bridge.audioControl(true)`. Manifest needs
  the `g2-microphone` permission (array-of-objects shape — see `app.json`).
- **`evenhub qr` doesn't read `app.json`** (sideload), but `evenhub pack` does
  (and validates strictly). The manifest is now pack-valid.
- **`textContainerUpgrade` is a FULL-content replace today** (`contentOffset:0,
  contentLength:full`). The SDK *exposes* `contentOffset`/`contentLength` for a
  true suffix-splice (send only the changed tail), but whether the firmware
  splices vs. re-wraps on a partial offset is **unverified** — an on-device probe
  (see checklist). The old "flicker-free partial-update" comment was aspirational
  and is now corrected.
- **Smoothness on the lens is fundamentally limited by the ~3/sec BLE ceiling +
  fixed font + no animation API.** True slide-in (Japanese-TV look) is *only*
  possible in the browser sim. On-glasses "smooth" = a clean *stepped* reveal
  (the reveal pacer crawls ~2 words/tick) + phrase-boundary roll. Don't promise
  silky motion on the lens; tune to the stepped reality (`__cadence(true)` in the
  sim shows what the lens will actually do).
- **Reveal pacing is interim-only and never delays finals.** A `final` clears the
  engine's interim, so finalized text always shows in full immediately. The
  pacer (`reveal-pacer.ts`) only governs the still-being-recognized tail.
- **The sim's rAF loop is self-quiescing on purpose** (Tim's "least phone
  compute" call): it runs only while a fade/glide is mid-flight, drops to a
  ~400ms blink timer when only an interim cursor remains, and to *nothing* when
  fully settled. Don't reintroduce an always-on rAF.

## Dev / test loop

```bash
npm run dev      # server :8080 (0.0.0.0) + Vite client :5173 (0.0.0.0)
npx evenhub qr --url "http://<LAPTOP-LAN-IP>:5173"   # phone + laptop same Wi-Fi
# Even phone app → Even Hub tab → Scan QR. App renders on glasses in ~1s.

npm test         # 209 tests (vitest)
npx tsc --noEmit # typecheck (also the CI gate)
npm run build    # vite production build
npx evenhub pack app.json dist -o livecaption.ehpk   # validates the manifest
```

Calibration (display fit): in the companion UI Settings → **📐 Calibrate** shows
a numbered ruler on the glasses; enter lines/chars and **Apply** (persists). Or
in the WebView console: `__cal()`, `__fit(lines, chars)`.

**On-device gotchas:** phone + laptop same Wi-Fi (no guest/AP-isolation — use a
hotspot if needed); keep the Even app foregrounded (backgrounding suspends the
WebView); re-scan the QR to force a full reload after code changes.

## Status (end of last session)

- ✅ Runs on real G2; full-canvas captions; low-latency text streaming.
- ✅ **Caption-UX smoothness pass shipped in code** (throttle-beat fix, server
  time-flush, trim hysteresis, word-paced reveal, sim fade+glide, `?lat`).
- ✅ **229 tests** (was 209), typecheck + build + pack clean. Branch:
  `feat/caption-ux-engine` (PR #1 open).
- ⏳ **Next:** feel-test the smoothness on the lens (checklist below); then the
  two DEFERRED items if wanted — live sentence self-correction ("revisable
  tier") and per-speaker horizontal tracks (gated on diarization robustness).
- ⚠️ Known bug to repro: speaker name-swapping (seen once; not deterministically
  reproduced). Deprioritized vs. UX but it's the most damaging correctness issue.

## On-device checklist for the smoothness pass (Tim — the lens-only checks)

The assistant verified all of this in code (unit tests + a headless sim driver
that proved the rAF loop self-quiesces and settled text never re-fades). These
are the lens-only feel checks it can't see:

1. **No clumping / no mid-sentence jump.** Speak a long sentence. Words should
   crawl in (a couple per ~300ms tick), not arrive in a 5-word flash. Lines
   should roll up only at a phrase boundary, not mid-word.
2. **Finals are never delayed.** When you stop speaking, the finalized sentence
   should appear complete instantly (the pacer only crawls the *live* tail).
3. **Long monologue keeps its live tail on-screen** (the trim safety valve) —
   the newest words never scroll off while you're still talking.
4. **Latency:** add `?lat` to the sideload URL (or run `__lat()` in the WebView
   console) → logs rolling server→render ms every 3s. For the full mic→photons
   number, do a 240fps clap/flash test (the bridge→lens leg is unmeasurable in
   software).
5. **Sim A/B (on the phone preview, not the lens):** `__cadence(true)` steps the
   sim to the real ~3fps glasses cadence so you can compare it against the silky
   default — this tells you what the lens *actually* does vs. the ideal.
6. **Partial-update probe (optional, gates a future BLE optimization):** does the
   firmware splice or re-wrap on `textContainerUpgrade` with `contentOffset>0`?
   And does it honor leading blank lines for a bottom-anchor reserve? Both stay
   OFF until answered on the lens.

## Watch-outs / how Tim works

- Tim is the **on-glasses tester** — the assistant can't see the lens. Verify in
  the browser sim, but the sim's scalable font ≠ the G2's fixed font, so describe
  exactly what to check on-device and bracket numbers when unsure.
- Don't guess display numbers and present sim screenshots as proof of on-device
  fit — that wasted a cycle. When something depends on the real font, say so and
  use the calibration ruler.
- Prefer fixing root causes over tuning magic numbers (the width gap was
  pre-wrapping, not a wrong char count).
