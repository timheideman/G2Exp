# LiveCaption for Even Realities G2

Real-time speech-to-text with speaker identification, displayed on G2 smart glasses. Built for the deaf and hard of hearing.

## How It Works

```
G2 mic (16kHz PCM) → Phone WebView → WebSocket → Server → Deepgram Nova-3 → Glasses display
                                                     │
                                                     └─→ Speaker-ID (VAD → embedding → resolver)
```

- **4-mic array** captures ambient speech
- **Deepgram Nova-3** provides real-time transcription with diarization
- **Stabilized captions** roll on the glasses — finalized words never reflow,
  only the live tail changes (flicker-free, the key to comfortable reading on a
  HUD). The live tail is **word-paced** so it crawls in smoothly rather than
  flashing, and the window rolls at phrase boundaries (hysteresis) instead of
  jumping mid-sentence. The browser preview adds true fade-in + smooth scroll
  (the glasses' fixed firmware font + ~3 updates/sec cap a *stepped* reveal)
- **Speaker identification** puts known names to voices for group conversations,
  with turn markers and current-speaker emphasis. Robust to Deepgram's unstable
  diarization indices (see [docs/SPEAKER_ID.md](docs/SPEAKER_ID.md))
- **Never fails silently** — an always-visible capture-state badge shows
  live / reconnecting / no-audio / error
- **Double-tap** to pause/resume, **scroll** to review conversation history

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure Deepgram
```bash
cp .env.example .env
# Edit .env with your Deepgram API key
# Get one at https://console.deepgram.com ($200 free credit)
```

### 3. Run in development
```bash
npm run dev
# Starts both the WebSocket server (port 8080) and Vite dev server (port 5173)
```

### 4. Sideload to glasses
```bash
npm run qr
# Scan the QR code with the Even App on your phone
```

## Architecture

```
src/
  server/                          (runs on your machine / VPS)
    index.ts                       — WebSocket proxy to Deepgram + speaker-ID pipeline
    speaker-identity-resolver.ts   — robust Deepgram-index → name mapping
    vad.ts                         — strips silence before embedding
    real-embedding-provider.ts     — MFCC voice embedding (default, +CMVN)
    onnx-embedding-provider.ts     — opt-in neural embedder (WeSpeaker ECAPA)
    kaldi-fbank.ts                 — Kaldi-spec fbank frontend for the model
    enrollment-quality.ts          — quality gate for enrollment audio
  glass/                           (the Even Hub web app — runs in the phone WebView)
    app.ts                         — orchestration (audio, WS, display, status)
    caption-engine.ts              — stabilized caption layout core (pure, tested)
    transcript-display.ts          — adapter: engine → flat string / frame
    display-simulator.ts           — monochrome-emphasis renderer + browser preview
    display-throttle.ts            — BLE-safe newest-wins coalescing
    contact-store.ts               — on-device voiceprints (multi-sample averaging)
  types/                           — shared type definitions
  main.ts                          — companion UI entry point
```

See [docs/SPEAKER_ID.md](docs/SPEAKER_ID.md) for the speaker-identification design.

## Display Format

On the 576×288 pixel G2 display (green monochrome), captions fill the full
canvas, one speaker turn at a time:
```
[Tim] so did you want to grab lunch at
that new place near the office today
[Sarah] yeah let me check my calendar i
think i am free after two ▌
```

- `[Name]` = speaker, shown once per turn. The **current** speaker is rendered
  brighter/bold in the simulator (the only attribution channel on a monochrome
  display); known contacts show their name, unknown voices a letter.
- `▌` = the live, still-being-recognized tail.
- **The G2 firmware word-wraps to the panel edge itself** — the app emits one
  full-width line per turn and does NOT pre-wrap (pre-wrapping at a guessed char
  count was what left the right side of the lens empty).
- Latest text anchored at the bottom; oldest turns roll off the top.

> **Display constraints (verified against the SDK + on-device):** the G2 has a
> single fixed firmware font — **no size/weight/family control**, and bitmaps
> are too slow/size-capped for live captions. So "use the screen" means filling
> the full-width text container with the fixed font, not changing font size.

The caption engine (`src/glass/caption-engine.ts`) is pure and unit-tested; the
rendering/UX choices are grounded in published research on live captions for
deaf/hard-of-hearing readers on heads-up displays.

## Testing on real glasses (dev loop)

```bash
npm run dev                                   # server :8080 + Vite client :5173
npx evenhub qr --url "http://<LAN-IP>:5173"   # phone + laptop on same Wi-Fi
```
In the Even phone app → **Even Hub** tab → **Scan QR**. The app renders on the
glasses within ~1s. See `HANDOFF.md` for the full runbook and failure table.

**Dev flags / console helpers** (WebView console or URL):
- `?lat` / `__lat()` — rolling server→render latency (the controllable middle
  leg; mic→server and bridge→photons are measured separately)
- `__cadence(true)` — step the browser preview to the real ~3fps glasses cadence
  to A/B "ideal smooth" vs. "what the lens actually shows"
- `?cal` / `__cal()` + `__fit(lines, chars)` — display-fit calibration

## G2 Controls

| Input | Action |
|-------|--------|
| Double-tap | Pause/resume listening |
| Scroll up/down | Review conversation history |

## Cost

Deepgram Nova-3 Multilingual: **$0.0092/min** (~$0.55/hour)
$200 free credit = ~363 hours of transcription

## License

MIT
