# LiveCaption for Even Realities G2

Real-time speech-to-text with speaker diarization, displayed on G2 smart glasses. Built for the deaf and hard of hearing.

## How It Works

```
G2 mic (16kHz PCM) → Phone WebView → WebSocket → Server → Deepgram Nova-3 → Glasses display
```

- **4-mic array** captures ambient speech
- **Deepgram Nova-3** provides real-time transcription with speaker identification
- **Diarized captions** roll on the glasses display with speaker labels `[A]`, `[B]`, etc.
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
  server/
    index.ts          — WebSocket proxy to Deepgram (runs on your machine/VPS)
  glass/
    app.ts            — G2 glasses app (audio capture + display)
    transcript-display.ts — Rolling transcript formatter with diarization
  types/
    transcript.ts     — Shared type definitions
  main.ts             — Entry point
```

## Display Format

On the 576×288 pixel G2 display:
```
[A] Hey, did you want to grab
    lunch at that new place?
[B] Yeah, let me check my
    calendar first. ━
```

- `[A]`, `[B]` = speaker labels (auto-assigned)
- `━` = interim text (still being transcribed)
- Latest text always at the bottom, oldest scrolls off the top

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
