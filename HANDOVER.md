# HANDOVER — Rulebook-F

**Written:** 2026-11-11, end of the first build session.
**Repo:** `/Users/abhishekhumney/Deepseek/Rulebook-f`
**Remote:** `origin` = `git@github.com:abhihumney/company-brain.git` (the user's fork) · `upstream` = `https://github.com/supermemoryai/company-brain.git` (push URL set to `no_push`)

---

## 1. What this is

Rulebook-F is a fork of [supermemoryai/company-brain](https://github.com/supermemoryai/company-brain) — a Slack-native organisational agent ("company brain") — being rebuilt into the owner's product:

> A Slack-first bot that extracts action items from internal meetings and then completes them via CLI, MCP, API, or browser automation.

**Owner decisions already made:**

- **Rulebook-F supersedes Rulebook-DS.** The older `getrulebook/rulebook-ds` project already builds a very similar product (its `SPEC.md` literally describes "meetings end, work starts"). It stays live until F can do its job, then gets retired. Nothing has been deleted or decommissioned yet; that needs per-item sign-off.
- **Naming:** everything user-visible is `Rulebook-F`. Persisted identifiers were deliberately NOT renamed (see §6).
- **Stack choices:** Anthropic direct (not DeepSeek), Claude Haiku 5.5, self-hosted memory via Docker, no hosted supermemory account.

---

## 2. Current state (verify these before assuming)

| Thing | Value |
|---|---|
| Branch | `main`, level with `origin/main` after this push |
| HEAD | `a13f7db` + the handover commit |
| Working tree | clean |
| Dev server | `http://127.0.0.1:8788` — **never 8787** (see §7) |
| Public URL | `https://rulebook-f.getrulebook.com` (Cloudflare named tunnel) |
| Memory server | Docker container `supermemory-supermemory-1`, `127.0.0.1:6767`, up |
| Slack workspace | `rulebook-f.slack.com` (team `T0CFY65L84D`), app `Rulebook-F` / `A0CFN46P21M` |
| Slack home channel | `#rulebook-f` (bot-created) |
| Notion | connected to the owner's "Getrulebook" workspace, private to the user |

**Processes are plain background processes — they do not survive a reboot:**
- dev server: `bun run dev -- --port 8788` (log `/tmp/rbf-8788-dev.log`)
- tunnel: `cloudflared tunnel run rulebook-f` (log `/tmp/rbf-tunnel.log`, config `~/.cloudflared/config.yml`, UUID `63024301-a9dd-4257-8a60-db3218e3dd00`)
- memory: `cd infra/supermemory && docker compose up -d`

**Secrets (never commit, never print):**
- `.dev.vars` (mode 600) — `SUPERMEMORY_API_KEY`, `SUPERMEMORY_BASE_URL`, `ANTHROPIC_API_KEY`, `CONTAINER_SANDBOX=off`, `PUBLIC_URL`, `ENCRYPTION_SECRET`
- `infra/supermemory/.env` (mode 600) — `ANTHROPIC_API_KEY`, `SUPERMEMORY_VERSION=0.0.9`, `SUPERMEMORY_DISABLE_TELEMETRY=1`

**The Anthropic key expires 2026-12-09.** When it lapses the failure presents as an auth error, not an expiry warning.

---

## 3. What works today (tested, not assumed)

| Capability | Evidence |
|---|---|
| Multi-turn Slack conversation | ALPHA → BETA → correct memory recall, consecutive turns |
| Memory write + extraction | Dreaming completes in ~10–12 min on the lite server; extracts correct facts |
| Memory recall | Retrieved "api.rulebook.example" and "deploy freeze December 20", and volunteered caveats about both |
| Scope privacy | A public-channel ask searched `containers=sm_org_shared` only; a DM-only secret was never retrieved |
| Notion read | Via Code Mode (`discover_app_methods` → `run_app_code`) |
| Notion write + approval gate | Pauses with a card naming the exact action; on approve it executes (620 ms) and the page is fetchable by ID |
| Deny path | `policy_denied` → `outcome=blocked`; the page was confirmed absent afterwards |
| Scheduling, skills, automations, chime, triage | Present in code (source-verified), not yet exercised end-to-end |

## 4. What does NOT exist (the actual product gap)

- **No meeting ingestion.** No path from a transcript, Granola, Zoom, Meet, or a huddle into memory. Granola/Fireflies/Otter exist only as live-read MCP connectors — nothing persists.
- **No action-item ledger.** No table, no owner field, no state. The only "action items" capability is a regex heuristic that says so itself: *"Status is inferred from message wording, not a task system."* Output reads "Likely open (3) … Likely done: none detected."
- **No browser automation.** Zero references across the repo. This is the owner's most distinctive requirement and the largest unknown.
- **CLI execution cannot authenticate.** The sandbox is deliberately credential-less and blocks `git push`/deploys via guardrails.

**Estimated build effort from the code audit:** action-item ledger ~10–14h · meeting ingest route ~8–10h · close-the-loop (item → approve → execute → receipt) ~12–16h · full identity rename ~5h.

---

## 5. Defects found this session — all fixed and committed

1. **Turn 2 crashed every conversation** (`1e62e6e`) — `Invalid signature in thinking block / bound to a different conversation`. Haiku 5.5 enables adaptive thinking by default, and the brain replays prior assistant turns. `thinking.block_binding.prefix_mismatch_behavior` cannot reach the wire — `@ai-sdk/anthropic` 3.0.98 strips unknown provider options. Fix: explicit `thinking: { type: "disabled" }` for `claude-haiku-5.5`. **Consequence: reasoning and `BRAIN_MAIN_EFFORT` are inert for the main model.**
2. **Profile sync silently 400'd** (`9cd2746`, `7789fd1`) — the self-hosted server caps `entityContext` at exactly 1500 chars; the app sent ~2680. Cap enforced in `updateContainerTagSettings`. Then the capture policy was reordered to lead and compressed 1691 → 1196 chars so the guardrails survive truncation. **Still truncates:** the policy alone is 1196 but all rules total 1820, so `oneAnswer`'s second sentence is cut (its rule is duplicated in the policy, so no rule is lost).
3. **Failed writes reported success** (`1e9f0bf`) — a `{status:"error"}` payload was returned as a *successful* tool result, so the harness recorded success and the model replied as if done, while nothing was created. Now: `run_app_code` throws a `ToolError`; approval-resume emits `error-json`; `mcp_execute_tool` throws on `isError`/unknown/blocked/denied; `getToolFinishOutput` keeps the detail in logs; the system prompt forbids implying completion for errored/paused/denied calls.
4. **Notion create 400** (`a13f7db`) — `creation_mode:"draft"` cannot combine with `parent`. Normalised at `callMcpTool` (the single last hop for Code Mode, direct fallback and leased access).

**Partial fix, unproven:** the `creation_mode` normaliser never fired in the successful live run — the model omitted the argument by itself. It is a guard, not a demonstrated fix.

---

## 6. Naming: what was renamed and what must never be

Renamed (visible identity): `SLACK_APP_NAME`, `HOME_CHANNEL_NAME` (3 copies), `PRODUCT_ALIASES` (no bare `"rulebook"` — Rulebook-DS may share a workspace), prompt persona, all Slack-facing copy, web UI strings, `<title>`.

**Never rename — persisted data or identity:**
- `sm_source` / `source_type` (`"company-brain"`, `"company-brain-slack"`)
- Document id prefixes `company-brain-slack:` / `company-brain-channel-observe:` / `company-brain-research:` and their `startsWith` guards
- `CompanyBrainAgent` class + DO migration tags (needs `renamed_classes`; otherwise every org's DO SQL is orphaned)
- Container tags `sm_org_shared`, `sm_agent_self`, `user_`, `slack_channel_`
- Cookie `brain_session`, KV `deployment:encryption-secret`, `deployment:public-url`, `brain:gateway-health:*`
- `src/brain/prompt/build.ts` transcript label `Company Brain:` and its parser in `triage.ts:533` — coupled; changing one breaks bot-message recognition

**Deferred to a pre-deploy rename:** worker name, D1 `database_name`, `package.json` name. A D1 rename is not an in-place operation.

**Names already taken, do not reuse:** `rulebook-ds`, `rulebook_ds`, `Rulebook DS`, `Rulebook (dev)`, `rulebook-ds.slack.com`, Railway `engine`/`rulebook-demo`, Cloudflare `getrulebook-email`/`rbk-site`, `company-brain` (worker+D1+channel), `supermemory-brain`.

---

## 7. Environment gotchas — read before running anything

- **Port 8787 is poisoned.** A DSH harness stub (`python /tmp/dsh-probe-server.py`) answers *every* request with `204 No Content`. A curl there looks like success and is nothing. Always use 8788.
- **`ENCRYPTION_SECRET` is pinned in `.dev.vars`** precisely because a hard kill once regenerated the KV secret, orphaning every encrypted token. That deadlocked sign-in (login needs the client secret it could no longer decrypt) and forced a local D1+KV wipe. **In production this must be a real Workers secret, never a generated KV value.**
- **`agent-browser tab <label>` can silently fail** after a long gap. A stale label once caused text to be typed into the owner's live Notion page, and its title was deleted during cleanup (both restored). **Always verify `location.href` before typing.**
- **Slack's interactive buttons need a trusted click.** A DOM `.click()` via `eval` returns success but does nothing — the Notion OAuth never opened until a real CDP click was used.
- **Notion search lags.** Newly created pages may not appear for minutes; verify by fetching the page by ID instead.
- **The docker compose tag defaults to `latest`.** The 0.0.9 pin lives in the ignored `infra/supermemory/.env`.
- Two test suites fail to **load** for pre-existing reasons unrelated to this work: `quickjs-executor.test.ts` (`cloudflare:` scheme) and `catalog.test.ts` (`@repo/lib/connector-availability`). Everything else passes: **45 tests**.

---

## 8. Open questions for the owner

1. **Reasoning on the main model is off.** Acceptable for a Haiku-class cost/latency posture, but it is a real capability loss. A possible path is the SDK's `sendReasoning: false`, which would drop replayed reasoning while keeping adaptive thinking — needs tool-loop validation first.
2. **Vector/corpus migration:** supermemory's hosted v3/v4 APIs are deprecated and shut down **2026-12-31**. Irrelevant while self-hosting on 0.0.9, but it blocks any future move to the hosted service without a v5 migration.
3. **Retiring Rulebook-DS** — decided in principle, not executed. Needs an inventory and per-item sign-off.
4. **Production hostname.** Currently `rulebook-f.getrulebook.com` is a dev tunnel. The product's permanent home (e.g. `app.getrulebook.com`) is unchosen.

---

## 9. Next three steps

1. **Action-item ledger (~10–14h).** Table created in `src/brain/turn/agent.impl.ts:174` alongside the other DO tables; two tools (`extract_action_items`, `list_action_items`) registered in `assembleTurnTools` at `src/brain/turn/tools.ts:362`. Fields: id, title, owner (Slack user id), status, source (meeting/message), due date, created/updated.
2. **Meeting ingest (~8–10h).** New route reusing `writeMemories` (`src/brain/memory/index.ts:211`) with a meetings container tag, plus transcript→action-item extraction writing rows.
3. **Close the loop (~12–16h).** Item → approval (`src/brain/turn/approval.ts:12`) → execute via MCP → write a receipt back to the row. The CLI leg needs a credential path the sandbox deliberately forbids.

**Test the transcript gap first** — it is cheap and defines the product: paste a meeting transcript, ask for action items, then ask "what's the status of those?" Today it answers from the transcript and then guesses from wording, because nothing is stored.

---

## 10. Kickoff block for the next session

Paste this to start:

> Continue Rulebook-F. Repo is `/Users/abhishekhumney/Deepseek/Rulebook-f`, branch `main`, clean tree, level with `origin`.
>
> Read `HANDOVER.md` first — it has the state, the decisions, the fixed defects, the naming rules and the environment gotchas.
>
> Standing rules: default to discuss-only; ask before building; delegate hands-on work to subagents; always give an ETA; verify claims with your own tool calls; never print secrets; never use port 8787; verify the browser tab URL before typing.
>
> Services to check before working: dev server on `127.0.0.1:8788`, tunnel `https://rulebook-f.getrulebook.com`, Docker container `supermemory-supermemory-1`. If any is down, restart per `HANDOVER.md` §2 and say so.
>
> Today's job: **build the action-item ledger** (HANDOVER §9, step 1). Plan it, give an ETA, get approval, delegate the implementation, and prove it end to end with a real Slack test — including the meeting-transcript scenario, which should now produce stored items with owners and status instead of "likely open".
>
> The Anthropic key expires 2026-12-09; flag it if we are near that.
