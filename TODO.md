# TODO — G2Exp LiveCaption

> **⚠️ AGENT INSTRUCTION:** When this file is loaded, present the TODO list to Tim before taking any action. Ask what he wants to tackle.

## 🔴 Must Have (MVP)

### Enrollment Flow
- [ ] Build "Add Contact" UI: record button → 15s voice sample → generate embedding → save to ContactStore
- [ ] Wire real embedding provider (resemblyzer or lightweight ONNX) to replace MockEmbeddingProvider
- [ ] Audio buffer capture during enrollment (reuse BrowserAudioCapture, accumulate PCM chunks)

### Speaker Matching Pipeline
- [ ] Integrate SpeakerMatcher into `src/server/index.ts` — feed per-speaker audio segments from Deepgram
- [ ] Emit identity updates to client via WebSocket (speaker index → contact name)
- [ ] Update SessionLabels automatically when match is found
- [ ] Handle speaker re-identification when Deepgram reassigns speaker indices mid-session

### Quick Enroll from Session
- [ ] "Save Speaker B as contact?" button in speakers panel
- [ ] Buffer recent audio per speaker during session for retroactive enrollment

## 🟡 Should Have

### Display & UX
- [ ] Test word-wrapping fix on actual G2 display (font metrics may differ in WebView)
- [ ] Font size setting (small/medium/large) not yet wired to display renderer
- [ ] Pause indicator on glasses display (currently only companion UI shows pause state)

### Robustness
- [ ] Auto-reconnect WebSocket on disconnect (server → client)
- [ ] Handle Deepgram API key expiry / quota exceeded gracefully
- [ ] Rate-limit voiceprint matching (don't re-match same speaker every utterance)

### Settings Sync
- [ ] Persist idMode to localStorage alongside other settings
- [ ] Send idMode to server so it knows whether to run matching pipeline

## 🟢 Nice to Have

### Privacy & GDPR
- [ ] Import contacts from JSON file (UI button + file picker)
- [ ] Voiceprint expiry UI (set per-contact auto-delete after X months)
- [ ] "Privacy mode" quick toggle on glasses (double-tap to switch Anonymous ↔ Contacts)

### Production Readiness
- [ ] Remove debug panel (or hide behind flag)
- [ ] CI pipeline (GitHub Actions: lint + test on push)
- [ ] Even Hub simulator testing
- [ ] Test on physical G2 glasses
- [ ] Performance profiling: audio latency end-to-end (mic → glasses display)

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
- [x] 84 tests passing across 8 test files
- [x] Debug panel with console interceptors
- [x] Settings: 13 languages, smart formatting, profanity filter
- [x] Contacts mode as default
