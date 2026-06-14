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
- **Stabilized captions** roll on the glasses in a fixed 3-line window — finalized
  words never reflow, only the live tail changes (flicker-free, the key to
  comfortable reading on a HUD)
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

On the 576×288 pixel G2 display (green monochrome), a stable 3-line window:
```
— [Tim] did you want to grab
        lunch at that new place
— [Sarah] yeah let me check my
          calendar ▌
```

- `— [Name]` = turn marker + speaker, shown once per turn. The **current**
  speaker is rendered brighter/bold (the only attribution channel on a
  monochrome display); known contacts show their name, unknown voices a letter
- `▌` = the live, still-being-recognized tail (rendered dimmer than finalized
  text, with a blinking cursor)
- Finalized words **never reflow** — only the live tail changes, so text doesn't
  shuffle under your eyes (the #1 cause of HUD caption fatigue)
- Latest text anchored at the bottom; oldest rolls off the top

The caption engine (`src/glass/caption-engine.ts`) is pure and unit-tested; the
rendering/UX choices are grounded in published research on live captions for
deaf/hard-of-hearing readers on heads-up displays.

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
