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
| `main` | **`c293812`** — action-item ledger merged, pushed, level with origin |
| Feature branch | `feat/action-item-ledger` @ `ceae2dc`, kept (safe to delete) |
| Tests | **182 pass**; only two pre-existing load failures (`quickjs-executor.test.ts` `cloudflare:` scheme, `catalog.test.ts` missing `@repo/lib/connector-availability`) |
| Typecheck | `bun run check-types` passes |
| Dev server | `http://127.0.0.1:8788` (log `/tmp/rbf-8788-dev.log`). **Never 8787** |
| Tunnel | `https://rulebook-f.getrulebook.com` → 200 |
| Memory | `supermemory-supermemory-1`, `127.0.0.1:6767`, healthy |
| Chrome | 157 on CDP `127.0.0.1:9222`; `agent-browser` 0.42.0, one daemon, attached |
| Slack | `rulebook-f.slack.com` (team `T0CFY65L84D`), bot DM `D0CG76N938C`, one human `U0CGXRTUE0G` |
| Ledger | 11 rows, all `RBK test` data, all `open` — **only one user exists in the workspace** |

**Processes do not survive a reboot:** dev (`bun run dev -- --port 8788`), tunnel (`cloudflared tunnel run rulebook-f`), memory (`cd infra/supermemory && docker compose up -d`).

**Secrets (never commit, never print):** `.dev.vars` (600), `infra/supermemory/.env` (600). **Anthropic key expires 2026-12-09.**

---

## 3. Today's job: measure extraction accuracy on REAL meeting transcripts

The owner has real transcripts and wants numbers, not impressions. This is an evaluation task first — do not change the extraction code until the numbers exist and the failure modes are understood.

### How to feed a transcript
Use the harness, not the browser — deterministic and fast (~3–8 s per turn):

```bash
cd /Users/abhishekhumney/Deepseek/Rulebook-f
ts=$(node scripts/rbk-slack-test.mjs send "<transcript text>" | sed -n 's/^\[rbk\] event_ts=//p')
node scripts/rbk-slack-test.mjs wait --after "$ts" --timeout 120     # first message is usually an interim ack
node scripts/rbk-slack-test.mjs wait --after <ack_ts> --timeout 120  # then the real reply
```

Notes that will bite:
- `wait` returns the **first** bot message, often "Looking into it". Read the final reply via a second `wait` or `history`.
- Synthetic messages never reach Slack, so `conversations.history` cannot see them. Anything depending on *history* ("extract the transcript I sent above") needs one real message posted through the browser.
- `history` truncates message text; use the `wait` reply for full text.
- **Privacy:** real transcripts will be stored as ledger rows and may be saved as memories. Prefer a dedicated test channel or the DM, and clear rows afterwards (§6). Redact names when reporting results externally.

### What to measure, per transcript
Write a ground-truth list **before** running (read the transcript yourself and record the commitments). Then compare:

| Metric | Definition |
|---|---|
| Recall | extracted items present in your ground truth ÷ ground-truth items |
| Precision | extracted items you accept as real ÷ all extracted |
| Spurious | invented or non-committal items ("we discussed X") |
| Missed | real commitments not extracted |
| Owner capture | named owner matches ground truth; unresolved ones are `owner_name`-correct. **Only one human exists in the workspace**, so anyone not Abhishek *must* be `unresolved` — correct behaviour, not an error |
| Due dates | correct, inferred-but-sane, or absent where the transcript gave a date |
| Evidence | the quoted sentence actually supports the item |

Record every run in a file (e.g. `docs/accuracy-runs.md`) with transcript id, counts and a short failure list, so precision/recall is comparable across runs.

### Known failure modes to watch
- Titles containing "deferred" are rejected as non-decisions (title-only filter).
- "We didn't decide X" should be excluded and mentioned as a topic.
- A transcript over ~50 commitments needs multiple calls; the append path is untested on real data.
- Owner names that look like Slack ids ("Will") can be misread.
- Long transcripts may be truncated in turn context — check the model saw everything.

