<div align="center">

# CourseMate

[![CI](https://github.com/innotelinc/coursemate/actions/workflows/ci.yml/badge.svg)](https://github.com/innotelinc/coursemate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)


**Watch it, listen to it, answer it.**

A course-taking agent for **any course, on any screen**: it watches what is on
screen, listens to the lecture, remembers the course, and hands you a validated
answer, a note or a drafted essay in your own voice.

</div>

> **About CourseMate** — the server half of a screen-and-audio study agent: frame
> classification, transcription, course memory, decision routing and the answer
> cards the phone reads. **iOS capture:** [coursemate-ios](https://github.com/innotelinc/coursemate-ios)
> · **Landing page:** [innotelinc.github.io/coursemate](https://innotelinc.github.io/coursemate/)

---

## Why CourseMate

| Problem | CourseMate answer |
| --- | --- |
| A quiz answer has to be right on the first try. | A vision model returns typed JSON — screen kind, exact stem, options — and the answer is validated against a rubric before it becomes a card. |
| Every course lives somewhere different. | It only ever sees pixels and audio, so a web LMS, a desktop app, a PDF and a TV behave the same. |
| Answers in a generic assistant voice read as not yours. | A persona file you own, lessons learned from your corrections, and a bounded reflection pass that nudges its own voice without wandering. |
| Watching a lecture and taking notes are two jobs. | Transcript, slides and readings are distilled into per-course facts the drafts cite. |

A course-taking agent for **any course, on any screen**. It watches what you
watch, listens to what you hear, remembers the course, and decides what to do
next — answer a quiz, take notes, draft an essay, or ask for your help.

It is not tied to one platform. Coursera, Canvas, Moodle, Blackboard, Udemy, a
YouTube lecture, a PDF textbook, a Zoom call, a phone screen, a TV — the agent
only ever sees pixels and audio, so it behaves the same everywhere.

```
  screen ──┐                            ┌── answer card (you submit)
  audio  ──┼──►  watch / listen  ──► decide ──┼── essay draft
  files  ──┘         │                  │     └── notes → memory
                     └────── memory ────┘
                              ▲
                     corrections & reflection
```

## What it actually does

| Verb | How |
| --- | --- |
| **Watch** | Every changed frame is read by a vision model that returns typed JSON: what kind of screen this is, the exact question text and options, the essay prompt and its word target. |
| **Listen** | Audio is chunked and transcribed, so the lecture becomes evidence the agent can cite when it writes. |
| **Read** | Slides, transcripts and PDFs are distilled into facts and key terms stored per course. |
| **Decide** | Routes by screen type: quiz/test → a validated answer; essay prompt → a drafted essay in your voice; lecture/slide/reading → notes. |
| **Evolve** | When you mark an answer wrong and say what was right, that becomes a lesson immediately. A reflection pass reviews your corrections, rewrites its standing lessons, and nudges its own voice settings — within a bounded band so it stays coherent. |

## The boundary I built in, and why

The agent decides and drafts. **It does not submit.** Answers appear as cards you
click; essays appear as text you copy. That is deliberate:

- A vision-driven clicker breaks constantly on real LMS pages, and a wrong
  auto-submit on a graded test is unrecoverable.
- Submitting graded work as your own is academic misconduct at essentially every
  institution, and a lot of courses explicitly ban assistive tools during
  assessments. That call is yours to make knowingly — it should not be one a
  background process makes for you at 3am.

If you do want automation, `POST /api/ingest/frame` returns the decision as JSON
and `COURSEMATE_ACTION_WEBHOOK` will forward every decision to a URL of yours.
The last step is yours to wire, on purpose.

Where this is unambiguous: note-taking, lecture capture, accessibility, language
support, study prep, "explain this slide", and drafting that you then rewrite.

## Quickstart

```bash
cd coursemate
cp .env.example .env          # then set COURSEMATE_API_KEY for your gateway
npm start                     # -> http://127.0.0.1:8790
```

Open the page, type the course name (it keys the memory), press **Share screen**,
and pick the tab showing your course. Tick *also share tab audio*.

No build step, no dependencies — Node 22.5+ and its own `node:sqlite`.

## Any device

The web page captures on **desktop browsers**. Mobile needs a different door,
because neither iOS nor Android Chrome exposes screen capture to a web page:

- **iPhone / iPad** — a ReplayKit broadcast extension, started from Control
  Centre. Source in `capture/ios/`.
- **Android** — `scrcpy` plus `capture/frames-bridge.sh`, or the MediaProjection
  service in `capture/android/`.
- **TV casting** — AirPlay: run UxPlay on this host and capture its window.
  Chromecast: the phone is still the renderer, so capture the phone.
- **Anything else** — `capture/frames-bridge.sh` takes any ffmpeg input:
  a webcam, a capture card, an RTSP stream, a window.

Full matrix, commands and the honest limitations: **[capture/README.md](capture/README.md)**.

## How the memory works

SQLite in `data/coursemate.db`, one file, keyed by course label:

- `observations` — what each frame was, and the text read from it (no images by
  default; set `COURSEMATE_KEEP_FRAMES=1` to keep them)
- `transcripts` — what was said, timestamped
- `notes` — facts extracted per topic
- `decisions` — every answer, essay and note, with its confidence
- `corrections` — your verdicts
- `lessons` — what it learned, weighted, scoped (`global` / `course` / `quiz` /
  `essay` / `notes`)
- `persona_state` — accumulated voice drift, clamped to ±0.25

Ask it anything about the course and it answers from those tables, not from thin
air: *"what's likely on the midterm?"*, *"where did the professor define
entropy?"*

## Self-evolution, concretely

1. You mark an answer **wrong** and type the real one → an immediate lesson in
   the `quiz` scope, weighted high.
2. **Reflect** reviews recent decisions plus every correction and writes up to
   six new lessons — each one must be justified by that data.
3. Lessons are injected into every future prompt, ranked by weight.
4. Voice settings drift by at most ±0.15 per pass, ±0.25 total, so the persona
   adapts without becoming a different person.
5. Accuracy per screen type is fed back in: it is told to slow down where it is
   bad.

The scoreboard is real, not decorative: `GET /api/me` returns accuracy per screen
type computed from your corrections.

## Study packs

One command turns everything the agent sat through into revision material:

```bash
npm run study -- "BIOL 201 Cell Biology"     # -> data/study/biol-201-cell-biology.md
```

Or press **Study pack** in the UI to download it. The pack contains a summary,
a key-term table, 8–20 flashcards, the questions an examiner would plausibly set,
and an explicit **gaps** section listing what the material implied but never
explained — so you know what to go and read.

It degrades honestly: if the model is unreachable the export still succeeds from
the stored facts, marked `degraded`, rather than failing or inventing a summary.

## Your persona is a file

`persona.json` in the project root is the whole personality — tone, formality,
humour, how readily it hedges, how hard it commits, paragraph length, first or
third person, banned phrases, signature moves. Edit it while a session is
running; it is re-read on the next decision.

```json
{
  "name": "you",
  "voice": { "boldness": 0.7, "humor": 0.15 },
  "writing": { "banned": ["In conclusion", "delve into"] }
}
```

Anything you leave out keeps its default. Reflection may drift the numbers, but
only within ±0.25 of what *you* set, so it adapts without becoming someone else.
`GET /api/persona` shows exactly what the agent is currently using.

## Configuration

See [`.env.example`](.env.example) for every variable. The ones that matter:

| Variable | Default | Meaning |
| --- | --- | --- |
| `COURSEMATE_GATEWAY_URL` | `https://gateway.innotel.us/v1` | Any OpenAI-compatible endpoint |
| `COURSEMATE_MODEL` | `auto/best-reasoning` | Reasoning, essays, reflection |
| `COURSEMATE_VISION_MODEL` | `gemini/gemini-2.5-flash` | Must accept images |
| `COURSEMATE_STT_MODEL` | `gemini/gemini-2.5-flash` | Transcription (Whisper endpoint, else inline audio) |
| `COURSEMATE_PERSONA_FILE` | `./persona.json` | Your editable personality |
| `COURSEMATE_CONFIDENCE_FLOOR` | `0.55` | Below this, a card is flagged `needs you` |
| `COURSEMATE_MODE` | `assist` | `auto` also fires the webhook |
| `COURSEMATE_TOKEN` | — | Required if you bind `0.0.0.0` |

The API key is read from `COURSEMATE_API_KEY`, else from `COURSEMATE_KEY_FILE`
(`../.omniroute-key` by default).

**Gateways with provider allowlists.** Many hosted gateways restrict which
providers a key may use, and the `/models` list still advertises the rest. If
calls fail with `excluded by this API key's connection allowlist` or
`No active credentials for provider`, that provider is not yours to use — pick a
model your key actually reaches. `npm run live-check` tells you in one command.
Transcription is the usual casualty: if no Whisper model is reachable it falls
back to asking a multimodal model to transcribe the audio inline, which is why
the default is a model that does both.

## Design notes

- **One vision call per changed screen.** The client hashes an 8×8 grey
  thumbnail and skips near-identical frames, so a static slide costs one call,
  not one per tick.
- **Answers are validated, not trusted.** If the model returns an option index
  that was not on screen, the card is downgraded to `needs you` instead of
  guessing.
- **JSON is extracted defensively.** Models wrap JSON in prose; every reply
  goes through a brace-matching extractor.
- **Transcription filler is dropped.** Whisper emits "Thank you." on silence;
  those never enter memory.
- **Least privilege.** Binds `127.0.0.1`, refuses to run on `0.0.0.0` without a
  token (it warns loudly), and stores text rather than screenshots by default.

## API

```
POST /api/session       {course}                       -> {session_id}
POST /api/ingest/frame  {session_id, image_b64, hash}  -> {observation, decision}
POST /api/ingest/audio  {session_id, audio_b64, mime}  -> {transcript}
GET  /api/desk?session_id=                             -> {decisions}
GET  /api/me?course=                                   -> {persona, lessons, stats}
POST /api/correct       {decision_id, correct, truth}   -> {stats, totals}
POST /api/reflect       {course}                       -> {lessons, drift, assessment}
POST /api/ask           {course, question}             -> {answer}
POST /api/study         {course}                       -> {markdown, flashcards, ...}
GET  /api/persona                                      -> {path, persona}
GET  /api/health                                       -> gateway + counters
```

## Tests

```bash
npm test              # end-to-end against a local mock gateway — no network, no keys
npm run live-check    # hits the real gateway: reasoning + vision round-trip
npm run live-check -- shot.png "BIOL 201"    # ...and a real screenshot
npm run live-check -- shot.png "BIOL 201" rec.webm   # ...and real audio
```

`npm test` covers: quiz triage, answer-index validation, the lecture → notes
route, the essay route, study-pack export (including the degraded path when the
model is down), the editable persona file, transcript ingestion and filler
rejection, correction → lesson, reflection → bounded drift, the dashboard, auth,
and error paths.

`npm run live-check` proves your credentials and models actually work. Without a
screenshot it uses a synthetic image, which exercises the vision path but does
not prove the model can read a quiz — pass a real screenshot for that.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `gateway: no key` in the header | No key found. Set `COURSEMATE_API_KEY` or point `COURSEMATE_KEY_FILE` at one. |
| `404 Model not found` / `excluded by this API key's connection allowlist` | The model is advertised but your key cannot use that provider. Pick another with `npm run live-check`. |
| Frames arrive but every card says `needs you` | The vision model is not reading the screen — set `COURSEMATE_VISION_MODEL` to a vision-capable model. |
| `heard:` never appears in the log | No audio was shared, or transcription is unreachable on this key. Run `npm run live-check` to see which it is. |
| No audio | Tab audio was not shared. Re-share and tick *also share tab audio*, or press **Mic**. |
| `this browser cannot capture the screen` | Mobile browser. Use the iOS/Android paths in `capture/README.md`. |
| Every essay sounds generic | It has no material to work with — let it listen through a lecture, or ask it to take notes on the reading first. |

## Documentation

| Doc | What it covers |
| --- | --- |
| [docs/stack.md](docs/stack.md) | CourseMate's role in the Innotel Platform Stack (LearningOps) |
| [README.md#configuration](README.md) | every environment variable it reads |
| [capture/README.md](capture/README.md) | the capture contract for any client |

## License

MIT — see [LICENSE](LICENSE). No vendored upstream code.

*CourseMate — watch it, listen to it, answer it. © 2026 Darnel Hunter*

## 🏛️ Platform stack

CourseMate is the ecosystem's **LearningOps** platform in the
[**Innotel Platform Stack**](https://github.com/innotelinc/innotel-platform-stack) —
the canonical single-responsibility architecture where Authentik owns identity,
Cerulean Vault owns secrets, Cerulean owns trust, ONYX owns storage, Magnate owns
revenue, NPM Edge owns the edge, and every other platform is a business function
that consumes them. See [docs/stack.md](docs/stack.md) for this platform's
owns/consumes boundaries.
