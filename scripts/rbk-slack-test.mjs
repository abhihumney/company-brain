#!/usr/bin/env node
/**
 * Rulebook-F Slack test harness — drives the local bot through the Slack API
 * instead of a browser. Developer tooling only; no product code is imported.
 *
 * Usage:
 *   node scripts/rbk-slack-test.mjs check
 *   node scripts/rbk-slack-test.mjs send "RBK test — harness check, please reply briefly."
 *   node scripts/rbk-slack-test.mjs wait --after <event_ts> --timeout 120
 *   node scripts/rbk-slack-test.mjs history --limit 10
 *   node scripts/rbk-slack-test.mjs send "hello" --channel D0CG76N938C --user U0CGXRTUE0G
 *
 * Options:
 *   --channel <id>   Slack conversation id (default D0CG76N938C, the bot DM)
 *   --user <id>      Slack user id that "sent" the message (default U0CGXRTUE0G)
 *   --team <id>      Slack team id (default T0CFY65L84D)
 *   --after <ts>     wait: only consider messages newer than this ts
 *   --timeout <sec>  wait: give up after this many seconds (default 120)
 *   --limit <n>      history: number of messages (default 10, max 200)
 *
 * What it reads:
 *   .dev.vars                                  ENCRYPTION_SECRET only
 *   .wrangler/state/v3/**\/*.sqlite            local D1 state (workspace + config)
 *
 * The script never prints a bot token, signing secret or encryption secret —
 * only lengths. It only opens local SQLite files read-only and only POSTs a
 * signed synthetic event to the local dev server.
 *
 * Worker base defaults to http://127.0.0.1:8788 (port 8787 is refused). Override
 * with RBK_WORKER_BASE only when the dev server really moved.
 *
 * Requires Node 22.5+ for the built-in node:sqlite module (tested on Node 24).
 */

import {
	createDecipheriv,
	createHmac,
	pbkdf2Sync,
	randomBytes,
} from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const STATE_DIR = join(ROOT, ".wrangler", "state", "v3")
const DEV_VARS = join(ROOT, ".dev.vars")
const SLACK_API = "https://slack.com/api"

const DEFAULT_TEAM = "T0CFY65L84D"
const DEFAULT_CHANNEL = "D0CG76N938C"
const DEFAULT_USER = "U0CGXRTUE0G"
const DEFAULT_WAIT_TIMEOUT_SECONDS = 120
const DEFAULT_HISTORY_LIMIT = 10
const MAX_HISTORY_LIMIT = 200
const POLL_INTERVAL_MS = 2_000

// ---------------------------------------------------------------------------
// output helpers
// ---------------------------------------------------------------------------

function log(message) {
	console.log(`[rbk] ${message}`)
}

function warn(message) {
	console.warn(`[rbk] warn: ${message}`)
}

class HarnessError extends Error {}

function fail(message) {
	throw new HarnessError(message)
}

function shorten(value, max = 300) {
	const text = String(value ?? "").replace(/\s+/g, " ").trim()
	return text.length > max ? `${text.slice(0, max)}…` : text
}

function errorSummary(error) {
	if (error instanceof HarnessError) return error.message
	if (error instanceof Error) {
		const cause = error.cause
		const code =
			cause && typeof cause === "object" && "code" in cause
				? ` (${String(cause.code)})`
				: ""
		return `${error.message}${code}`
	}
	return String(error)
}

// ---------------------------------------------------------------------------
// local credentials / database discovery
// ---------------------------------------------------------------------------

/** Read exactly one key from .dev.vars. The value is never logged. */
function readEncryptionSecret() {
	if (!existsSync(DEV_VARS)) {
		fail(`ENCRYPTION_SECRET not found: ${DEV_VARS} does not exist`)
	}
	let raw
	try {
		raw = readFileSync(DEV_VARS, "utf8")
	} catch (error) {
		fail(`could not read ${DEV_VARS}: ${errorSummary(error)}`)
	}
	const line = raw
		.split(/\r?\n/)
		.find((candidate) => /^\s*(?:export\s+)?ENCRYPTION_SECRET\s*=/.test(candidate))
	if (!line) {
		fail(`ENCRYPTION_SECRET not found in ${DEV_VARS} (looked for a top-level ENCRYPTION_SECRET= line)`)
	}
	let value = line.slice(line.indexOf("=") + 1).trim()
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		value = value.slice(1, -1)
	}
	if (!value) {
		fail(`ENCRYPTION_SECRET is empty in ${DEV_VARS}`)
	}
	return value
}

