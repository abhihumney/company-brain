import type { ToolSet } from "ai"
import type { CompanyBrainAgent } from "./agent"
import type { TurnDeps } from "./deps"
import {
	normalizeMemberMatchText,
	resolveSlackMemberReference,
	type SlackMemberDirectoryCache,
	type SlackMemberDirectoryResult,
	type SlackMemberReference,
} from "./slack-member-resolve"

export const ACTION_ITEM_STATUSES = [
	"open",
	"in_progress",
	"done",
	"dropped",
] as const
export type ActionItemStatus = (typeof ACTION_ITEM_STATUSES)[number]

export const ACTION_ITEM_SOURCES = ["meeting", "message", "manual"] as const
export type ActionItemSource = (typeof ACTION_ITEM_SOURCES)[number]

/**
 * A meeting extraction with no source_ref is only trusted when the current
 * message is long enough to plausibly contain a transcript or has a transcript
 * attachment. This blocks spontaneous extraction from prior conversation.
 */
export const EXTRACT_GUARD_SHORT_MESSAGE_CHARS = 400

export type ActionItemOwnerResolution =
	| "id"
	| "email"
	| "handle"
	| "name"
	| "ambiguous"
	| "unresolved"
	| null

export type BrainActionItem = {
	id: string
	title: string
	detail: string | null
	owner: string | null
	owner_name: string | null
	owner_resolution: ActionItemOwnerResolution
	status: ActionItemStatus
	source: ActionItemSource
	source_ref: string | null
	source_key: string | null
	scope: string
	due: string | null
	evidence: string | null
	created_by: string | null
	dedupe_key: string
	created_at: number
	updated_at: number
}

/** Slack surface the current turn is talking in. */
export type ActionItemSurface =
	| { kind: "dm" }
	| { kind: "private_channel"; channelId: string }
	| { kind: "public_channel"; channelId: string }
	| { kind: "unknown" }

export type ActionItemSlackSurfaceInput = {
	channel: string
	memoryScope?: { kind: string; channelId?: string }
}

type ActionItemRow = {
	id: string
	title: string
	detail: string | null
	owner: string | null
	owner_name: string | null
	owner_resolution: string | null
	status: string
	source: string
	source_ref: string | null
	source_key: string | null
	scope: string
	due: string | null
	evidence: string | null
	created_by: string | null
	dedupe_key: string
	created_at: number
	updated_at: number
}

export function ensureActionItemTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_action_item (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			detail TEXT,
			owner TEXT,
			owner_name TEXT,
			owner_resolution TEXT,
			status TEXT NOT NULL DEFAULT 'open',
			source TEXT NOT NULL,
			source_ref TEXT,
			source_key TEXT,
			scope TEXT NOT NULL,
			due TEXT,
			evidence TEXT,
			created_by TEXT,
			dedupe_key TEXT NOT NULL UNIQUE,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`
	// Idempotent upgrades for tables created before source-level idempotence
	// and DM visibility landed. Existing rows keep NULL in both columns.
	const columns = agent.sql<{ name: string }>`
		PRAGMA table_info(brain_action_item)
	`
	const names = new Set(columns.map((column) => column.name))
	if (!names.has("source_key")) {
		agent.sql`ALTER TABLE brain_action_item ADD COLUMN source_key TEXT`
	}
	if (!names.has("created_by")) {
		agent.sql`ALTER TABLE brain_action_item ADD COLUMN created_by TEXT`
	}
	agent.sql`
		CREATE INDEX IF NOT EXISTS brain_action_item_status_owner
		ON brain_action_item (status, owner)
	`
	agent.sql`
		CREATE INDEX IF NOT EXISTS brain_action_item_source_key
		ON brain_action_item (scope, source_key)
	`
}

export function ensureActionItemSourceTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_action_item_source (
			scope TEXT NOT NULL,
			source_key TEXT NOT NULL,
			item_count INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (scope, source_key)
		)
	`
}

