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
> full display canvas, and captions appear quickly. **209 tests pass; typecheck
> and build are clean.** Read `HANDOFF.md` and `TODO.md` first.
>
> **Focus for this session:** make the caption reading experience feel **fast and
> fluid**, not jumpy. Right now lines snap upward and words flash in. I want:
> lower latency, words shown sooner, a higher transcribe/update rate, smooth
> motion (think broadcast / Japanese-TV live captions that slide in), and the
> live sentence to visibly **correct itself as it forms** (while keeping
> finalized text stable). See the "NEXT SESSION" section of `TODO.md`. Verify
> changes against the browser simulator AND describe what to check on-device — I
> (Tim) am the on-glasses tester.

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
| `src/glass/app.ts` | Orchestration: bridge/audio/WS/display, capture-state, BLE-safe display throttle, calibration. `GLASSES_CAPTION_CONFIG` / `BROWSER_CAPTION_CONFIG` set the layout. |
| `src/glass/display-simulator.ts` | Browser canvas renderer (monochrome emphasis, pixel-wrap). The sim font is *scalable*; the real G2 font is *fixed* — don't trust the sim for absolute size. |
| `src/server/index.ts` | WS proxy → Deepgram; per-turn audio extraction; feeds the speaker pipeline. Deepgram config + audio coalescing live here. |
| `src/server/speaker-identity-resolver.ts` | Robust Deepgram-index → name mapping (online centroids + global assignment + hysteresis). |
| `src/server/vad.ts`, `enrollment-quality.ts`, `real-embedding-provider.ts`, `onnx-embedding-provider.ts`, `kaldi-fbank.ts` | Speaker-ID building blocks. See `docs/SPEAKER_ID.md`. |

## Hard-won facts about the G2 (don't re-learn these)

- **Fixed firmware font. No size/weight/family control.** Container size doesn't
  zoom it. "Bigger text" is impossible; "use the screen" = fill the full-width
  text container with the fixed font.
- **The text container word-wraps itself.** Do NOT pre-wrap — emit full-width
  lines and let the firmware wrap. (Pre-wrapping left the right side empty.)
- **Bitmaps exist but are useless for live captions** — capped at 288×144, no
  partial update, ~1.6–3s to transfer. Text container is the only path.
- **BLE display update ceiling ~3/sec.** `app.ts` throttles to 300ms
  (`GLASSES_UPDATE_INTERVAL_MS`) with newest-wins coalescing. Updating faster is
  dropped/coalesced by the firmware anyway.
- **`smart_format: true` on Deepgram streaming HOLDS text** until entity
  completion / ~3s silence — it made captions appear only at sentence end. It's
  now OFF; readability comes from `punctuate` + `numerals` (no delay).
- **Deepgram streaming diarization indices are unstable** (a speaker can flip
  index). That's why the resolver re-derives names every segment instead of
  matching once. `endpointing` gates *finals* only, not interim text.
- **Mic delivers ~10ms / ~640B PCM frames**; the server coalesces to ~50ms
  before sending to Deepgram (sending 100 msgs/sec added overhead, not speed).
- **Audio path:** `event.audioEvent.audioPcm` (normalized to Uint8Array) from
  `bridge.onEvenHubEvent`; start with `bridge.audioControl(true)`. Manifest needs
  the `g2-microphone` permission (array-of-objects shape — see `app.json`).
- **`evenhub qr` doesn't read `app.json`** (sideload), but `evenhub pack` does
  (and validates strictly). The manifest is now pack-valid.

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
- ✅ 209 tests, typecheck + build clean. Branch: `feat/caption-ux-engine`
  (PR #1 open).
- ⏳ **Next:** smooth/fluid caption motion + lower latency + live correction
  (see `TODO.md` → "NEXT SESSION").
- ⚠️ Known bug to repro: speaker name-swapping (seen once; not deterministically
  reproduced). Deprioritized vs. UX but it's the most damaging correctness issue.

## Watch-outs / how Tim works

- Tim is the **on-glasses tester** — the assistant can't see the lens. Verify in
  the browser sim, but the sim's scalable font ≠ the G2's fixed font, so describe
  exactly what to check on-device and bracket numbers when unsure.
- Don't guess display numbers and present sim screenshots as proof of on-device
  fit — that wasted a cycle. When something depends on the real font, say so and
  use the calibration ruler.
- Prefer fixing root causes over tuning magic numbers (the width gap was
  pre-wrapping, not a wrong char count).