function* walkFiles(dir) {
	let entries
	try {
		entries = readdirSync(dir, { withFileTypes: true })
	} catch {
		return
	}
	for (const entry of entries) {
		const full = join(dir, entry.name)
		if (entry.isDirectory()) {
			yield* walkFiles(full)
		} else if (entry.isFile() && entry.name.endsWith(".sqlite")) {
			yield full
		}
	}
}

function sqliteCandidates() {
	if (!existsSync(STATE_DIR)) {
		fail(`local state not found: ${STATE_DIR} does not exist (is the dev server running?)`)
	}
	const d1Dir = join(STATE_DIR, "d1")
	const files = [...walkFiles(d1Dir), ...walkFiles(STATE_DIR)]
	const unique = []
	const seen = new Set()
	for (const file of files) {
		if (seen.has(file)) continue
		seen.add(file)
		unique.push(file)
	}
	if (unique.length === 0) {
		fail(`no local SQLite files found under ${STATE_DIR}`)
	}
	return unique
}

function hasTable(db, table) {
	const row = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(table)
	return Boolean(row)
}

/** Find the first local SQLite database that contains `table`. Read-only. */
function findDatabaseWithTable(table) {
	const candidates = sqliteCandidates()
	const failures = []
	for (const file of candidates) {
		let db
		try {
			db = new DatabaseSync(file, { readOnly: true })
			if (hasTable(db, table)) return { path: file, db }
			db.close()
		} catch (error) {
			try {
				db?.close()
			} catch {}
			failures.push(`${relative(ROOT, file)}: ${errorSummary(error)}`)
		}
	}
	const detail = failures.length ? ` (open failures: ${failures.join("; ")})` : ""
	fail(
		`no local SQLite database under ${STATE_DIR} has a "${table}" table${detail}`,
	)
}

// ---------------------------------------------------------------------------
// crypto — mirrors src/compat/lib/crypto (WebCrypto AES-GCM)
// PBKDF2-SHA256, 100k iterations, salt "supermemory-connections", 256-bit key.
// Payload is base64(iv[12] || ciphertext || tag[16]).
// ---------------------------------------------------------------------------

const PBKDF2_ITERATIONS = 100_000
const PBKDF2_SALT = "supermemory-connections"
const IV_LENGTH = 12
const TAG_LENGTH = 16

function deriveKey(secret) {
	return pbkdf2Sync(
		secret,
		PBKDF2_SALT,
		PBKDF2_ITERATIONS,
		32,
		"sha256",
	)
}

function decryptToken(encoded, secret, label) {
	let payload
	try {
		payload = Buffer.from(encoded, "base64")
	} catch {
		fail(`${label} is not valid base64`)
	}
	if (payload.length < IV_LENGTH + TAG_LENGTH) {
		fail(
			`${label} is too short to be an encrypted value (${payload.length} bytes; expected > ${IV_LENGTH + TAG_LENGTH})`,
		)
	}
	const iv = payload.subarray(0, IV_LENGTH)
	const tag = payload.subarray(payload.length - TAG_LENGTH)
	const ciphertext = payload.subarray(IV_LENGTH, payload.length - TAG_LENGTH)
	try {
		const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), iv)
		decipher.setAuthTag(tag)
		const plaintext = Buffer.concat([
			decipher.update(ciphertext),
			decipher.final(),
		]).toString("utf8")
		if (!plaintext) fail(`${label} decrypted to an empty value`)
		return plaintext
	} catch (error) {
		if (error instanceof HarnessError) throw error
		fail(
			`could not decrypt ${label} (AES-256-GCM); ENCRYPTION_SECRET does not match the stored value or it is corrupt`,
		)
	}
}

