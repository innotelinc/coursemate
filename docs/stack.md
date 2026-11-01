# CourseMate in the Innotel Platform Stack

**Role: LearningOps** — the course-taking agent: watch, listen, remember, decide.

Part of the [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack).
The canonical definition of the stack, its shared layers and their owners lives
there; this file records only what CourseMate does inside it.

## Owns

- frame classification and screen-type routing
- audio chunking, transcription and the per-course fact store
- decision policy: quiz answer, essay draft, note, or "ask the human"
- the persona file, the lesson store and the bounded reflection pass
- the phone-facing API: sessions, decisions, devices, push delivery

## Provides

- answer cards and essay drafts over HTTP, for any client that can show them
- a graded decision history the phone can review and correct
- a `/api/health` payload that states what is configured and what is not

## Consumes

- OmniRoute / an OpenAI-compatible gateway (vision, drafting, transcription)
- Cerulean (Authentik SSO, DNS, TLS) — optional; the server trusts a bearer token
- Cerulean Vault (secrets) — `vault://` references resolved at deploy time
- APNs for push, when an APNs provider key exists

## Explicitly does NOT own

- identity (Authentik)
- secrets (Cerulean Vault)
- DNS/TLS (Cerulean)
- screen capture (that is [coursemate-ios](https://github.com/innotelinc/coursemate-ios))
- billing (Magnate)

## Service map

| Component | Technology | Job |
| --- | --- | --- |
| server | Node.js 24, no dependencies | HTTP API, routing, push |
| brain | gateway chat + vision models | classify a frame, draft an answer |
| memory | SQLite (`node:sqlite`) | courses, decisions, lessons, devices |
| capture | iOS broadcast extension | frames and audio, uploaded from the phone |

## In the ecosystem

| Flow | Path |
| --- | --- |
| Model calls | CourseMate → OmniRoute gateway (`/v1`) → provider |
| Decisions | server → answer card → phone, optionally over APNs |
| Identity | optional bearer token, or Cerulean's Authentik in front of the API |
| Secrets | the gateway key and any APNs key live in `.env`, never in git |

## The boundary it enforces

The agent decides and drafts; it does not submit. That is a product decision,
not a missing feature: a vision-driven clicker breaks on real LMS pages, and a
wrong auto-submit on a graded test is unrecoverable.