export function normalizeActionItemTitle(title: string): string {
	return title
		.normalize("NFKC")
		.replace(/[\u00a0\u2007\u202f\u200b-\u200d\ufeff]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase()
		.replace(/[.!?;:]+$/u, "")
		.trim()
}

// Only explicit phrases count. Generic words such as "decide", "decision",
// "discuss", or "later" on their own are not rejection markers. "decide later"
// is the narrow two-word exception needed for title-only deferred decisions.
export const NON_DECISION_MARKERS = [
	"didn't decide",
	"did not decide",
	"no decision",
	"not decided",
	"undecided",
	"not agreed",
	"no agreement",
	"deferred",
	"tabled",
	"parked",
	"left open",
	"no conclusion",
	"only discussed",
	"just discussed",
	"for discussion only",
	"nothing decided",
	"we'll decide later",
	"we will decide later",
	"decide later",
] as const

const NON_DECISION_APOSTROPHES_RE = /[\u2018\u2019\u02bc\u0060\u00b4]/g
const NON_DECISION_INVISIBLE_SPACE_RE = /[\u00a0\u2007\u202f\u200b-\u200d\ufeff]/g

export function normalizeNonDecisionText(value: string): string {
	return value
		.normalize("NFKC")
		.replace(NON_DECISION_APOSTROPHES_RE, "'")
		.replace(NON_DECISION_INVISIBLE_SPACE_RE, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase()
}

/** Return the first explicit non-decision marker found in the texts. */
export function findNonDecisionMarker(
	texts: ReadonlyArray<string | null | undefined>,
): string | undefined {
	const haystack = texts
		.map((value) => (value ? normalizeNonDecisionText(value) : ""))
		.filter(Boolean)
		.join("\n")
	if (!haystack) return undefined
	return NON_DECISION_MARKERS.find((marker) => haystack.includes(marker))
}

// Heuristic only: this widens the short-message guard, it never decides what
// to store. A speaker line, a transcript marker, or a commitment cue is enough
// to let the model attempt extraction; the prompt and non-decision filter still
// decide the items.
const SPEAKER_LINE_RE = /^\s*[A-Z][A-Za-z0-9 .'’_-]{0,40}:\s+\S/m
const TRANSCRIPT_MARKER_RE =
	/\b(?:transcript|meeting notes|meeting transcript|attendees|agenda)\b/i
const COMMITMENT_CUE_RE = new RegExp(
	[
		"\\bi(?:'|’)ll\\b",
		"\\bi will\\b",
		"\\bwe(?:'|’)ll\\b",
		"\\bwe will\\b",
		"\\byou(?:'|’)ll\\b",
		"\\byou will\\b",
		"\\bwill\\b",
		"\\bto do\\b",
		"\\bneed to\\b",
		"\\bneeds to\\b",
		"\\bshould\\b",
		"\\bmust\\b",
		"\\bdue\\b",
		"\\bby\\s+(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\\b",
		"\\bby\\s+\\d{1,2}(?:st|nd|rd|th)?\\b",
		"\\bby\\s+\\d{4}-\\d{2}-\\d{2}\\b",
		"\\bby\\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\b",
		"\\btomorrow\\b",
		"\\bnext week\\b",
	].join("|"),
	"i",
)

/**
 * Whether a short current message plausibly contains commitments. This is a
 * deliberately narrow heuristic, not a semantic classifier; its only job is
 * to avoid rejecting genuine short notes like "Alice will send the deck."
 */
export function hasCommitmentContent(text: string): boolean {
	const normalized = text
		.normalize("NFKC")
		.replace(/[\u2018\u2019]/g, "'")
		.trim()
	if (!normalized) return false
	return (
		SPEAKER_LINE_RE.test(normalized) ||
		TRANSCRIPT_MARKER_RE.test(normalized) ||
		COMMITMENT_CUE_RE.test(normalized)
	)
}

const EARLIER_EXTRACTION_VERB_RE =
	/\b(?:extract|pull out|pull up|get|find|list|give me|show me|summari[sz]e)\b/i
const EARLIER_EXTRACTION_TARGET_RE =
	/\b(?:action items?|action-items?|commitments?|tasks?|to-dos?|todos?)\b/i
const EARLIER_SOURCE_RE =
	/\b(?:that transcript|the transcript|the earlier|the previous|yesterday'?s|last meeting|above|earlier message|the one i sent|from before)\b/i

/**
 * Whether the current user message explicitly asks to extract from earlier
 * material. Literal and tested; used only to gate a source_ref that points at
 * a different turn, not to infer intent from prior conversation.
 */
export function requestsEarlierExtraction(turnText: string | undefined): boolean {
	if (!turnText) return false
	const normalized = turnText
		.normalize("NFKC")
		.replace(/[\u2018\u2019\u02bc]/g, "'")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase()
	if (!normalized) return false
	return (
		(EARLIER_EXTRACTION_VERB_RE.test(normalized) &&
			EARLIER_EXTRACTION_TARGET_RE.test(normalized)) ||
		EARLIER_SOURCE_RE.test(normalized)
	)
}

export function normalizeActionItemOwnerName(value: string | null | undefined): string {
	return (value ?? "")
		.normalize("NFKC")
		.replace(/[\u00a0\u2007\u202f\u200b-\u200d\ufeff]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase()
}

function ownerDedupeKeyPart(
	ownerId: string | null | undefined,
	ownerName: string | null | undefined,
): string {
	const id = (ownerId ?? "").trim().toLowerCase()
	if (id) return `id:${id}`
	const name = normalizeActionItemOwnerName(ownerName)
	return name ? `name:${name}` : "owner:none"
}

/**
 * Stable pre-hash payload for the action-item dedupe key: stored scope,
 * normalised title, and resolved owner id (or raw owner name).
 *
 * source_ref is deliberately excluded. It is model-authored provenance and
 * previously let the same transcript hash differently between runs. The
 * trade-off is deliberate: an identical title+owner in the same scope is
 * treated as the same commitment even when it came from a different source.
 */
export function actionItemDedupePayload(input: {
	scope: string
	title: string
	ownerId?: string | null
	ownerName?: string | null
}): string {
	return [
		input.scope,
		normalizeActionItemTitle(input.title),
		ownerDedupeKeyPart(input.ownerId, input.ownerName),
	].join("\u0000")
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	)
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")
}

export async function buildActionItemDedupeKey(input: {
	scope: string
	title: string
	ownerId?: string | null
	ownerName?: string | null
}): Promise<string> {
	return sha256Hex(actionItemDedupePayload(input))
}

export const SLACK_MESSAGE_TS_RE = /^\d{9,12}\.\d{6}$/
export const SLACK_FILE_ID_RE = /^F[A-Z0-9]+$/

export type ActionItemSourceKind =
	| "slack_message"
	| "slack_file"
	| "turn_message"
	| "title_fallback"

export type ActionItemSourceIdentity = {
	sourceKey: string
	kind: ActionItemSourceKind
	warning?: string
}

/**
 * Resolve the source identity used for source-level idempotence. Only a real
 * Slack message ts or file id becomes identity; any other model-written
 * source_ref is ignored in favour of the current turn's message ts.
 */
export function resolveActionItemSourceIdentity(input: {
	sourceRef?: string | null
	channelId?: string | null
	turnTs?: string | null
}): ActionItemSourceIdentity | undefined {
	const sourceRef = input.sourceRef?.trim() ?? ""
	const channelId = input.channelId?.trim() ?? ""
	const turnTs = input.turnTs?.trim() ?? ""
	if (sourceRef && SLACK_MESSAGE_TS_RE.test(sourceRef) && channelId) {
		return {
			sourceKey: `slack:${channelId}:${sourceRef}`,
			kind: "slack_message",
		}
	}
	if (sourceRef && SLACK_FILE_ID_RE.test(sourceRef)) {
		return { sourceKey: `file:${sourceRef}`, kind: "slack_file" }
	}
	if (turnTs && channelId) {
		return {
			sourceKey: `slack:${channelId}:${turnTs}`,
			kind: "turn_message",
			...(sourceRef
				? {
						warning:
							"source_ref was not a Slack message ts or file id, so the current turn's message ts was used as the source identity.",
					}
				: {}),
		}
	}
	return undefined
}

export const TITLE_FALLBACK_SOURCE_WARNING =
	"No Slack source identity was available (non-Slack turn), so a title-based source key is the last resort. Re-extractions with paraphrased titles may not deduplicate."

/** Last-resort source key for non-Slack turns: hash of the batch's item keys. */
export async function buildTitleFallbackSourceKey(input: {
	scope: string
	items: ReadonlyArray<{
		title: string
		ownerId?: string | null
		ownerName?: string | null
	}>
}): Promise<string> {
	const payloads = input.items
		.map((item) =>
			actionItemDedupePayload({
				scope: input.scope,
				title: item.title,
				ownerId: item.ownerId,
				ownerName: item.ownerName,
			}),
		)
		.sort()
	return `title:${await sha256Hex(payloads.join("\n"))}`
}

export const ACTION_ITEM_SIMILARITY_THRESHOLD = 0.6
export const ACTION_ITEM_BATCH_MATCH_THRESHOLD = 0.6

// "before" is intentionally included so "Update the travel policy" and
// "Update the travel policy before month end" reach the 0.6 match threshold.
const ACTION_ITEM_TITLE_STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"before",
	"but",
	"by",
	"for",
	"from",
	"has",
	"have",
	"he",
	"her",
	"him",
	"his",
	"i",
	"if",
	"in",
	"into",
	"is",
	"it",
	"its",
	"me",
	"my",
	"no",
	"not",
	"of",
	"on",
	"or",
	"our",
	"she",
	"so",
	"than",
	"that",
	"the",
	"their",
	"them",
	"then",
	"there",
	"these",
	"they",
	"this",
	"those",
	"to",
	"up",
	"us",
	"was",
	"we",
	"were",
	"what",
	"when",
	"where",
	"which",
	"who",
	"will",
	"with",
	"you",
	"your",
])

function singularizeTitleToken(token: string): string {
	if (token.length <= 3) return token
	if (token.endsWith("ies")) return `${token.slice(0, -3)}y`
	if (/(?:ches|shes|xes|zes|ses)$/.test(token)) return token.slice(0, -2)
	if (token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1)
	return token
}

export function actionItemTitleTokens(title: string): Set<string> {
	const normalized = title
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
	const tokens = new Set<string>()
	for (const token of normalized.split(/\s+/)) {
		if (!token || ACTION_ITEM_TITLE_STOPWORDS.has(token)) continue
		tokens.add(singularizeTitleToken(token))
	}
	return tokens
}

/** Jaccard similarity over normalised title token sets. */
export function actionItemTitleSimilarity(a: string, b: string): number {
	const left = actionItemTitleTokens(a)
	const right = actionItemTitleTokens(b)
	if (!left.size || !right.size) return 0
	let intersection = 0
	for (const token of left) if (right.has(token)) intersection += 1
	const union = left.size + right.size - intersection
	return union ? intersection / union : 0
}

export const GROUNDING_TOKEN_THRESHOLD = 0.6

export function normalizeGroundingText(value: string): string {
	return value
		.normalize("NFKC")
		.replace(/[\u00a0\u2007\u202f\u200b-\u200d\ufeff]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase()
}

/**
 * Ground one item in what the user just sent. Evidence must appear verbatim
 * (after NFKC/lowercase/whitespace normalisation); without evidence, at least
 * 60% of the title's content tokens must appear in the current turn text.
 */
export function isActionItemGroundedInTurn(
	item: { title: string; evidence?: string | null },
	turnText: string,
): boolean {
	const normalizedTurn = normalizeGroundingText(turnText)
	const evidence = item.evidence?.trim()
	if (evidence) {
		const normalizedEvidence = normalizeGroundingText(evidence)
		return (
			Boolean(normalizedEvidence) && normalizedTurn.includes(normalizedEvidence)
		)
	}
	const titleTokens = actionItemTitleTokens(item.title)
	if (!titleTokens.size) return false
	const turnTokens = actionItemTitleTokens(turnText)
	let present = 0
	for (const token of titleTokens) if (turnTokens.has(token)) present += 1
	return present / titleTokens.size >= GROUNDING_TOKEN_THRESHOLD
}

export type ActionItemSimilarityItem = {
	title: string
	ownerKey: string
	id?: string
	sourceKey?: string
}

export type ActionItemSimilarityMatch = {
	matched: boolean
	matchedCount: number
	totalCount: number
	ratio: number
	matches: Array<{
		incomingIndex: number
		incomingTitle: string
		existingTitle: string
		existingId?: string
		similarity: number
	}>
}

/**
 * Batch-level safety net. A new source is treated as the same extraction when
 * at least 60% of incoming items match an existing item (same owner key) at
 * Jaccard similarity 0.6 or better. Matching is greedy one-to-one: once an
 * existing item is matched it cannot satisfy another incoming item.
 */
export function matchActionItemBatch(
	incoming: ReadonlyArray<ActionItemSimilarityItem>,
	existing: ReadonlyArray<ActionItemSimilarityItem>,
): ActionItemSimilarityMatch {
	const matches: ActionItemSimilarityMatch["matches"] = []
	const usedExisting = new Set<number>()
	let matchedCount = 0
	for (const [incomingIndex, item] of incoming.entries()) {
		let best:
			| {
					existingIndex: number
					existing: ActionItemSimilarityItem
					similarity: number
			  }
			| undefined
		for (const [existingIndex, candidate] of existing.entries()) {
			if (usedExisting.has(existingIndex)) continue
			if (candidate.ownerKey !== item.ownerKey) continue
			const similarity = actionItemTitleSimilarity(item.title, candidate.title)
			if (!best || similarity > best.similarity) {
				best = { existingIndex, existing: candidate, similarity }
			}
		}
		if (best && best.similarity >= ACTION_ITEM_SIMILARITY_THRESHOLD) {
			usedExisting.add(best.existingIndex)
			matchedCount += 1
			matches.push({
				incomingIndex,
				incomingTitle: item.title,
				existingTitle: best.existing.title,
				existingId: best.existing.id,
				similarity: best.similarity,
			})
		}
	}
	const totalCount = incoming.length
	const ratio = totalCount ? matchedCount / totalCount : 0
	return {
		matched: totalCount > 0 && ratio >= ACTION_ITEM_BATCH_MATCH_THRESHOLD,
		matchedCount,
		totalCount,
		ratio,
		matches,
	}
}

export function isValidActionItemStatus(
	value: string,
): value is ActionItemStatus {
	return (ACTION_ITEM_STATUSES as ReadonlyArray<string>).includes(value)
}

export function isValidActionItemSource(
	value: string,
): value is ActionItemSource {
	return (ACTION_ITEM_SOURCES as ReadonlyArray<string>).includes(value)
}

export function isValidActionItemScope(scope: string): boolean {
	if (scope === "dm" || scope === "unknown") return true
	if (scope.startsWith("private:")) return scope.length > "private:".length
	if (scope.startsWith("public:")) return scope.length > "public:".length
	return false
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export function normalizeActionItemDue(
	value: string | null | undefined,
): { ok: true; due: string | null } | { ok: false; error: string } {
	const raw = value?.trim()
	if (!raw) return { ok: true, due: null }
	const match = raw.match(ISO_DATE_RE)
	const yearRaw = match?.[1]
	const monthRaw = match?.[2]
	const dayRaw = match?.[3]
	if (!yearRaw || !monthRaw || !dayRaw) {
		return { ok: false, error: "due must be an ISO date (YYYY-MM-DD)" }
	}
	const year = Number(yearRaw)
	const month = Number(monthRaw)
	const day = Number(dayRaw)
	const date = new Date(Date.UTC(year, month - 1, day))
	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day
	) {
		return { ok: false, error: "due must be a real calendar date (YYYY-MM-DD)" }
	}
	return { ok: true, due: raw }
}

export function actionItemScopeForSurface(surface: ActionItemSurface): string {
	switch (surface.kind) {
		case "dm":
			return "dm"
		case "private_channel":
			return `private:${surface.channelId}`
		case "public_channel":
			return `public:${surface.channelId}`
		case "unknown":
			return "unknown"
	}
}

/**
 * Scope-only read rule for channel surfaces. DM reads must use
 * isActionItemVisibleToAsker, because DM visibility also depends on owner and
 * created_by. When the surface is unknown, only unclassified items are
 * visible — the strict default.
 */
export function isActionItemVisibleOnSurface(
	scope: string,
	surface: ActionItemSurface,
): boolean {
	if (surface.kind === "dm") return true
	if (surface.kind === "unknown") return scope === "unknown"
	if (surface.kind === "public_channel") return scope.startsWith("public:")
	return (
		scope === `private:${surface.channelId}` || scope.startsWith("public:")
	)
}

export type ActionItemVisibility = Pick<
	BrainActionItem,
	"owner" | "scope" | "created_by"
>

/**
 * Read rule with asker identity. In a DM the ledger shows only items owned by
 * the asker, DM items the asker captured, and public items. Private-channel
 * items appear in a DM only when the asker owns them; legacy rows with no
 * creator are not shown in DMs.
 */
export function isActionItemVisibleToAsker(
	item: ActionItemVisibility,
	surface: ActionItemSurface,
	askerSlackUserId?: string | null,
): boolean {
	if (surface.kind !== "dm") {
		return isActionItemVisibleOnSurface(item.scope, surface)
	}
	// Legacy rows predate created_by; they are test data and stay hidden in DMs.
	if (!item.created_by) return false
	const asker = askerSlackUserId?.trim() ?? ""
	if (asker && item.owner === asker) return true
	if (item.scope.startsWith("public:")) return true
	return Boolean(asker) && item.scope === "dm" && item.created_by === asker
}

/**
 * Write rule: strictly narrowing. A turn may store at its own surface scope or
 * at a narrower scope (dm/unknown), never at a scope that would make the item
 * visible on a surface this turn is not in. This is deliberately different
 * from the read rule above.
 */
export function canStoreActionItemScope(
	scope: string,
	surface: ActionItemSurface,
): boolean {
	if (!isValidActionItemScope(scope)) return false
	if (scope === actionItemScopeForSurface(surface)) return true
	return scope === "dm" || scope === "unknown"
}

export function actionItemSurfaceForSlackLookup(
	lookup?: ActionItemSlackSurfaceInput,
): ActionItemSurface {
	if (!lookup) return { kind: "unknown" }
	// Never infer privacy from the channel id prefix: "C" channels can be
	// private. Without an explicit memory scope the only safe answer is unknown.
	const kind = lookup.memoryScope?.kind
	if (!kind) return { kind: "unknown" }
	if (kind === "dm") return { kind: "dm" }
	const channelId = lookup.memoryScope?.channelId?.trim() || lookup.channel.trim()
	if (kind === "private_channel" && channelId) {
		return { kind: "private_channel", channelId }
	}
	if (kind === "shared" && channelId) {
		return { kind: "public_channel", channelId }
	}
	return { kind: "unknown" }
}

export function describeActionItemSurface(surface: ActionItemSurface): string {
	switch (surface.kind) {
		case "dm":
			return "direct message (your own items, DM items you captured, and public items are visible)"
		case "private_channel":
			return `private channel ${surface.channelId} (its private items plus public items are visible)`
		case "public_channel":
			return `public channel ${surface.channelId} (only public items are visible)`
		case "unknown":
			return "unknown surface (only unclassified items are visible)"
	}
}

export function normalizeActionItemOwnerFilter(value: string): string {
	const trimmed = value.trim()
	const mention = trimmed.match(/^<@([^>|]+)(?:\|[^>]*)?>$/i)
	return (mention?.[1] ?? trimmed).trim().toLowerCase()
}

function asActionItemStatus(value: string): ActionItemStatus {
	return isValidActionItemStatus(value) ? value : "open"
}

function asActionItemSource(value: string): ActionItemSource {
	return isValidActionItemSource(value) ? value : "message"
}

function asOwnerResolution(value: string | null): ActionItemOwnerResolution {
	if (
		value === "id" ||
		value === "email" ||
		value === "handle" ||
		value === "name" ||
		value === "ambiguous" ||
		value === "unresolved"
	) {
		return value
	}
	return null
}

function mapActionItemRow(row: ActionItemRow): BrainActionItem {
	return {
		id: row.id,
		title: row.title,
		detail: row.detail,
		owner: row.owner,
		owner_name: row.owner_name,
		owner_resolution: asOwnerResolution(row.owner_resolution),
		status: asActionItemStatus(row.status),
		source: asActionItemSource(row.source),
		source_ref: row.source_ref,
		source_key: row.source_key,
		scope: row.scope,
		due: row.due,
		evidence: row.evidence,
		created_by: row.created_by,
		dedupe_key: row.dedupe_key,
		created_at: row.created_at,
		updated_at: row.updated_at,
	}
}

export type ActionItemInsert = {
	title: string
	detail?: string | null
	owner?: string | null
	ownerName?: string | null
	ownerResolution?: ActionItemOwnerResolution
	status?: ActionItemStatus
	source: ActionItemSource
	sourceRef?: string | null
	sourceKey?: string | null
	scope: string
	due?: string | null
	evidence?: string | null
	createdBy?: string | null
	dedupeKey: string
	now?: number
}

export type ActionItemInsertResult =
	| { status: "inserted"; id: string }
	| { status: "conflict"; id: string }
	| { status: "failed"; error: string }

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/**
 * Insert one item. A conflict is a real existing row with the same dedupe key;
 * a failed write is reported separately so it can never be counted as a
 * duplicate.
 */
export function insertActionItem(
	agent: CompanyBrainAgent,
	item: ActionItemInsert,
): ActionItemInsertResult {
	// Validate at the write boundary too: callers are typed, but persisted
	// rows must never carry a status, source, scope, or due the ledger rejects.
	const status = item.status ?? "open"
	if (!isValidActionItemStatus(status)) {
		throw new Error(`Invalid action item status: ${status}`)
	}
	if (!isValidActionItemSource(item.source)) {
		throw new Error(`Invalid action item source: ${item.source}`)
	}
	if (!isValidActionItemScope(item.scope)) {
		throw new Error(`Invalid action item scope: ${item.scope}`)
	}
	const due = normalizeActionItemDue(item.due)
	if (!due.ok) throw new Error(`Invalid action item due date: ${due.error}`)

	ensureActionItemTable(agent)
	try {
		const existing = agent.sql<{ id: string }>`
			SELECT id FROM brain_action_item WHERE dedupe_key = ${item.dedupeKey} LIMIT 1
		`
		const existingId = existing[0]?.id
		if (existingId) return { status: "conflict", id: existingId }
	} catch (error) {
		return { status: "failed", error: errorMessage(error) }
	}

	const id = `act_${crypto.randomUUID()}`
	const now = item.now ?? Date.now()
	try {
		agent.sql`
			INSERT INTO brain_action_item (
				id, title, detail, owner, owner_name, owner_resolution, status,
				source, source_ref, source_key, scope, due, evidence, created_by,
				dedupe_key, created_at, updated_at
			) VALUES (
				${id}, ${item.title}, ${item.detail ?? null}, ${item.owner ?? null},
				${item.ownerName ?? null}, ${item.ownerResolution ?? null},
				${status}, ${item.source}, ${item.sourceRef ?? null},
				${item.sourceKey ?? null}, ${item.scope}, ${due.due},
				${item.evidence ?? null}, ${item.createdBy ?? null},
				${item.dedupeKey}, ${now}, ${now}
			)
			ON CONFLICT(dedupe_key) DO NOTHING
		`
	} catch (error) {
		return { status: "failed", error: errorMessage(error) }
	}

	try {
		const stored = agent.sql<{ id: string }>`
			SELECT id FROM brain_action_item WHERE dedupe_key = ${item.dedupeKey} LIMIT 1
		`
		const storedId = stored[0]?.id
		if (!storedId) {
			return {
				status: "failed",
				error: "insert did not persist a brain_action_item row",
			}
		}
		return storedId === id
			? { status: "inserted", id }
			: { status: "conflict", id: storedId }
	} catch (error) {
		return { status: "failed", error: errorMessage(error) }
	}
}

export type ListActionItemsInput = {
	status?: ActionItemStatus
	owner?: string
	source?: ActionItemSource
	limit?: number
}

export type ListActionItemsResult = {
	items: BrainActionItem[]
	returned: number
	total: number
	statusCounts: Record<ActionItemStatus, number>
}

function matchesOwnerFilter(
	item: BrainActionItem,
	filter: string,
): boolean {
	if (!filter) return true
	if ((item.owner ?? "").toLowerCase() === filter) return true
	return (
		normalizeMemberMatchText(item.owner_name ?? "") ===
		normalizeMemberMatchText(filter)
	)
}

/**
 * Read the ledger for one surface. Privacy and owner/source filtering happen
 * before the status filter so the status breakdown always describes the same
 * visible set.
 */
export function listActionItems(
	agent: CompanyBrainAgent,
	surface: ActionItemSurface,
	input: ListActionItemsInput = {},
	askerSlackUserId?: string | null,
): ListActionItemsResult {
	ensureActionItemTable(agent)
	const rows = agent.sql<ActionItemRow>`
		SELECT * FROM brain_action_item
		ORDER BY created_at DESC, id DESC
	`
	const ownerFilter = input.owner ? normalizeActionItemOwnerFilter(input.owner) : ""
	const visible = rows
		.map(mapActionItemRow)
		.filter((item) =>
			isActionItemVisibleToAsker(item, surface, askerSlackUserId),
		)
		.filter((item) => !input.source || item.source === input.source)
		.filter((item) => matchesOwnerFilter(item, ownerFilter))

	const statusCounts: Record<ActionItemStatus, number> = {
		open: 0,
		in_progress: 0,
		done: 0,
		dropped: 0,
	}
	for (const item of visible) statusCounts[item.status] += 1

	const filtered = input.status
		? visible.filter((item) => item.status === input.status)
		: visible
	const limit = Math.min(Math.max(input.limit ?? 20, 1), 100)
	const items = filtered.slice(0, limit)
	return {
		items,
		returned: items.length,
		total: filtered.length,
		statusCounts,
	}
}

export type ActionItemSourceRow = {
	scope: string
	source_key: string
	item_count: number
	created_at: number
}

export type StoredActionItemSummary = {
	id: string
	title: string
}

export function lookupActionItemSource(
	agent: CompanyBrainAgent,
	scope: string,
	sourceKey: string,
): ActionItemSourceRow | undefined {
	ensureActionItemSourceTable(agent)
	const rows = agent.sql<ActionItemSourceRow>`
		SELECT scope, source_key, item_count, created_at
		FROM brain_action_item_source
		WHERE scope = ${scope} AND source_key = ${sourceKey}
		LIMIT 1
	`
	return rows[0]
}

export type StoredActionItemMatchRow = {
	id: string
	title: string
	owner: string | null
	ownerName: string | null
	createdAt: number
}

export type ActionItemMatchVisibility = {
	surface?: ActionItemSurface
	askerSlackUserId?: string | null
}

function isMatchRowVisible(
	row: {
		owner: string | null
		scope: string
		created_by: string | null
	},
	visibility?: ActionItemMatchVisibility,
): boolean {
	if (visibility?.surface?.kind !== "dm") return true
	return isActionItemVisibleToAsker(
		{
			owner: row.owner,
			scope: row.scope,
			created_by: row.created_by,
		},
		visibility.surface,
		visibility.askerSlackUserId,
	)
}

export function listStoredActionItemRowsForSource(
	agent: CompanyBrainAgent,
	scope: string,
	sourceKey: string,
	visibility?: ActionItemMatchVisibility,
): StoredActionItemMatchRow[] {
	ensureActionItemTable(agent)
	const rows = agent.sql<{
		id: string
		title: string
		owner: string | null
		owner_name: string | null
		scope: string
		created_by: string | null
		created_at: number
	}>`
		SELECT id, title, owner, owner_name, scope, created_by, created_at
		FROM brain_action_item
		WHERE scope = ${scope} AND source_key = ${sourceKey}
		ORDER BY created_at ASC, id ASC
	`
	return rows
		.filter((row) => isMatchRowVisible(row, visibility))
		.map((row) => ({
			id: row.id,
			title: row.title,
			owner: row.owner,
			ownerName: row.owner_name,
			createdAt: row.created_at,
		}))
}

export function listStoredActionItemsForSource(
	agent: CompanyBrainAgent,
	scope: string,
	sourceKey: string,
	visibility?: ActionItemMatchVisibility,
): StoredActionItemSummary[] {
	return listStoredActionItemRowsForSource(
		agent,
		scope,
		sourceKey,
		visibility,
	).map((row) => ({ id: row.id, title: row.title }))
}

export function countStoredActionItemsForSource(
	agent: CompanyBrainAgent,
	scope: string,
	sourceKey: string,
): number {
	ensureActionItemTable(agent)
	const rows = agent.sql<{ n: number }>`
		SELECT COUNT(*) AS n FROM brain_action_item
		WHERE scope = ${scope} AND source_key = ${sourceKey}
	`
	return rows[0]?.n ?? 0
}

export function recordActionItemSource(
	agent: CompanyBrainAgent,
	scope: string,
	sourceKey: string,
	itemCount: number,
	now = Date.now(),
): void {
	ensureActionItemSourceTable(agent)
	agent.sql`
		INSERT INTO brain_action_item_source (
			scope, source_key, item_count, created_at
		) VALUES (${scope}, ${sourceKey}, ${itemCount}, ${now})
		ON CONFLICT(scope, source_key) DO UPDATE SET
			item_count = excluded.item_count
	`
}

export type ActionItemSourceBatch = {
	sourceKey: string
	itemCount: number
	createdAt: number
	items: Array<{
		id: string
		title: string
		owner: string | null
		ownerName: string | null
	}>
}

export function listActionItemGroups(
	agent: CompanyBrainAgent,
	scope: string,
	visibility?: ActionItemMatchVisibility,
): ActionItemSourceBatch[] {
	ensureActionItemTable(agent)
	const rows = agent.sql<{
		id: string
		title: string
		owner: string | null
		owner_name: string | null
		source_key: string | null
		source_ref: string | null
		scope: string
		created_by: string | null
		created_at: number
	}>`
		SELECT
			id, title, owner, owner_name, source_key, source_ref, scope,
			created_by, created_at
		FROM brain_action_item
		WHERE scope = ${scope}
		ORDER BY created_at ASC, id ASC
	`
	const byLabel = new Map<string, ActionItemSourceBatch>()
	for (const row of rows) {
		if (!isMatchRowVisible(row, visibility)) continue
		// Group recorded sources by source_key; legacy rows fall back to their
		// provenance source_ref, then to one legacy bucket when both are absent.
		const sourceKey = row.source_key?.trim()
		const sourceRef = row.source_ref?.trim()
		const label = sourceKey || (sourceRef ? `ref:${sourceRef}` : "legacy:unknown")
		let group = byLabel.get(label)
		if (!group) {
			group = {
				sourceKey: label,
				itemCount: 0,
				createdAt: row.created_at,
				items: [],
			}
			byLabel.set(label, group)
		}
		group.items.push({
			id: row.id,
			title: row.title,
			owner: row.owner,
			ownerName: row.owner_name,
		})
		group.itemCount = group.items.length
		group.createdAt = Math.min(group.createdAt, row.created_at)
	}
	return [...byLabel.values()]
}

export type ActionItemSourceBatchMatch = {
	batch: ActionItemSourceBatch
	match: ActionItemSimilarityMatch
}

/** Best matching existing source batch for an incoming batch, if any. */
export function matchActionItemSourceBatch(
	incoming: ReadonlyArray<ActionItemSimilarityItem>,
	batches: ReadonlyArray<ActionItemSourceBatch>,
): ActionItemSourceBatchMatch | undefined {
	let best: ActionItemSourceBatchMatch | undefined
	for (const batch of batches) {
		const match = matchActionItemBatch(
			incoming,
			batch.items.map((item) => ({
				id: item.id,
				title: item.title,
				ownerKey: ownerDedupeKeyPart(item.owner, item.ownerName),
				sourceKey: batch.sourceKey,
			})),
		)
		if (!match.matched) continue
		if (!best || match.ratio > best.match.ratio) best = { batch, match }
	}
	return best
}

export type StoredActionItemOutput = {
	id: string
	title: string
	owner: string | null
	ownerName: string | null
	mention: string | null
	status: ActionItemStatus
}

export type StoreActionItemBatchItem = {
	title: string
	detail: string | null
	evidence: string | null
	due: string | null
	ownerId: string | null
	ownerName: string | null
	ownerResolution: ActionItemOwnerResolution
	dedupeKey: string
}

export type StoreActionItemBatchResult = {
	status: "stored" | "already_extracted" | "similar_batch" | "partial" | "failed"
	stored: StoredActionItemOutput[]
	duplicates: number
	conflicts: Array<{ title: string; existingId: string }>
	failed: Array<{ title: string; reason: string }>
	previouslyStored: StoredActionItemSummary[]
	matchedSource?: {
		sourceKey: string
		itemCount: number
		createdAt: number
	}
	matchedItems?: ActionItemSimilarityMatch["matches"]
	sourceTracked: boolean
	sourceError?: string
}

function matchRowsToSimilarity(
	rows: ReadonlyArray<StoredActionItemMatchRow>,
): ActionItemSimilarityItem[] {
	return rows.map((row) => ({
		id: row.id,
		title: row.title,
		ownerKey: ownerDedupeKeyPart(row.owner, row.ownerName),
	}))
}

function matchedItemsToSummaries(
	matches: ActionItemSimilarityMatch["matches"],
): StoredActionItemSummary[] {
	const byId = new Map<string, StoredActionItemSummary>()
	for (const match of matches) {
		if (!match.existingId) continue
		byId.set(match.existingId, {
			id: match.existingId,
			title: match.existingTitle,
		})
	}
	return [...byId.values()]
}

/**
 * Synchronous source-level idempotence block. There is deliberately no await
 * between the source SELECT, the item inserts, and the source INSERT, so two
 * interleaved DO calls cannot both store the same source. A source match only
 * skips the items that actually matched; genuinely new items are still stored.
 */
export function storeActionItemBatch(
	agent: CompanyBrainAgent,
	args: {
		scope: string
		surface?: ActionItemSurface
		sourceKey: string
		source: ActionItemSource
		sourceRef: string | null
		createdBy: string | null
		askerSlackUserId?: string | null
		items: ReadonlyArray<StoreActionItemBatchItem>
		now?: number
	},
): StoreActionItemBatchResult {
	const visibility: ActionItemMatchVisibility = {
		surface: args.surface,
		askerSlackUserId: args.askerSlackUserId,
	}
	const existing = lookupActionItemSource(agent, args.scope, args.sourceKey)
	const incomingSimilarity: ActionItemSimilarityItem[] = args.items.map(
		(item) => ({
			title: item.title,
			ownerKey: ownerDedupeKeyPart(item.ownerId, item.ownerName),
		}),
	)
	let matchedItems: ActionItemSimilarityMatch["matches"] = []
	let matchedSource: StoreActionItemBatchResult["matchedSource"]
	let duplicates = 0
	let itemsToStore: ReadonlyArray<StoreActionItemBatchItem> = args.items

	if (existing) {
		const existingRows = listStoredActionItemRowsForSource(
			agent,
			args.scope,
			args.sourceKey,
			visibility,
		)
		const match = matchActionItemBatch(
			incomingSimilarity,
			matchRowsToSimilarity(existingRows),
		)
		matchedItems = [...match.matches]
		matchedSource = {
			sourceKey: args.sourceKey,
			itemCount: existingRows.length,
			createdAt: existing.created_at,
		}
		duplicates = match.matchedCount
		const sourceMatchedIndexes = new Set(
			match.matches.map((item) => item.incomingIndex),
		)

		// A source can have been created from a similarity split that only
		// stored the unmatched subset. Compare the remainder with other groups
		// too, so a retry cannot re-store the items that belonged to the
		// earlier matched group.
		const remainingIndexes = args.items
			.map((_item, index) => index)
			.filter((index) => !sourceMatchedIndexes.has(index))
		if (remainingIndexes.length) {
			const otherGroups = listActionItemGroups(
				agent,
				args.scope,
				visibility,
			).filter((group) => group.sourceKey !== args.sourceKey)
			const otherMatch = matchActionItemSourceBatch(
				remainingIndexes.map((index) => incomingSimilarity[index]!),
				otherGroups,
			)
			if (otherMatch) {
				const crossMatches = otherMatch.match.matches.flatMap((item) => {
					const originalIndex = remainingIndexes[item.incomingIndex]
					return originalIndex === undefined
						? []
						: [{ ...item, incomingIndex: originalIndex }]
				})
				matchedItems = [...matchedItems, ...crossMatches]
				duplicates += crossMatches.length
				if (!match.matchedCount) {
					matchedSource = {
						sourceKey: otherMatch.batch.sourceKey,
						itemCount: otherMatch.batch.itemCount,
						createdAt: otherMatch.batch.createdAt,
					}
				}
			}
		}

		const matchedIndexes = new Set(
			matchedItems.map((item) => item.incomingIndex),
		)
		itemsToStore = args.items.filter(
			(_item, index) => !matchedIndexes.has(index),
		)
		if (!itemsToStore.length) {
			return {
				status: "already_extracted",
				stored: [],
				duplicates,
				conflicts: [],
				failed: [],
				previouslyStored: matchedItemsToSummaries(matchedItems),
				matchedSource,
				matchedItems,
				sourceTracked: true,
			}
		}
	} else {
		const similarity = matchActionItemSourceBatch(
			incomingSimilarity,
			listActionItemGroups(agent, args.scope, visibility),
		)
		if (similarity) {
			matchedItems = similarity.match.matches
			matchedSource = {
				sourceKey: similarity.batch.sourceKey,
				itemCount: similarity.batch.itemCount,
				createdAt: similarity.batch.createdAt,
			}
			duplicates = similarity.match.matchedCount
			const matchedIndexes = new Set(
				similarity.match.matches.map((item) => item.incomingIndex),
			)
			itemsToStore = args.items.filter(
				(_item, index) => !matchedIndexes.has(index),
			)
			if (!itemsToStore.length) {
				return {
					status: "similar_batch",
					stored: [],
					duplicates,
					conflicts: [],
					failed: [],
					previouslyStored: matchedItemsToSummaries(matchedItems),
					matchedSource,
					matchedItems,
					sourceTracked: false,
				}
			}
		}
	}

	const now = args.now ?? Date.now()
	const stored: StoredActionItemOutput[] = []
	const conflicts: Array<{ title: string; existingId: string }> = []
	const failed: Array<{ title: string; reason: string }> = []
	for (const item of itemsToStore) {
		const insert = insertActionItem(agent, {
			title: item.title,
			detail: item.detail,
			evidence: item.evidence,
			due: item.due,
			owner: item.ownerId,
			ownerName: item.ownerName,
			ownerResolution: item.ownerResolution,
			status: "open",
			source: args.source,
			sourceRef: args.sourceRef,
			sourceKey: args.sourceKey,
			scope: args.scope,
			createdBy: args.createdBy,
			dedupeKey: item.dedupeKey,
			now,
		})
		if (insert.status === "inserted") {
			stored.push({
				id: insert.id,
				title: item.title,
				owner: item.ownerId,
				ownerName: item.ownerName,
				mention: actionItemMention(item.ownerId, args.askerSlackUserId),
				status: "open",
			})
			continue
		}
		if (insert.status === "conflict") {
			conflicts.push({ title: item.title, existingId: insert.id })
			continue
		}
		failed.push({ title: item.title, reason: insert.error })
	}

	let sourceTracked = false
	let sourceError: string | undefined
	if (existing || stored.length > 0) {
		try {
			const total = countStoredActionItemsForSource(
				agent,
				args.scope,
				args.sourceKey,
			)
			recordActionItemSource(agent, args.scope, args.sourceKey, total, now)
			sourceTracked = true
		} catch (error) {
			sourceError = errorMessage(error)
		}
	}

	const status: StoreActionItemBatchResult["status"] = failed.length
		? stored.length || conflicts.length
			? "partial"
			: "failed"
		: conflicts.length
			? "partial"
			: "stored"
	return {
		status,
		stored,
		duplicates: duplicates + conflicts.length,
		conflicts,
		failed,
		previouslyStored: matchedItemsToSummaries(matchedItems),
		...(matchedSource ? { matchedSource } : {}),
		...(matchedItems.length ? { matchedItems } : {}),
		sourceTracked,
		...(sourceError ? { sourceError } : {}),
	}
}


export type ActionItemToolsArgs = {
	deps: TurnDeps
	agent: CompanyBrainAgent
	surface: ActionItemSurface
	directory: SlackMemberDirectoryCache
	traceId: string
	allowWrites: boolean
	channelId?: string
	turnTs?: string
	askerSlackUserId?: string
	/** Length of the current turn's message text; used by the extraction guard. */
	turnTextLength?: number
	/** Whether that text shows a speaker line, transcript marker, or commitment cue. */
	turnHasCommitmentContent?: boolean
	/** Current turn text (including attachment text) for item grounding. */
	turnText?: string
	/** Whether the current turn/thread carries a text transcript attachment. */
	hasTranscriptAttachment?: boolean
}

type UnresolvedOwner = { title: string; rawName: string }
type AmbiguousOwner = {
	title: string
	rawName: string
	candidates: Array<{ id: string; name: string; displayName?: string }>
}

type OwnerInput = {
	name?: string
	email?: string
	handle?: string
}

function ownerReferenceFromInput(
	owner: OwnerInput | undefined,
): { reference: SlackMemberReference; rawName: string } | null {
	if (!owner) return null
	const name = owner.name?.trim() || undefined
	const email = owner.email?.trim() || undefined
	const handle = owner.handle?.trim() || undefined
	if (!name && !email && !handle) return null
	return {
		reference: { name, email, handle },
		rawName: name ?? handle ?? email ?? "",
	}
}

/**
 * Shared mention rule for both extract and list results. The asker's own item
 * must never produce a self-ping; the prompt renders it as plain "you".
 */
export function actionItemMention(
	ownerId: string | null | undefined,
	askerSlackUserId?: string | null,
): string | null {
	if (!ownerId) return null
	const asker = askerSlackUserId?.trim()
	return ownerId === asker ? null : `<@${ownerId}>`
}

function formatActionItem(
	item: BrainActionItem,
	askerSlackUserId?: string | null,
) {
	return {
		id: item.id,
		title: item.title,
		detail: item.detail,
		status: item.status,
		source: item.source,
		sourceRef: item.source_ref,
		scope: item.scope,
		due: item.due,
		owner: item.owner
			? {
					slackUserId: item.owner,
					mention: actionItemMention(item.owner, askerSlackUserId),
					name: item.owner_name,
				}
			: null,
		ownerName: item.owner_name,
		ownerResolution: item.owner_resolution,
		evidence: item.evidence,
		createdAt: new Date(item.created_at).toISOString(),
		updatedAt: new Date(item.updated_at).toISOString(),
	}
}

export function createActionItemTools(args: ActionItemToolsArgs): ToolSet {
	const {
		deps,
		agent,
		surface,
		directory,
		traceId,
		allowWrites,
		channelId,
		turnTs,
		askerSlackUserId,
		turnTextLength,
		turnHasCommitmentContent,
		turnText,
		hasTranscriptAttachment,
	} = args
	const ownerSchema = deps.z.object({
		name: deps.z
			.string()
			.optional()
			.describe("Owner name exactly as written in the source."),
		email: deps.z.string().optional().describe("Owner email, if the source has it."),
		handle: deps.z
			.string()
			.optional()
			.describe("Slack handle, with or without the @."),
	})
	const tools: ToolSet = {
		list_action_items: deps.tool({
			description:
				"List stored action items with their real status from the action-item ledger. Visibility is decided by the current Slack surface: in a public channel you see only items stored from public channels; in a private channel you see that channel's private items plus public items. In a DM you see only items owned by you, DM items you captured, and public items; private-channel items appear in a DM only when you own them, and legacy items with no creator are not shown in DMs. When the surface is unknown, only items with unknown scope are visible. The returned status is stored and authoritative — never call it 'likely'. Use the total and statusCounts to summarize; use status/owner/source/limit to narrow.",
			inputSchema: deps.z.object({
				status: deps.z
					.enum(ACTION_ITEM_STATUSES)
					.optional()
					.describe("Only return items with this stored status."),
				owner: deps.z
					.string()
					.optional()
					.describe(
						"Slack user id (e.g. U123), a mention (<@U123>), or an owner name to filter by.",
					),
				source: deps.z
					.enum(ACTION_ITEM_SOURCES)
					.optional()
					.describe("Only return items from this source."),
				limit: deps.z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.describe("Max rows to return (default 20, max 100)."),
			}),
			execute: async (input) => {
				const startedAt = Date.now()
				const status = input.status
				const source = input.source
				if (status && !isValidActionItemStatus(status)) {
					return { error: `Unknown action-item status "${status}".` }
				}
				if (source && !isValidActionItemSource(source)) {
					return { error: `Unknown action-item source "${source}".` }
				}
				const result = listActionItems(
					agent,
					surface,
					{
						status,
						owner: input.owner,
						source,
						limit: input.limit,
					},
					askerSlackUserId,
				)
				console.log(
					`[company-brain][${traceId}] list_action_items surface=${surface.kind} status=${status ?? "any"} owner=${input.owner ?? "any"} returned=${result.returned} total=${result.total} ms=${Date.now() - startedAt}`,
				)
				return {
					surface: describeActionItemSurface(surface),
					items: result.items.map((item) =>
						formatActionItem(item, askerSlackUserId),
					),
					returned: result.returned,
					total: result.total,
					statusCounts: result.statusCounts,
					...(result.returned === 0
						? {
								message:
									"No stored action items match these filters on this surface.",
							}
						: {}),
				}
			},
		}),
	}
	if (!allowWrites) return tools

	tools.extract_action_items = deps.tool({
		description:
			"Store commitments extracted from a meeting transcript, pasted meeting notes, or Slack messages in the durable action-item ledger. Extraction is idempotent per source: the first extraction from a Slack message, file, or current turn is recorded, and re-extracting the same source stores nothing and reports the items already stored. The runtime derives the source identity from source_ref: a Slack message ts becomes slack:<channel>:<ts>, a Slack file id becomes file:<id>, and any unrecognized value falls back to the current turn's message ts. A batch that substantially overlaps an existing extraction in the same scope is also treated as a duplicate. Resolves owners against the Slack directory (one directory fetch per turn, shared with resolve_slack_members). Unresolved and ambiguous owners are returned explicitly — report them to the user, never invent an owner, and ask in the thread when a name is ambiguous. Call once per transcript with every item, up to 50. Not available in passive investigations, scheduled runs, or read-only turns.",
		inputSchema: deps.z.object({
			items: deps.z
				.array(
					deps.z.object({
						title: deps.z
							.string()
							.min(1)
							.describe("Short, actionable title of the commitment."),
						owner: ownerSchema
							.optional()
							.describe("Who owns it, as named in the source."),
						due: deps.z
							.string()
							.optional()
							.describe("Due date as an ISO date (YYYY-MM-DD), when stated."),
						evidence: deps.z
							.string()
							.optional()
							.describe("Verbatim quote from the transcript that supports this item."),
						detail: deps.z
							.string()
							.optional()
							.describe("Any extra context needed to act on the item."),
					}),
				)
				.min(1, "extract_action_items requires at least one item.")
				.max(50, "extract_action_items accepts at most 50 items per call."),
			source: deps.z
				.enum(["meeting", "message"])
				.describe("meeting for transcripts/notes; message for Slack messages."),
			source_ref: deps.z
				.string()
				.optional()
				.describe(
					"For a transcript that arrived earlier in the conversation, the exact Slack message ts shown in the context (e.g. 1762345678.123456). For a Slack file, its file id (F...). Omit for the current message or an attachment; the runtime then uses the current turn's message ts. Do not paraphrase this value: only a real ts or file id is an identity.",
				),
			scope: deps.z
				.string()
				.optional()
				.describe(
					"Optional stored scope override. It may only narrow visibility: use this turn's own surface scope, dm, or unknown. Anything broader — another public channel, any private scope outside the current private channel, or any public/private scope from a DM — is rejected with an error naming the current surface. Defaults to the current surface scope.",
				),
		}),
		execute: async (input) => {
			const startedAt = Date.now()
			const emptyResult = {
				stored: [],
				duplicates: 0,
				unresolvedOwners: [],
				ambiguousOwners: [],
			}
			if (!input.items.length) {
				return {
					...emptyResult,
					error:
						"No items were provided. Extract at least one commitment with a title before calling extract_action_items.",
				}
			}
			if (input.items.length > 50) {
				return {
					...emptyResult,
					error: `Too many items (${input.items.length}); call extract_action_items at most 50 items at a time.`,
				}
			}

			const requestedScope = input.scope?.trim()
			const scope = requestedScope || actionItemScopeForSurface(surface)
			if (!isValidActionItemScope(scope)) {
				return {
					...emptyResult,
					error: `Invalid scope "${scope}". Use dm, unknown, private:<channelId>, or public:<channelId>.`,
				}
			}
			if (!canStoreActionItemScope(scope, surface)) {
				return {
					...emptyResult,
					error: `Cannot store action items with scope "${scope}" from the current ${describeActionItemSurface(surface)}.`,
				}
			}

			const sourceRef = input.source_ref?.trim() || null
			if (
				input.source === "meeting" &&
				!sourceRef &&
				(turnTextLength ?? 0) < EXTRACT_GUARD_SHORT_MESSAGE_CHARS &&
				!turnHasCommitmentContent &&
				!hasTranscriptAttachment
			) {
				return {
					...emptyResult,
					alreadyExtracted: false,
					error:
						"extract_action_items rejected: this turn is a short message with no transcript attachment and no source_ref. Prior conversation is background, not an instruction to extract. Include the transcript in the current message, attach it, or pass the source_ref ts of the earlier message that contains it.",
				}
			}

			// An earlier source_ref is the explicit "extract from that earlier
			// message" path. It is only allowed when the current user message
			// actually asks for an earlier extraction.
			const currentTurnTs = turnTs?.trim()
			if (
				sourceRef &&
				turnText !== undefined &&
				currentTurnTs &&
				sourceRef !== currentTurnTs &&
				!requestsEarlierExtraction(turnText)
			) {
				console.warn(
					`[company-brain][${traceId}] extract_action_items rejected source_ref_not_requested source_ref=${sourceRef} turnTs=${currentTurnTs}`,
				)
				return {
					...emptyResult,
					alreadyExtracted: false,
					reason: "source_ref_not_requested",
					error:
						"extract_action_items rejected (source_ref_not_requested): the current message does not ask you to extract from an earlier transcript. Extract only from the current message or an attachment, or ask explicitly to extract from that earlier message.",
				}
			}

			type PreparedItem = {
				title: string
				detail: string | null
				evidence: string | null
				due: string | null
				owner: { reference: SlackMemberReference; rawName: string } | null
			}
			const prepared: PreparedItem[] = []
			const rejected: Array<{ title: string; reason: string }> = []
			for (const item of input.items) {
				const title = item.title.trim()
				if (!title) {
					rejected.push({ title: item.title, reason: "empty title" })
					continue
				}
				const due = normalizeActionItemDue(item.due)
				if (!due.ok) {
					rejected.push({ title, reason: due.error })
					continue
				}
				if (
					findNonDecisionMarker([title, item.evidence, item.detail]) !==
					undefined
				) {
					rejected.push({ title, reason: "non-decision" })
					continue
				}
				// When the source is the current turn, every item must be
				// grounded in what the user just sent. Supplies of an explicit
				// source_ref are the earlier-message path and skip this check.
				if (
					input.source === "meeting" &&
					!sourceRef &&
					turnText !== undefined &&
					!isActionItemGroundedInTurn(
						{ title, evidence: item.evidence },
						turnText,
					)
				) {
					rejected.push({ title, reason: "not_from_current_message" })
					continue
				}
				prepared.push({
					title,
					detail: item.detail?.trim() || null,
					evidence: item.evidence?.trim() || null,
					due: due.due,
					owner: ownerReferenceFromInput(item.owner),
				})
			}

			let sourceIdentity = resolveActionItemSourceIdentity({
				sourceRef,
				channelId,
				turnTs,
			})
			const sourceWarnings: string[] = []
			if (sourceIdentity?.warning) sourceWarnings.push(sourceIdentity.warning)

			if (!prepared.length) {
				return {
					stored: [],
					duplicates: 0,
					unresolvedOwners: [],
					ambiguousOwners: [],
					rejected,
					warnings: [
						`${rejected.length} item(s) were rejected: ${rejected
							.map((item) => `"${item.title}" (${item.reason})`)
							.join(", ")}.`,
					],
					alreadyExtracted: false,
					scope,
					source: input.source,
					sourceRef,
					sourceKey: sourceIdentity?.sourceKey,
					sourceKind: sourceIdentity?.kind,
				}
			}

			let directoryMembers: SlackMemberDirectoryResult = {
				ok: false,
				error: "No owner references to resolve.",
			}
			let directoryError: string | undefined
			if (prepared.some((item) => item.owner)) {
				directoryMembers = await directory.load()
				if (!directoryMembers.ok) directoryError = directoryMembers.error
			}

			const unresolvedOwners: UnresolvedOwner[] = []
			const ambiguousOwners: AmbiguousOwner[] = []
			const resolved: Array<Omit<StoreActionItemBatchItem, "dedupeKey">> = []
			for (const item of prepared) {
				let ownerId: string | null = null
				let ownerName: string | null = null
				let ownerResolution: ActionItemOwnerResolution = null

				if (item.owner) {
					const resolution = directoryMembers.ok
						? resolveSlackMemberReference(
								item.owner.reference,
								directoryMembers.members,
							)
						: ({ status: "unresolved" } as const)
					if (resolution.status === "resolved") {
						ownerId = resolution.member.id
						ownerName =
							resolution.matchedBy === "id"
								? (resolution.member.displayName ?? resolution.member.name)
								: item.owner.rawName ||
									resolution.member.displayName ||
									resolution.member.name
						ownerResolution =
							resolution.matchedBy === "id"
								? "id"
								: resolution.matchedBy === "email"
									? "email"
									: resolution.matchedBy === "handle"
										? "handle"
										: "name"
					} else if (resolution.status === "ambiguous") {
						ownerName = item.owner.rawName
						ownerResolution = "ambiguous"
						ambiguousOwners.push({
							title: item.title,
							rawName: item.owner.rawName,
							candidates: resolution.candidates,
						})
					} else {
						ownerName = item.owner.rawName
						ownerResolution = "unresolved"
						unresolvedOwners.push({
							title: item.title,
							rawName: item.owner.rawName,
						})
					}
				}

				resolved.push({
					title: item.title,
					detail: item.detail,
					evidence: item.evidence,
					due: item.due,
					ownerId,
					ownerName,
					ownerResolution,
				})
			}

			if (!sourceIdentity) {
				sourceIdentity = {
					sourceKey: await buildTitleFallbackSourceKey({
						scope,
						items: resolved.map((item) => ({
							title: item.title,
							ownerId: item.ownerId,
							ownerName: item.ownerName,
						})),
					}),
					kind: "title_fallback",
					warning: TITLE_FALLBACK_SOURCE_WARNING,
				}
				sourceWarnings.push(TITLE_FALLBACK_SOURCE_WARNING)
			}

			// Slack-identified sources get a source-scoped row key, not a
			// title-based one: the source table is the idempotence gate.
			const resolvedItems: StoreActionItemBatchItem[] = await Promise.all(
				resolved.map(async (item) => ({
					...item,
					dedupeKey:
						sourceIdentity.kind === "title_fallback"
							? await buildActionItemDedupeKey({
									scope,
									title: item.title,
									ownerId: item.ownerId,
									ownerName: item.ownerName,
								})
							: `row:${crypto.randomUUID()}`,
				})),
			)

			// Synchronous block: source SELECT, item inserts, and source INSERT
			// must not yield to another DO event.
			const storeResult = storeActionItemBatch(agent, {
				scope,
				surface,
				sourceKey: sourceIdentity.sourceKey,
				source: input.source,
				sourceRef,
				createdBy: askerSlackUserId?.trim() || null,
				askerSlackUserId,
				items: resolvedItems,
			})

			const warnings: string[] = [...sourceWarnings]
			if (unresolvedOwners.length) {
				warnings.push(
					`UNRESOLVED OWNERS (${unresolvedOwners.length}): ${unresolvedOwners
						.map((owner) => `"${owner.rawName}" for "${owner.title}"`)
						.join(", ")}. These items are unassigned. Do not invent an owner; name them as unassigned and ask who should own them.`,
				)
			}
			if (ambiguousOwners.length) {
				warnings.push(
					`AMBIGUOUS OWNERS (${ambiguousOwners.length}): ${ambiguousOwners
						.map(
							(owner) =>
								`"${owner.rawName}" for "${owner.title}" (${owner.candidates
									.map((candidate) => candidate.name)
									.join(" / ")})`,
						)
						.join(", ")}. Do not choose one; ask in the thread which person is meant.`,
				)
			}
			if (storeResult.status === "already_extracted") {
				warnings.push(
					"This source was already extracted. Nothing new was stored.",
				)
			}
			if (storeResult.status === "similar_batch") {
				const matchedSource = storeResult.matchedSource
				const matchedCount = storeResult.matchedItems?.length ?? 0
				warnings.push(
					`SIMILAR BATCH: this batch substantially matches previously extracted source ${matchedSource?.sourceKey ?? "unknown"} (${matchedCount}/${resolvedItems.length} items with Jaccard >= ${ACTION_ITEM_SIMILARITY_THRESHOLD}). Nothing new was stored.`,
				)
			}
			if (
				(storeResult.status === "stored" ||
					storeResult.status === "partial") &&
				storeResult.matchedSource &&
				storeResult.matchedItems?.length
			) {
				warnings.push(
					`MATCHED EXISTING: ${storeResult.matchedItems.length}/${resolvedItems.length} item(s) already exist in source ${storeResult.matchedSource.sourceKey}; ${storeResult.stored.length} new item(s) were stored.`,
				)
			}
			if (storeResult.failed.length) {
				warnings.push(
					`FAILED INSERTS (${storeResult.failed.length}): ${storeResult.failed
						.map((item) => `"${item.title}" (${item.reason})`)
						.join(", ")}. These items were not stored; retry to store the remainder.`,
				)
			}
			if (storeResult.conflicts.length) {
				warnings.push(
					`ALREADY STORED ELSEWHERE (${storeResult.conflicts.length}): ${storeResult.conflicts
						.map((item) => `"${item.title}" (${item.existingId})`)
						.join(", ")}. These items already existed with the same dedupe key and were not inserted again.`,
				)
			}
			if (storeResult.sourceError) {
				warnings.push(
					`Items were stored but the source record could not be written: ${storeResult.sourceError}. A retry may duplicate them.`,
				)
			}
			if (rejected.length) {
				warnings.push(
					`${rejected.length} item(s) were rejected: ${rejected
						.map((item) => `"${item.title}" (${item.reason})`)
						.join(", ")}.`,
				)
			}
			if (directoryError) {
				warnings.push(
					`Slack directory lookup failed: ${directoryError} All owners are unresolved.`,
				)
			}
			const alreadyExtracted =
				storeResult.status === "already_extracted" ||
				storeResult.status === "similar_batch"
			console.log(
				`[company-brain][${traceId}] extract_action_items source=${input.source} scope=${scope} sourceKind=${sourceIdentity.kind} status=${storeResult.status} stored=${storeResult.stored.length} duplicates=${storeResult.duplicates} unresolved=${unresolvedOwners.length} ambiguous=${ambiguousOwners.length} rejected=${rejected.length} ms=${Date.now() - startedAt}`,
			)
			return {
				stored: storeResult.stored,
				duplicates: storeResult.duplicates,
				unresolvedOwners,
				ambiguousOwners,
				rejected,
				warnings,
				alreadyExtracted,
				previouslyStored: storeResult.previouslyStored,
				scope,
				source: input.source,
				sourceRef,
				sourceKey: sourceIdentity.sourceKey,
				sourceKind: sourceIdentity.kind,
				sourceTracked: storeResult.sourceTracked,
				...(storeResult.matchedSource
					? { matchedSource: storeResult.matchedSource }
					: {}),
				...(storeResult.matchedItems
					? { matchedItems: storeResult.matchedItems }
					: {}),
				...(storeResult.conflicts.length
					? { conflicts: storeResult.conflicts }
					: {}),
				...(storeResult.failed.length ? { failed: storeResult.failed } : {}),
				...(directoryError ? { directoryError } : {}),
			}
		},
	})
	return tools
}