// ---------------------------------------------------------------------------
// Slack credentials from local state
// ---------------------------------------------------------------------------

function loadCredentials({ team = DEFAULT_TEAM }) {
	const teamId = team ?? DEFAULT_TEAM
	const encryptionSecret = readEncryptionSecret()
	const { path: dbPath, db } = findDatabaseWithTable("slack_workspace")

	let workspace
	try {
		workspace = db
			.prepare(
				`SELECT team_id, org_id, bot_user_id, bot_token_enc, team_name
				 FROM slack_workspace WHERE team_id = ?`,
			)
			.get(teamId)
	} catch (error) {
		db.close()
		fail(`could not read slack_workspace from ${relative(ROOT, dbPath)}: ${errorSummary(error)}`)
	}
	if (!workspace) {
		let teams = []
		try {
			teams = db
				.prepare("SELECT team_id FROM slack_workspace ORDER BY team_id")
				.all()
				.map((row) => row.team_id)
		} catch {}
		db.close()
		fail(
			`no slack_workspace row for team ${teamId} in ${relative(ROOT, dbPath)}` +
				(teams.length ? ` (teams present: ${teams.join(", ")})` : " (table is empty)"),
		)
	}

	// deployment_config normally lives in the same D1 file, but keep working if
	// setup ever stores it in a separate local SQLite database.
	let configPath = dbPath
	let configDb = db
	if (!hasTable(configDb, "deployment_config")) {
		db.close()
		const found = findDatabaseWithTable("deployment_config")
		configPath = found.path
		configDb = found.db
	}
	let configRow
	try {
		configRow = configDb
			.prepare("SELECT value, encrypted FROM deployment_config WHERE key = ?")
			.get("slack_signing_secret")
	} catch (error) {
		configDb.close()
		fail(
			`could not read deployment_config from ${relative(ROOT, configPath)}: ${errorSummary(error)}`,
		)
	}
	configDb.close()
	if (!configRow) {
		fail(
			`deployment_config has no "slack_signing_secret" row in ${relative(ROOT, configPath)} (was the setup wizard completed?)`,
		)
	}
	if (!configRow.value) {
		fail(
			`deployment_config row "slack_signing_secret" is empty in ${relative(ROOT, configPath)}`,
		)
	}

	const botToken = decryptToken(
		workspace.bot_token_enc,
		encryptionSecret,
		`bot token for team ${workspace.team_id}`,
	)
	const signingSecret = decryptToken(
		configRow.value,
		encryptionSecret,
		"signing secret (deployment_config.slack_signing_secret)",
	)
	if (configRow.encrypted !== 1) {
		warn(
			"deployment_config.slack_signing_secret is marked encrypted=0 but decrypted successfully",
		)
	}

	return {
		dbPath,
		configPath,
		teamId: workspace.team_id,
		orgId: workspace.org_id,
		teamName: workspace.team_name,
		botUserId: workspace.bot_user_id,
		botToken,
		signingSecret,
		encryptionSecretLength: encryptionSecret.length,
	}
}

// ---------------------------------------------------------------------------
// Slack API
// ---------------------------------------------------------------------------

async function slackApi(method, token, params = {}) {
	const url = new URL(`${SLACK_API}/${method}`)
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== null) {
			url.searchParams.set(key, String(value))
		}
	}
	let response
	try {
		response = await fetch(url, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(20_000),
		})
	} catch (error) {
		fail(`${method} request failed: ${errorSummary(error)}`)
	}
	const raw = await response.text()
	let body
	try {
		body = JSON.parse(raw)
	} catch {
		fail(`${method} returned non-JSON (HTTP ${response.status})`)
	}
	if (!body || body.ok !== true) {
		const slackError =
			body && typeof body.error === "string" ? body.error : "unknown_error"
		fail(`${method} failed: ${slackError} (HTTP ${response.status})`)
	}
	return body
}

function isBotMessage(message, botUserId) {
	if (!message) return false
	if (message.bot_id || message.app_id) return true
	return Boolean(botUserId && message.user === botUserId)
}