### Rules for this job
- No production changes until a baseline exists; then one change at a time, re-measured.
- Do not use customer-confidential content in pasted reports; redact when reporting externally.
- Clear the test rows when done (§6).

---

## 4. What shipped (verified)

- `src/brain/turn/action-items.ts` — ledger table, source-level idempotence (Slack message ts), similarity fallback (0.85 + matching due dates), DM visibility, `extract_action_items`, `list_action_items` (with `query`, `totalInScope`, retry hint)
- `src/brain/turn/slack-member-resolve.ts` — name/email/handle/id → Slack user; email and handle authoritative, never fall back to a name
- `src/brain/slack/dm-history.ts` — prior context only when the message refers to it
- `src/brain/slack/attachments.ts` — `.txt/.vtt/.srt/.md` intake, wrapped as untrusted data
- `src/brain/prompt/system.ts` — `<action_items>` policy
- `scripts/rbk-slack-test.mjs` — Slack API test harness (`check`/`send`/`wait`/`history`); decrypts stored Slack credentials in memory, prints only lengths

Proven live with SQL evidence: short notes and transcripts store correctly; owners resolved or explicitly unassigned; bad emails never mis-assigned; undecided topics excluded; re-extraction stores nothing; DM/public isolation; no self-mentions; status answered from the ledger.

---

## 5. Known limitations

- **No update/complete tool** — status write-once (`open`); cannot mark done or reassign.
- **No execution** — it records work; doing it (API/CLI/browser) is unbuilt.
- **Google Meet** — no connector; paste/upload only.
- **Non-decision filter is title-only** — a title containing "deferred" is wrongly rejected.
- **Reply quality wobbles** — occasional verbosity ("I'm not going to walk through my internal steps").
- **Harness limitation** — synthetic user messages are invisible to Slack history.

---

## 6. Housekeeping

- **11 test rows** in `brain_action_item`, all `RBK test`. To clear: back up the DO SQLite (`.wrangler/state/v3/do/company-brain-CompanyBrainAgent/*.sqlite`), stop the dev server (TERM), `DELETE FROM brain_action_item; DELETE FROM brain_action_item_source;`, verify 0/0 and `PRAGMA integrity_check`, restart, confirm health 200. Done three times today without issue.
- Backups kept at `/tmp/rbf-ledger-backup*`.

---

## 7. Environment gotchas

- **Port 8787 is poisoned** (a DSH stub answers 204). Always 8788.
- **The dev server hot-reloads on every file change** — never run an acceptance test while another agent edits the tree; this corrupted one run today.
- **agent-browser daemon restart** launches a headless browser unless you run `agent-browser connect 9222` and confirm the tab list shows the user's tabs.
- **Synthetic Slack events** produce harmless `thread_not_found` / `invalid_thread_ts` / `message_not_found` warnings.
- **Never rename persisted identifiers**: `sm_source`/`company-brain*` values, document prefixes, `CompanyBrainAgent`, DO migration tags, container tags, cookie `brain_session`, KV keys.

---

## 8. Kickoff block for the next session

> Continue Rulebook-F. Repo is `/Users/abhishekhumney/Deepseek/Rulebook-f`, `main` at `c293812`, ledger merged, 182 tests passing.
>
> Read `HANDOVER.md` first — especially §3, the accuracy-evaluation protocol.
>
> Standing rules: default to discuss-only; ask before building; delegate hands-on work to subagents; always give an ETA; verify claims with your own tool calls; never print secrets; never use port 8787; use `scripts/rbk-slack-test.mjs` instead of the browser where possible, and run `agent-browser connect 9222` after any daemon restart.
>
> Services to check: dev server `127.0.0.1:8788`, tunnel `https://rulebook-f.getrulebook.com`, Docker `supermemory-supermemory-1`, Chrome CDP `9222`.
>
> Today's job: the owner has real meeting transcripts. Build the ground truth, run each transcript through the harness, and produce precision/recall numbers plus the failure modes — no code changes until the baseline exists.
>
> The Anthropic key expires 2026-12-09; flag it if we are near that.
