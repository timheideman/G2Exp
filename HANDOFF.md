# HANDOFF — G2Exp LiveCaption

Context for continuing this project in a new session. Read this, then see
`TODO.md` for the prioritized work and `docs/SPEAKER_ID.md` for the speaker
pipeline.

---

## Copy-paste prompt to start the next session

> This is **G2Exp / LiveCaption** — a live-caption app for **Even Realities G2**
> smart glasses for **deaf/hard-of-hearing** users: it transcribes nearby speech
> onto the glasses with **speaker identification** (names to voices) for group
> conversations. I'm Tim; I'm the on-glasses tester. `npm run dev` is how I run
> it. **Read `HANDOFF.md` fully before doing anything** — especially the
> "Hard-won facts" section; it has load-bearing detail. Tests + typecheck are
> green (290 tests).
>
> Architecture: an **Even Hub web app** (`src/glass/` + `src/main.ts`) in the Even
> phone WebView. Glasses = mic + 576×288 green monochrome BLE display. Phone
> streams mic PCM over **WebSocket** to a **Node server** (`src/server/`) →
> **Deepgram Nova-3** (streaming STT + diarization) + a **speaker-ID pipeline**
> (VAD → ONNX ECAPA voice embedding → matching). Voiceprints stay on-device.
>
> **The job this session: fix speaker DIARIZATION** (transcription itself is
> great). Long arc last session — here's exactly where we landed, proven with
> real audio (don't re-derive, don't trust synthetic audio — it lies):
>
> 1. **Root cause found + fixed (committed):** the ONNX embedder was silently
>    broken — `kaldi-fbank.ts` fed `[-1,1]` audio to a model trained on int16
>    scale, so every voice got a near-identical embedding (different people cosine
>    0.99). Fixed with `samples * 32768`. Different-speaker cosine is now ~0.16.
> 2. **Deepgram streaming diarization is fundamentally unreliable** for
>    back-and-forth (measured: merges overlapping speakers onto one index, lags
>    1-2 sentences on turn changes). Its better diarizer is batch-only. We can't
>    fix it at the provider.
> 3. **The decided strategy = enrolled-voiceprint matching, NOT blind
>    diarization.** Measured: blind clustering needs ~3s windows and is marginal,
>    but matching a chunk to a CLEAN ENROLLED voiceprint is **100% correct down to
>    ~1s** (right match ~0.85 vs wrong ~0.25). So: enroll known people, then every
>    ~1.5s of speech → nearest enrolled voice = the turn AND the name in one step.
>    Unknowns cluster as "Speaker A/B" (best-effort; enrolled is the reliable one).
> 4. **`EnrolledSpeakerMatcher`** (`src/server/enrolled-speaker-matcher.ts`) is now
>    **WIRED into the server (Jun 16).** It is the single speaker mechanism — it
>    replaced both `TurnSegmenter` and the `SpeakerIdentityResolver` for
>    attribution. The dead `speaker-matcher.ts` (+ 2 of its tests) is deleted. tsc
>    + 278 tests green.
>
> **DONE THIS SESSION:** wired the matcher into `index.ts` (embed each final's
> dominant-speaker audio ~1.5s → `match()` → stable client int → emit
> `speaker_identified`; `setEnrolled` on `load_voiceprints`). **Surprise finding:
> the half-split homogeneity guard is UNUSABLE for the ONNX embedder at ~750ms
> halves (measured — same- vs two-speaker half cosines fully overlap), so it was
> removed from the match path** (it had dropped every real window). Live-server
> replay of `tmp/AB_concat.wav` (`scripts/replay-ws-server.mts`): A half named
> correctly, B half separates but the seam can briefly mislabel — that's the
> on-device tuning target below.
>
> **DO THIS SESSION — on-device calibration** (the pipeline works; thresholds must
> be tuned on real glasses-mic audio, NOT clips): re-enroll far-field on the
> glasses mic; run a real back-and-forth; read the `🔀/🎤 [SpeakerMatch]` conf logs
> and tune `MATCH_MIN_MS` + the matcher `acceptThreshold` to YOUR distributions.
> Full step list in the "NEXT SESSION — on-device calibration" bullet of the
> Hard-won facts.
>
> **Critical for when I test on-device after wiring:** I must **re-enroll my
> voiceprints on the GLASSES mic in a realistic (far-field) setting** — the whole
> approach rests on enrollment matching test conditions. Old enrollments are
> useless (made by the broken embedder). Confirm `🧠 Embedding backend: ONNX
> neural` + a passing self-check on server boot.
>
> Validation discipline that paid off last session: **prove changes on my real
> audio (`tmp/*.mp3`, gitignored) BEFORE wiring; never tune thresholds on
> synthetic TTS audio.** Ask me before big/irreversible steps. The diagnostic
> scripts (`scripts/diag-diarize.mts`, `measure-voice-separation.mts`,
> `replay-resegment.mts`) are there to reuse.

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
   └─ speaker-ID: per-final dominant-speaker audio → VAD → ONNX ECAPA embedding
                  → EnrolledSpeakerMatcher (match to enrolled voice = turn + name)
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
| `src/server/index.ts` | WS proxy → Deepgram; per-final dominant-speaker audio extraction; `attributeSpeaker()` runs the matcher and emits `speaker_identified`. Deepgram config + audio coalescing live here. |
| `src/server/enrolled-speaker-matcher.ts` | **The speaker mechanism (wired Jun 16):** match a chunk to the nearest enrolled voiceprint (or a clustered unknown) → turn + name in one step. |
| `src/server/speaker-identity-resolver.ts` | (Retired from the server Jun 16; module + tests kept.) Was the Deepgram-index → name mapping (online centroids + global assignment + hysteresis). |
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
- **Smooth full-screen caption scrolling is NOT achievable on G2 today — settled
  via official docs + full SDK type defs + real third-party app code + on-device
  FPS measurements (Jun 2026).** This was investigated hard (Tim rightly pushed:
  "but danmaku apps DO slide text"). The complete answer:
  - *SDK surface:* the bridge has exactly 5 display calls
    (`createStartUpPageContainer`, `rebuildPageContainer`, `updateImageRawData`,
    `textContainerUpgrade`, `shutDownPageContainer`). Docs: *"no programmatic
    scroll position, no animations… no arbitrary pixel drawing."* No text-motion
    API; text updates are discrete whole-string replaces at the ~3/sec BLE rate.
  - *Images ARE fully supported (earlier "useless" note was WRONG).*
    `updateImageRawData` takes a standard **1-bit BMP file binary** (14-byte file
    header + 40-byte info header + 8-byte color table + bottom-up, 4-byte-aligned
    rows; bpp=1, two-color palette). Working encoder: `bigdra50/eveng2-demo`
    `src/utils/bmp.ts` (`encode1bitBmp`); other image apps: EvenChess. A 200×100
    image renders fine. NOT capped at 288 wide for a single container in practice
    (demo uses 200; ImageContainerProperty width range is 20–288 per type def, so
    full 576 width needs two side-by-side tiles).
  - *Why images can't carry smooth FULL-SCREEN motion — MEASURED:* `bigdra50`
    benchmarked GIF→BMP→`updateImageRawData` on real hardware: **50×50 px ≈ 4 FPS
    ("barely recognizable"), 30×30 px ≈ 9 FPS ("looks like it's moving")**;
    conclusion *"does not function as an animation"* at any real size. Cause:
    `updateImageRawData` SERIALIZES (must `await` each full transfer before the
    next) + BLE bandwidth. A 576×288 frame is ~33× a 50×50 → well under 1 FPS =
    slideshow, not glide.
  - *How danmaku apps (e.g. akkeylab's) actually slide text:* small SPRITES. A
    short comment is a tiny BMP, squarely in the ~9 FPS "looks like it's moving"
    regime — so sprite motion works, but a full-width live transcript is the
    worst case (full-screen redraw) and stays <1 FPS. Danmaku ≠ captions.
  - *The one genuine unknown:* the raw BLE protocol (`i-soxi/even-g2-protocol`)
    exposes a **rendering channel `0x6402`** the high-level SDK hides — apps CAN
    bypass the SDK and drive BLE directly. Whether `0x6402` has a native
    smooth-scroll opcode is UNDOCUMENTED/unproven (no public opcodes, no app found
    using it for scroll). Going there = off-SDK (submission/stability risk) and a
    reverse-engineering project. Parked.
  - *Ecosystem norm for long text:* click-to-advance pagination between pre-built
    content blocks (official `text-heavy` template AND `bigdra50` `display.ts`);
    nobody uses `contentOffset` tail-splice or animates.
  - *If scroll jolt ever needs softening (polish, parked — Tim's call):* the
    lowest-risk lever is `textContainerUpgrade` `contentOffset`/`contentLength`
    tail-splice (docs: *"faster than a full rebuild and flicker-free on
    hardware"*) — still discrete, no pixel glide, but avoids the full re-wrap.
  - *Actionable finding from this dig:* third-party docs (`even-toolkit`) state
    the panel holds **~10 text lines**, not 7 — so `LIVE_WINDOW_CHARS` (currently
    460, ≈7 lines) likely UNDER-fills the vertical space. Bumping it toward ~640
    is the real, low-risk improvement available on the supported text path.
- **BLE display update ceiling ~3/sec.** `app.ts` throttles to 300ms
  (`GLASSES_UPDATE_INTERVAL_MS`) with newest-wins coalescing. Updating faster is
  dropped/coalesced by the firmware anyway.
- **`smart_format: true` on Deepgram streaming HOLDS text** until entity
  completion / ~3s silence — it made captions appear only at sentence end. It's
  now OFF; readability comes from `punctuate` + `numerals` (no delay).
- **⚠️ THE fbank bug (fixed Jun 15) — root cause of ALL speaker-ID failure.**
  `kaldi-fbank.ts` fed normalized `[-1,1]` audio to the WeSpeaker ECAPA model,
  which (like Kaldi/torchaudio) was trained on **int16-magnitude** samples. Every
  mel energy fell below `energy_floor=1.0`, so `log(max(e,1))=0` for all bins →
  flat features → a **near-constant embedding for every voice** (different people
  scored cosine **0.99**). The embedder could not tell anyone apart — naming AND
  any acoustic approach were silently dead. Fix: `samples * 32768` before fbank
  (matches WeSpeaker `infer_onnx.py`). Verified on real recordings: different-
  speaker cosine **0.98 → 0.16**; clean separation at ≥1.5s windows. The ONNX
  self-check (`same > diff + 0.02`) was too weak to catch this — it barely passed
  on synthetic tones. **Anyone touching the embedder: re-run
  `scripts/measure-voice-separation.mts` on real two-voice audio and demand a
  clear same-vs-different gap, not just a passing self-check.**
- **Deepgram streaming diarization indices are unstable** (a speaker can flip
  index). That's why the resolver re-derives names every segment instead of
  matching once. `endpointing` gates *finals* only, not interim text.
- **Interruptions: measured Deepgram behavior** (via `scripts/diag-diarize.mts`).
  Overlapping speech → both voices collapse onto ONE index, no split ever.
  Back-to-back → it eventually splits but lags a sentence+ (new speaker's first
  words land on the prior index). `addFinalRuns` (wired) splits a final into
  per-speaker turns when Deepgram DID label the boundary at word level — kept,
  but it only helps the rare in-transcript-split case.
- **⭐ THE STRATEGY (decided Jun 15, after measuring): enrolled-voiceprint
  matching, NOT blind diarization.** Measured the fundamental limit on real
  audio (`scripts/measure-voice-separation.mts`): blind clustering (comparing two
  noisy short embeddings to each other) needs ~3s windows and is marginal. But
  matching a short chunk to a CLEAN ENROLLED voiceprint is **100% correct down to
  ~1s** (correct match cosine ~0.85 vs wrong ~0.25 — a landslide). So the plan is
  to STOP doing blind online diarization and instead: enroll the known people
  (you + regulars, **enroll far-field on the glasses mic** so it matches test
  conditions), then every ~1.5s of speech → match to nearest enrolled voice =
  the turn AND the name in one step. Unknown (unenrolled) voices cluster as
  "Speaker A/B" (best-effort; the enrolled path is the reliable one).
- **`EnrolledSpeakerMatcher`** (`src/server/enrolled-speaker-matcher.ts`): BUILT,
  proven on real audio, unit-tested, and **WIRED into `index.ts` (Jun 16).** It is
  now the single speaker mechanism — it replaced `TurnSegmenter` AND the
  `SpeakerIdentityResolver` for attribution (matching to enrolled does
  turn-detection + naming together). Defaults: acceptThreshold 0.45,
  unknownMergeThreshold 0.40.
- **✅ WIRING DONE (Jun 16).** `index.ts`: each FINAL's dominant-Deepgram-speaker
  audio is accrued to ~1.5s (`MATCH_MIN_MS`, env-overridable), VAD-trimmed,
  embedded, and `matcher.match(emb)` → `{speakerKey,name}`. `attributeSpeaker()`
  maps the string `speakerKey` → a stable small int (`clientIdForKey`) used as the
  client `speaker`/turn id; `emitNameIfChanged()` sends `speaker_identified
  {speakerIndex:<int>, name}` only when a client id's name changes. Interims ride
  the last attributed id (text flows; the next final corrects the tag).
  `load_voiceprints` → `matcher.setEnrolled(...)`. Per-speaker rings still filled
  (`fillSpeakerRings`) for `enroll_from_buffer`. The `resolver` /
  `feedSpeakerAudio` / `emitIdentityChanges` / `resolveAcousticSpeaker` paths and
  the dead `speaker-matcher.ts` (+ its `speaker-matcher.test.ts` /
  `integration.test.ts`) are GONE. 278 tests + tsc green. `turn-segmenter.ts` and
  `speaker-identity-resolver.ts` modules are kept (no longer used by the server,
  but their tests pass and the diagnostic scripts depend on turn-segmenter).
- **❌ THE HALF-SPLIT HOMOGENEITY GUARD WAS REMOVED from the match path (Jun 16) —
  it is UNUSABLE for the ONNX ECAPA embedder at this window size, measured.**
  `scripts/measure-homogeneity.mts`: same-speaker ~750ms half-window cosines
  (0.03–0.49, med 0.21) **fully overlap** two-speaker A|B half cosines (−0.16–0.29,
  med 0.08) → no threshold separates them. Wired with the guard at the default 0.5
  it dropped EVERY real window as "MIXED" (nothing got attributed). At ~750ms the
  embedding is phoneme- not speaker-dominated, so the guard's premise ("a speaker's
  two halves agree") is false. `segment-homogeneity.ts` is kept (tests + possible
  future longer-window use) but no longer called by `index.ts`. **Do NOT
  reintroduce a half-split guard at sub-~1.5s windows for this embedder** — re-run
  `measure-homogeneity.mts` first and demand a real gap. A genuine blend defense
  needs a proper diarizer (pyannote) or our own voiceprint clustering.
- **➡️ NEXT SESSION — on-device calibration of the matcher (Tim).** The pipeline
  works; the remaining tuning MUST be done on real glasses-mic audio, not clips:
  (1) **Re-enroll far-field on the glasses mic** — old enrollments are dead (broken
  embedder) AND must match test conditions. Confirm `🧠 ONNX neural` + self-check
  on boot. (2) **Watch the B-side seam.** On `AB_concat.wav` the live server names
  the A half correctly (Alice, conf ~0.71) and cleanly separates B, but the first
  ~1.5s of the *second* speaker can briefly mislabel (unknown / weak match
  ~0.56), self-correcting on the next final. Two causes: a boundary-straddle window
  (Deepgram lumps the new speaker's start onto the prior index — partially guarded
  by the reset below) and short-window enrolled matches scoring lower than the
  accept floor. (3) **Tune `MATCH_MIN_MS` and the matcher's `acceptThreshold` on
  YOUR real back-and-forth** — read the `🔀/🎤 [SpeakerMatch]` conf logs and set the
  accept floor between your real correct-match and wrong-match distributions. (4)
  Validate with `scripts/replay-ws-server.mts [--enroll]` (drives the live server
  over WS) and `scripts/replay-matcher.mts` (offline matcher logic).
- **🔴 VERIFIED on-device (Jun 18) — two real findings from a 0-contact monologue
  test (Tim solo, no voiceprints loaded). Both confirmed in source, both await a
  UX decision from Tim before any fix:**
  - **(A) `speaker_identified` is overloaded → the "✅ recognized" badge lies.**
    `emitNameIfChanged` (server) sends `type: 'speaker_identified'` for EVERY
    match — enrolled voiceprint AND blind unknown cluster alike (the cluster's
    "Speaker A/B/C" name). The client's `handleSpeakerIdentified` (main.ts:211)
    then stamps `sessionLabels` `type='identified'`, and `updateSpeakersPanel`
    (main.ts:430-436) renders that as the green `✅ recognized` badge. Result: in
    Tim's test, FOUR blind clusters of his single voice all showed "✅ recognized"
    despite zero enrolled contacts. The badge code is correct; the SERVER is
    mislabeling unenrolled clusters as identified. Fix direction (Tim to confirm):
    the server should distinguish "matched enrolled voiceprint" from "assigned an
    unknown cluster label" — e.g. an `enrolled: boolean` on the message (the
    matcher already returns it) — and the client should only show `✅ recognized`
    when `enrolled === true`; unenrolled clusters read as tentative/unknown.
  - **(B) The fragmentation (1 voice → 4 speakers) was the BLIND-CLUSTER path, and
    the thresholds are MFCC-era on an ONNX backend.** With 0 contacts the matcher
    can only blind-cluster. Tim's own voice scored unknown-cluster cosines of
    0.41–0.69 across consecutive ~1.5s windows vs `unknownMergeThreshold: 0.40`,
    so it straddled the merge line — sometimes merging, sometimes spawning a new
    "stranger" (conf=1.00). Root cause: `acceptThreshold 0.45` / `mergeThreshold
    0.40` and the "wrong~0.2, correct~0.8" code comments are from the **MFCC**
    embedder, but the running backend is **ONNX ECAPA**, whose self-check reports
    same-voice cos=0.973 / **diff-voice cos=0.745** — a totally different, higher,
    compressed scale. So `acceptThreshold 0.45` is ALSO miscalibrated for the
    enrolled path (a stranger at ~0.74 could falsely match an enrolled person).
    These thresholds need re-deriving for ONNX (the calibration bullet above).
  - **Enrollment UX is MORE complete than expected** (mapped Jun 18): mic enroll,
    retroactive `enroll_from_buffer`, persistent localStorage contacts w/
    multi-sample averaging, export/import — all WIRED + tested. Gaps are polish:
    no confidence/quality feedback, no mode-switch feedback ("matching against N
    voiceprints"), retroactive-enroll affordance is buried (only via the modal).
    Tim's steer: prioritize USABLE UX, calibrate live with a real 2nd speaker.
- **Accrual resets on a Deepgram index change between finals** (`resegDgIndex` in
  `attributeSpeaker`, added Jun 16 — Tim's call): drops the partial match buffer so
  a window won't glue two turns Deepgram itself split. Bounds cross-final straddle
  blends; does NOT fix the case where Deepgram keeps the new speaker on the OLD
  index for a beat (one window still spans two voices, mislabels ~1.5s, then
  self-corrects). That residual is the on-device tuning target above.
- **Streaming diarization is the WEAK, unimproved model.** Deepgram's next-gen
  diarizer (≈53% better) is **batch/pre-recorded only** — `diarize_model` does
  not exist on streaming; streaming has just `diarize` (on/off) + `diarize_version`.
  We still send `diarize:true` — NOT for its naming (the matcher owns that) but
  because its per-word index is the only signal we have to pick a final's DOMINANT
  speaker's audio slices to embed. Its unreliability is exactly why we re-attribute
  acoustically on top of it.
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
