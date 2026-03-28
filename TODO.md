# TODO — G2Exp LiveCaption

> **⚠️ AGENT INSTRUCTION:** When this file is loaded, present the TODO list to Tim before taking any action. Ask what he wants to tackle.

## 🔴 Must Have (MVP)

### Wiring (built but not fully connected in app.ts)
- [ ] Wire `ReconnectScheduler` into `src/glass/app.ts` to replace the existing simple reconnect logic
- [ ] Wire `DisplaySimulator.setFontSize()` and `TranscriptDisplay.setPaused()` into `app.ts` settings change handler
- [ ] Wire `applyServerIdentification()` — handle `speaker_identified` WS message in `app.ts` → call `SessionLabels.applyServerIdentification()`
- [ ] Wire `loadVoiceprintsOnServer()` — send ContactStore voiceprints to server on connect (when in Contacts mode)
- [ ] Update WS URL in `src/main.ts` for production: use `wss://…/ws` when on HTTPS (required for VPS deploy — see DEPLOY_PLAN.md Step 2)

## 🟡 Should Have

### UI Polish
- [ ] Wire import-from-JSON button in companion UI (ContactStore has `importFromFile()` — just needs a file picker + button in `index.html`)
- [ ] Wire voiceprint expiry UI (ContactStore has `setExpiry()` / `getExpiryInfo()` — needs per-contact UI in `index.html`)
- [ ] "Privacy mode" quick toggle on glasses (double-tap to switch Anonymous ↔ Contacts)

### Hardware Testing
- [ ] Test word-wrapping on actual G2 display (font metrics may differ in WebView vs. simulator)
- [ ] Test full app on physical G2 glasses
- [ ] Performance profiling: audio latency end-to-end (mic → glasses display)
- [ ] Even Hub simulator testing

## 🟢 Nice to Have

### Future Features
- [ ] Multi-language auto-detect (let Deepgram pick language instead of manual selection)
- [ ] Transcript history / session log (exportable)
- [ ] Companion app notification when new speaker identified
- [ ] Whisper fallback for offline/low-connectivity scenarios

## ✅ Done
- [x] Project scaffolding (Vite + TypeScript + vitest)
- [x] WebSocket proxy server with Deepgram integration
- [x] G2 glasses app (audio capture, display rendering, double-tap pause)
- [x] Browser fallback (mic capture, display simulator, settings panel)
- [x] Speaker diarization (Deepgram Nova-3, 3 speakers tested successfully)
- [x] Word-wrapping on display simulator
- [x] Privacy-first architecture (ContactStore, SessionLabels, mode toggle)
- [x] GDPR export/delete for voiceprints
- [x] Debug panel with console interceptors
- [x] Settings: 13 languages, smart formatting, profanity filter
- [x] Contacts mode as default
- [x] **Enrollment flow** — "Add Contact" modal, 15s recording, countdown progress bar
- [x] **Real embedding provider** — MFCC-based (512-pt FFT, 40 mel filters, 192-dim L2 embedding)
- [x] **Server speaker matching pipeline** — SpeakerMatcher wired into server, rate-limited, speaker_identified messages
- [x] **Per-speaker 30s audio ring buffer** — retroactive enrollment via enroll_from_buffer
- [x] **"Save as Contact" from session** — 💾 button next to each speaker in panel
- [x] **Font size setting** — setFontSize() on DisplaySimulator (small/medium/large)
- [x] **Pause indicator on glasses display** — ⏸ overlay in top-right corner
- [x] **Client WebSocket auto-reconnect** — ReconnectScheduler with exponential backoff
- [x] **Deepgram error handling** — user-friendly messages for quota/key expiry errors
- [x] **idMode persistence** — saved to localStorage, sent in config messages
- [x] **SessionLabels.applyServerIdentification()** — bridge from server match → display
- [x] **GitHub Actions CI** — lint + test on push/PR to main and dev
- [x] **Debug panel flag** — isDebugEnabled() (localStorage or ?debug=true)
- [x] **ContactStore.importFromFile()** — File API, validates JSON, merges contacts
- [x] **Auto-prune expired voiceprints** — runs on ContactStore construction
- [x] **ContactStore.setExpiry() / getExpiryInfo()** — per-contact expiry management
- [x] 146 tests passing across 10 test files
- [x] VPS deployment plan written (DEPLOY_PLAN.md)