/** Slack ts strings are "seconds.microseconds"; compare numerically-safe. */
function tsParts(ts) {
	const text = String(ts ?? "")
	const dot = text.indexOf(".")
	const seconds = Number(dot === -1 ? text : text.slice(0, dot))
	const fraction = dot === -1 ? "" : text.slice(dot + 1)
	if (!Number.isFinite(seconds)) return null
	return { seconds, fraction: `${fraction}000000`.slice(0, 6) }
}

function isNewerTs(candidate, reference) {
	const a = tsParts(candidate)
	const b = tsParts(reference)
	if (!a || !b) return false
	if (a.seconds !== b.seconds) return a.seconds > b.seconds
	return a.fraction > b.fraction
}

function isUnfinishedStream(message) {
	return message?.streaming_state === "in_progress"
}

/** Prefer the plain text, then fall back to text inside Slack blocks. */
function messageText(message) {
	if (typeof message?.text === "string" && message.text.trim()) {
		return message.text
	}
	const parts = []
	const collect = (node) => {
		if (!node || typeof node !== "object") return
		if (Array.isArray(node)) {
			for (const item of node) collect(item)
			return
		}
		if (
			typeof node.text === "string" &&
			(node.type === "mrkdwn" || node.type === "plain_text" || !node.type)
		) {
			parts.push(node.text)
		}
		if (Array.isArray(node.elements)) collect(node.elements)
		if (Array.isArray(node.fields)) collect(node.fields)
	}
	collect(message?.blocks)
	return parts.join("\n").trim()
}

function messageAuthor(message) {
	if (message?.user) return message.user
	if (message?.bot_id) return `bot:${message.bot_id}`
	return "?"
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function workerBase() {
	const raw = process.env.RBK_WORKER_BASE ?? "http://127.0.0.1:8788"
	let url
	try {
		url = new URL(raw)
	} catch {
		fail(`RBK_WORKER_BASE is not a valid URL: ${raw}`)
	}
	const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80
	if (port === 8787) {
		fail("refusing to use port 8787; the Rulebook-F dev server is on 8788")
	}
	if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
		fail(`refusing to send synthetic Slack events to non-local host ${url.hostname}`)
	}
	return url
}

function signSlackRequest(signingSecret, timestamp, bodyBuffer) {
	const base = Buffer.concat([
		Buffer.from(`v0:${timestamp}:`, "utf8"),
		bodyBuffer,
	])
	return `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`
}

function freshTs() {
	const now = Date.now()
	const seconds = Math.floor(now / 1000)
	const micros = String((now % 1000) * 1000 + (randomBytes(2).readUInt16BE(0) % 1000)).padStart(6, "0")
	return `${seconds}.${micros}`
}

function uniqueEventId() {
	return `Ev${Date.now().toString(36).toUpperCase()}${randomBytes(4).toString("hex").toUpperCase()}`
}

async function commandSend(options) {
	const text = options.text
	if (!text || !text.trim()) {
		fail("send needs message text, e.g. node scripts/rbk-slack-test.mjs send \"hello\"")
	}
	const creds = loadCredentials(options)
	const base = workerBase()
	const channel = options.channel ?? DEFAULT_CHANNEL
	const user = options.user ?? DEFAULT_USER
	const ts = freshTs()
	const eventId = uniqueEventId()
	const envelope = {
		token: "rbk-local-harness",
		team_id: creds.teamId,
		type: "event_callback",
		event_id: eventId,
		event_time: Math.floor(Date.now() / 1000),
		event: {
			type: "message",
			channel,
			channel_type: "im",
			user,
			text,
			ts,
			event_ts: ts,
		},
	}
	const bodyBuffer = Buffer.from(JSON.stringify(envelope), "utf8")
	const requestTs = Math.floor(Date.now() / 1000)
	const signature = signSlackRequest(creds.signingSecret, requestTs, bodyBuffer)
	const endpoint = new URL("/slack/events", base)

	log(`channel=${channel} user=${user} team=${creds.teamId}`)
	log(`event_id=${eventId}`)
	log(`event_ts=${ts}`)

	const started = Date.now()
	let response
	try {
		response = await fetch(endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-slack-signature": signature,
				"x-slack-request-timestamp": String(requestTs),
			},
			body: bodyBuffer,
			signal: AbortSignal.timeout(20_000),
		})
	} catch (error) {
		fail(`POST ${endpoint.href} failed: ${errorSummary(error)}`)
	}
	const responseText = await response.text()
	const elapsed = ((Date.now() - started) / 1000).toFixed(2)
	log(`POST ${endpoint.pathname} -> HTTP ${response.status} in ${elapsed}s`)
	if (!response.ok) {
		fail(
			`worker rejected the event: HTTP ${response.status} ${shorten(responseText)}`,
		)
	}
	if (responseText.trim()) log(`response: ${shorten(responseText)}`)
	log("send OK")
}

