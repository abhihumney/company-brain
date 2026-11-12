# HANDOVER — Rulebook-F

**Updated:** 2026-11-12, end of the action-item ledger session.
**Repo:** `/Users/abhishekhumney/Deepseek/Rulebook-f`
**Remote:** `origin` = `git@github.com:abhihumney/company-brain.git` (fork) · `upstream` push URL is `no_push`

---

## 1. What this is

A fork of [supermemoryai/company-brain](https://github.com/supermemoryai/company-brain) — a Slack-native organisational agent — being rebuilt into:

> A Slack-first bot that extracts action items from internal meetings and then completes them via CLI, MCP, API, or browser automation.

Stack: Cloudflare Workers + Durable Objects (`CompanyBrainAgent`), Anthropic direct (Claude Haiku 5.5), self-hosted supermemory in Docker, Slack app "Rulebook-F".

---

## 2. Current state

| Thing | Value |
|---|---|
| `main` | action-item ledger **merged** (branch was `feat/action-item-ledger`, HEAD `89de3df`) |
| Tests | **182 pass**; only the two pre-existing load failures (`quickjs-executor.test.ts` `cloudflare:` scheme, `catalog.test.ts` missing `@repo/lib/connector-availability`) |
| Typecheck | `bun run check-types` passes |
| Dev server | `http://127.0.0.1:8788` (log `/tmp/rbf-8788-dev.log`). **Never 8787** |
| Tunnel | `https://rulebook-f.getrulebook.com` → 200 |
| Memory | `supermemory-supermemory-1`, `127.0.0.1:6767`, healthy |
| Chrome | 157.0.8103.78 on CDP `127.0.0.1:9222`; `agent-browser` 0.42.0, one daemon, attached |
| Slack | `rulebook-f.slack.com` (team `T0CFY65L84D`), bot DM `D0CG76N938C`, human `U0CGXRTUE0G` |
| Test harness | `scripts/rbk-slack-test.mjs` — drives the bot through signed Slack events, no browser |
| Ledger | contains ~11 `RBK test` rows from acceptance runs; safe to clear |

**Processes do not survive a reboot:** dev (`bun run dev -- --port 8788`), tunnel (`cloudflared tunnel run rulebook-f`), memory (`cd infra/supermemory && docker compose up -d`).

**Secrets (never commit, never print):** `.dev.vars` (600), `infra/supermemory/.env` (600).
**Anthropic key expires 2026-12-09.**

---

## 3. What shipped this session

The action-item ledger: transcript or short note in → structured commitments → owners resolved to real Slack users → stored → answered from storage. Tool-agnostic; no vendor connector or subscription.

- `src/brain/turn/action-items.ts` — DDL, store, source-level idempotence, similarity fallback, visibility, `extract_action_items` + `list_action_items`
- `src/brain/turn/slack-member-resolve.ts` — name/email/handle/id → Slack user; email and handle are authoritative, never fall through to a name
- `src/brain/slack/dm-history.ts` — prior context only when the message refers to it; ts-labelled, capped, `latest`-bounded
- `src/brain/slack/attachments.ts` — `.txt/.vtt/.srt/.md` transcript intake, wrapped as untrusted data
- `src/brain/prompt/system.ts` — `<action_items>` policy
- `scripts/rbk-slack-test.mjs` — `check`/`send`/`wait`/`history` test harness (decrypts stored Slack credentials in memory, prints only lengths)

**Verified live in Slack, with SQL evidence:** short note and transcript both store correct items; owners resolved or explicitly unassigned; bad email never mis-assigned; undecided topics excluded; re-extraction stores nothing; DM/privacy isolation; no self-mentions; status answered from the ledger; no "likely open" wording anywhere.

---

## 4. Known limitations (deferred, documented)

- **No update/complete tool** — status is write-once (`open`). Marking something done, or reassigning an owner, is the next piece.
- **Non-decision filter is title-only** — an item titled "Decide on the price increase" whose *detail* says "not decided" is accepted. Deliberate trade-off; the prompt is the primary control.
- **Literal marker false-positives** — a title containing "deferred" (e.g. "deferred revenue schedule") is rejected.
- **Slack ids vs names** — a name like "Will" can be mistaken for a user id in rare cases.
- **Google Meet** — no Meet/Drive/Calendar coverage at all. Transcript upload is the workaround.
- **Harness limitation** — synthetic user messages never reach Slack, so any flow that reads `conversations.history` needs one real message posted through the browser.
- **Reply quality wobbles** — occasional verbose or odd phrasing (e.g. "I'm not going to walk through my internal steps"), and paraphrase rather than verbatim titles in grouped answers.

---

## 5. Decisions taken

- **Tool-agnostic, no vendor dependency.** Fireflies was connected, measured (its action items are prose with no owner field), then disconnected.
- **Store in a durable table**, not Notion/Linear.
- **DM visibility restricted**: items you own, items you captured in a DM, and public items. Private-channel items need ownership.
- **Auto-extraction on a pasted message is intended**; prior conversation is background and must never trigger extraction.
- **Dedupe is per source** (Slack message ts), not per title; title similarity is a conservative fallback at 0.85 with matching due dates.
- **agent-browser is the only browser driver**, with a 7-day update rule and a mandatory `connect 9222` after any daemon restart (see `~/.dsh/AGENTS.md`).
- **Slack API harness for tests** — faster, deterministic, and it does not pollute the real DM.

---

## 6. Environment gotchas

- **Port 8787 is poisoned** (a DSH stub answers 204). Always 8788.
- **The dev server hot-reloads on every file change.** Never run an acceptance test while another agent edits the tree — this corrupted one run today.
- **agent-browser daemon restart** launches a *headless* browser unless you run `agent-browser connect 9222` and confirm the tab list shows the user's tabs.
- **Synthetic Slack events** produce harmless warnings (`thread_not_found`, `invalid_thread_ts`, `message_not_found`) because the ts has no backing message.
- **Harness `wait` returns the first bot message** — often an interim ack; read the final reply via `history`.
- **Never rename persisted identifiers**: `sm_source`/`company-brain*` values, document prefixes, `CompanyBrainAgent`, DO migration tags, container tags, cookie `brain_session`, KV keys.

---

## 7. Next three steps

1. **Update/complete tool** — `update_action_item` (status, owner, due) so items can be marked done and owners reassigned. This was deliberately out of the first slice, and it is what makes the ledger a workflow rather than a list.
2. **Meeting ingest** — a route or Slack file path that takes a real transcript from Granola/Zoom/Meet and feeds the existing extraction; today it relies on paste/upload.
3. **Google Meet connector** — none exists; needs Drive/Meet API work.

---

## 8. Kickoff block for the next session

> Continue Rulebook-F. Repo is `/Users/abhishekhumney/Deepseek/Rulebook-f`, branch `main`, action-item ledger merged, 182 tests passing.
>
> Read `HANDOVER.md` first — state, decisions, known limitations and the environment gotchas.
>
> Standing rules: default to discuss-only; ask before building; delegate hands-on work to subagents; always give an ETA; verify claims with your own tool calls; never print secrets; never use port 8787; use the Slack test harness instead of the browser where possible, and run `agent-browser connect 9222` after any daemon restart.
>
> Services to check: dev server `127.0.0.1:8788`, tunnel `https://rulebook-f.getrulebook.com`, Docker `supermemory-supermemory-1`, Chrome CDP `9222`.
>
> Today's job: build the update/complete tool (HANDOVER §7 step 1) — mark items done, reassign owners, edit due dates — and prove it through `scripts/rbk-slack-test.mjs`.
>
> The Anthropic key expires 2026-12-09; flag it if we are near that.
