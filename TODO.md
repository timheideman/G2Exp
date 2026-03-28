# TODO — G2Exp LiveCaption

> **⚠️ AGENT INSTRUCTION:** When this file is loaded, present the TODO list to Tim before taking any action. Ask what he wants to tackle.

## 🟡 Should Have

### Hardware Testing
- [ ] Test full app on physical G2 glasses (even Hub dev mode + evenhub qr)
- [ ] Verify word-wrapping on actual G2 display (font metrics may differ from simulator)
- [ ] Performance profiling: audio latency end-to-end (mic → glasses display)
- [ ] Even Hub simulator testing

### Display
- [ ] "Privacy mode" quick toggle on glasses (double-tap to switch Anonymous ↔ Contacts)

## 🟢 Nice to Have

### Production
- [ ] Deploy to VPS (follow DEPLOY_PLAN.md — DNS, systemd service, Caddy config)

### Future Features
- [ ] Multi-language auto-detect (let Deepgram pick language instead of manual selection)
- [ ] Transcript history / session log (exportable)
- [ ] Companion app notification when new speaker identified
- [ ] Whisper fallback for offline/low-connectivity scenarios

## ✅ Done

### Foundation
- [x] Project scaffolding (Vite + TypeScript + vitest)
- [x] WebSocket proxy server with Deepgram integration
- [x] G2 glasses app (audio capture, display rendering, double-tap pause)
- [x] Browser fallback (mic capture, display simulator, settings panel)
- [x] Speaker diarization (Deepgram Nova-3, 3 speakers tested successfully)
- [x] Word-wrapping on display simulator
- [x] Privacy-first architecture (ContactStore, SessionLabels, mode toggle)
- [x] GDPR export/delete for voiceprints
- [x] Debug panel (hidden by default, show with ?debug=true or localStorage)
- [x] Settings: 13 languages, smart formatting, profanity filter
- [x] Contacts mode as default

### Speaker Identification
- [x] Real embedding provider — MFCC (512-pt FFT, 40 mel filters, 192-dim L2 embedding)
- [x] Enrollment flow — "Add Contact" modal with 15s recording + countdown
- [x] Server speaker matching pipeline — SpeakerMatcher wired, rate-limited, speaker_identified messages
- [x] Per-speaker 30s audio ring buffer — retroactive enrollment via enroll_from_buffer
- [x] "Save voice" button per speaker in session panel
- [x] Ring buffer timestamp offset fix — Deepgram timestamps correctly aligned to ring
- [x] ContactStore auto-syncs to server after enrollment (was the core recognition bug)
- [x] Match threshold tuned to 0.65 for real-world MFCC audio

### UX
- [x] Font size setting (small/medium/large) wired to display renderer
- [x] Pause indicator on glasses display (⏸ overlay top-right)
- [x] Client WebSocket auto-reconnect with exponential backoff (ReconnectScheduler)
- [x] Deepgram error handling — user-friendly messages for quota/key expiry
- [x] idMode persisted to localStorage + sent in config messages
- [x] Session-only vs recognized badge in speakers panel
- [x] Speakers panel auto-opens when first speakers detected
- [x] Contacts panel open by default
- [x] iPhone glasses mode cleanup — simulator hidden, Start/Pause hidden, hint hidden
- [x] Import contacts from JSON (file picker with merge + feedback)

### Settings & Types
- [x] applyServerIdentification() on SessionLabels — bridges server match → display
- [x] Production WS URL: wss://hostname/ws on HTTPS, ws://hostname:8080 on HTTP
- [x] Deepgram endpointing tuned for fast conversation (150ms endpoint, 1000ms utterance_end)

### Infrastructure
- [x] GitHub Actions CI — lint + test on push/PR to main/dev
- [x] VPS deployment plan written (DEPLOY_PLAN.md)
- [x] 146 tests passing across 11 test files