async function commandWait(options) {
	if (!options.after) fail("wait needs --after <event_ts> (the ts printed by send)")
	const creds = loadCredentials(options)
	const channel = options.channel ?? DEFAULT_CHANNEL
	const timeoutSeconds = Number(options.timeout ?? DEFAULT_WAIT_TIMEOUT_SECONDS)
	if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
		fail(`--timeout must be a positive number of seconds, got ${options.timeout}`)
	}
	const deadline = Date.now() + timeoutSeconds * 1000
	log(
		`waiting for the first bot message after ${options.after} in ${channel} (timeout ${timeoutSeconds}s)`,
	)
	const started = Date.now()
	let lastSeen = 0
	for (;;) {
		const body = await slackApi("conversations.history", creds.botToken, {
			channel,
			oldest: options.after,
			inclusive: false,
			limit: 50,
		})
		const messages = Array.isArray(body.messages) ? body.messages : []
		lastSeen = messages.length
		const candidates = messages
			.filter(
				(message) =>
					isBotMessage(message, creds.botUserId) &&
					message.ts &&
					isNewerTs(message.ts, options.after),
			)
			.sort((a, b) => (isNewerTs(a.ts, b.ts) ? 1 : -1))
		const first = candidates[0]
		if (first) {
			const text = messageText(first)
			if (text && !isUnfinishedStream(first)) {
				const waited = ((Date.now() - started) / 1000).toFixed(2)
				log(`reply_ts=${first.ts} (after ${waited}s)`)
				log("--- bot reply ---")
				console.log(text)
				return
			}
		}
		if (Date.now() >= deadline) {
			const hint =
				lastSeen === 0
					? "no messages returned by conversations.history"
					: `${lastSeen} message(s) returned but none was a complete bot message after ${options.after}`
			fail(`timed out after ${timeoutSeconds}s waiting for a bot reply: ${hint}`)
		}
		await new Promise((resolveSleep) =>
			setTimeout(
				resolveSleep,
				Math.min(POLL_INTERVAL_MS, deadline - Date.now()),
			),
		)
	}
}

async function commandHistory(options) {
	const creds = loadCredentials(options)
	const channel = options.channel ?? DEFAULT_CHANNEL
	let limit = Number(options.limit ?? DEFAULT_HISTORY_LIMIT)
	if (!Number.isFinite(limit) || limit <= 0) {
		fail(`--limit must be a positive number, got ${options.limit}`)
	}
	limit = Math.min(Math.floor(limit), MAX_HISTORY_LIMIT)
	const body = await slackApi("conversations.history", creds.botToken, {
		channel,
		limit,
	})
	const messages = Array.isArray(body.messages) ? body.messages : []
	const ordered = [...messages].reverse()
	log(`last ${ordered.length} message(s) in ${channel}, oldest first`)
	for (const message of ordered) {
		const text = String(messageText(message) || "").replace(/\s+/g, " ").trim()
		const truncated = text.length > 200 ? `${text.slice(0, 200)}…` : text
		console.log(`${message.ts ?? "?"} | ${messageAuthor(message)} | ${truncated}`)
	}
}

async function commandCheck(options) {
	const creds = loadCredentials(options)
	const channel = options.channel ?? DEFAULT_CHANNEL

	log(`workspace root: ${ROOT}`)
	log(`.dev.vars: ENCRYPTION_SECRET present (length ${creds.encryptionSecretLength})`)
	log(`local state db: ${relative(ROOT, creds.dbPath)}`)
	if (creds.configPath !== creds.dbPath) {
		log(`config db: ${relative(ROOT, creds.configPath)}`)
	}
	log(`team: ${creds.teamId}${creds.teamName ? ` (${creds.teamName})` : ""}`)
	log(`org: ${creds.orgId}`)
	log(`channel: ${channel}`)
	log(`bot_user_id: ${creds.botUserId ?? "(not set)"}`)
	log(`bot token: decrypted OK (length ${creds.botToken.length})`)
	log(`signing secret: decrypted OK (length ${creds.signingSecret.length})`)

	let auth
	try {
		auth = await slackApi("auth.test", creds.botToken)
	} catch (error) {
		const message = errorSummary(error)
		const isAuthFailure = /invalid_auth|token_revoked|account_inactive|not_authed|missing_scope|HTTP 4\d\d/.test(
			message,
		)
		if (isAuthFailure) {
			fail(`Slack rejected the decrypted bot token: ${message}`)
		}
		warn(`could not reach Slack for auth.test (${message})`)
		log("local checks OK; Slack auth unverified")
		return
	}
	log(
		`auth.test: ok (team=${auth.team ?? "?"} team_id=${auth.team_id ?? "?"} user_id=${auth.user_id ?? "?"})`,
	)
	if (creds.teamId && auth.team_id && auth.team_id !== creds.teamId) {
		warn(
			`auth.test team_id ${auth.team_id} does not match the stored workspace ${creds.teamId}`,
		)
	}
	log("OK")
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Rulebook-F Slack API test harness

Usage:
  node scripts/rbk-slack-test.mjs check
  node scripts/rbk-slack-test.mjs send <text> [--channel <id>] [--user <id>] [--team <id>]
  node scripts/rbk-slack-test.mjs wait --after <ts> [--timeout <seconds>] [--channel <id>]
  node scripts/rbk-slack-test.mjs history [--limit <n>] [--channel <id>]

Defaults: team ${DEFAULT_TEAM}, channel ${DEFAULT_CHANNEL} (bot DM), user ${DEFAULT_USER}.
Reads ENCRYPTION_SECRET from .dev.vars and local state from .wrangler/state/v3.
Never prints secrets. Worker base defaults to http://127.0.0.1:8788 (8787 refused).`

const FLAGS = new Set([
	"--channel",
	"--user",
	"--team",
	"--after",
	"--timeout",
	"--limit",
])

function parseArgs(argv) {
	const options = { positional: [] }
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		if (arg === "--help" || arg === "-h") {
			options.help = true
			continue
		}
		const [flag, inlineValue] = arg.includes("=")
			? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
			: [arg, undefined]
		if (FLAGS.has(flag)) {
			const value = inlineValue ?? argv[index + 1]
			if (value === undefined || (inlineValue === undefined && value.startsWith("--"))) {
				fail(`missing value for ${flag}`)
			}
			if (inlineValue === undefined) index += 1
			options[flag.slice(2)] = value
			continue
		}
		if (arg.startsWith("--")) fail(`unknown option ${arg}`)
		options.positional.push(arg)
	}
	return options
}

async function main() {
	const options = parseArgs(process.argv.slice(2))
	if (options.help) {
		console.log(USAGE)
		return
	}
	const command = options.positional[0]
	if (!command) {
		console.log(USAGE)
		fail("no command given")
	}
	if (command === "send") {
		options.text = options.positional.slice(1).join(" ")
		await commandSend(options)
		return
	}
	if (command === "wait") {
		await commandWait(options)
		return
	}
	if (command === "history") {
		await commandHistory(options)
		return
	}
	if (command === "check") {
		await commandCheck(options)
		return
	}
	fail(`unknown command "${command}" (expected check, send, wait or history)`)
}

main().catch((error) => {
	console.error(`[rbk] error: ${errorSummary(error)}`)
	process.exit(1)
})
