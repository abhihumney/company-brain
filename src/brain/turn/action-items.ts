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

export type ActionItemOwnerResolution =
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
	scope: string
	due: string | null
	evidence: string | null
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
	scope: string
	due: string | null
	evidence: string | null
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
			scope TEXT NOT NULL,
			due TEXT,
			evidence TEXT,
			dedupe_key TEXT NOT NULL UNIQUE,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`
	agent.sql`
		CREATE INDEX IF NOT EXISTS brain_action_item_status_owner
		ON brain_action_item (status, owner)
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

export function normalizeActionItemOwnerName(value: string | null | undefined): string {
	return (value ?? "")
		.normalize("NFKC")
		.replace(/[\u00a0\u2007\u202f\u200b-\u200d\ufeff]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase()
}

function normalizeSourceRefFamily(
	value: string | null | undefined,
	source: ActionItemSource,
): string {
	const normalized = (value ?? "")
		.normalize("NFKC")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase()
	return `${source}:${normalized ? `ref:${normalized}` : "ref:none"}`
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
 * Stable pre-hash payload. The dedupe key is a hash of normalised title,
 * resolved owner id (or raw owner name), and the source_ref family, so
 * re-extracting the same transcript does not duplicate rows.
 */
export function actionItemDedupePayload(input: {
	title: string
	ownerId?: string | null
	ownerName?: string | null
	sourceRef?: string | null
	source: ActionItemSource
}): string {
	return [
		normalizeActionItemTitle(input.title),
		ownerDedupeKeyPart(input.ownerId, input.ownerName),
		normalizeSourceRefFamily(input.sourceRef, input.source),
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
	title: string
	ownerId?: string | null
	ownerName?: string | null
	sourceRef?: string | null
	source: ActionItemSource
}): Promise<string> {
	return sha256Hex(actionItemDedupePayload(input))
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
 * A public channel sees only public items. A private channel sees its own
 * private items plus public ones. A DM sees the whole org ledger. When the
 * surface is unknown, only unclassified items are visible — the strict default.
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

/** A turn may only store items at a scope it could read back on that surface. */
export function canStoreActionItemScope(
	scope: string,
	surface: ActionItemSurface,
): boolean {
	return (
		isValidActionItemScope(scope) &&
		isActionItemVisibleOnSurface(scope, surface)
	)
}

export function actionItemSurfaceForSlackLookup(
	lookup?: ActionItemSlackSurfaceInput,
): ActionItemSurface {
	if (!lookup) return { kind: "unknown" }
	const channelId = lookup.memoryScope?.channelId?.trim() || lookup.channel.trim()
	if (lookup.memoryScope?.kind === "dm") return { kind: "dm" }
	if (!lookup.memoryScope && channelId.startsWith("D")) return { kind: "dm" }
	if (lookup.memoryScope?.kind === "private_channel" && channelId) {
		return { kind: "private_channel", channelId }
	}
	if (channelId) return { kind: "public_channel", channelId }
	return { kind: "unknown" }
}

export function describeActionItemSurface(surface: ActionItemSurface): string {
	switch (surface.kind) {
		case "dm":
			return "direct message (all org action items are visible)"
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
		scope: row.scope,
		due: row.due,
		evidence: row.evidence,
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
	scope: string
	due?: string | null
	evidence?: string | null
	dedupeKey: string
	now?: number
}

/**
 * Insert one item, deduping on dedupe_key. Returns the existing id when the
 * item was already stored.
 */
export function insertActionItem(
	agent: CompanyBrainAgent,
	item: ActionItemInsert,
): { inserted: boolean; id: string } {
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
	const existing = agent.sql<{ id: string }>`
		SELECT id FROM brain_action_item WHERE dedupe_key = ${item.dedupeKey} LIMIT 1
	`
	const existingId = existing[0]?.id
	if (existingId) return { inserted: false, id: existingId }

	const id = `act_${crypto.randomUUID()}`
	const now = item.now ?? Date.now()
	agent.sql`
		INSERT INTO brain_action_item (
			id, title, detail, owner, owner_name, owner_resolution, status, source,
			source_ref, scope, due, evidence, dedupe_key, created_at, updated_at
		) VALUES (
			${id}, ${item.title}, ${item.detail ?? null}, ${item.owner ?? null},
			${item.ownerName ?? null}, ${item.ownerResolution ?? null},
			${status}, ${item.source}, ${item.sourceRef ?? null},
			${item.scope}, ${due.due}, ${item.evidence ?? null},
			${item.dedupeKey}, ${now}, ${now}
		)
		ON CONFLICT(dedupe_key) DO NOTHING
	`
	const stored = agent.sql<{ id: string }>`
		SELECT id FROM brain_action_item WHERE dedupe_key = ${item.dedupeKey} LIMIT 1
	`
	const storedId = stored[0]?.id
	return { inserted: storedId === id, id: storedId ?? id }
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
): ListActionItemsResult {
	ensureActionItemTable(agent)
	const rows = agent.sql<ActionItemRow>`
		SELECT * FROM brain_action_item
		ORDER BY created_at DESC, id DESC
	`
	const ownerFilter = input.owner ? normalizeActionItemOwnerFilter(input.owner) : ""
	const visible = rows
		.map(mapActionItemRow)
		.filter((item) => isActionItemVisibleOnSurface(item.scope, surface))
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

export type ActionItemToolsArgs = {
	deps: TurnDeps
	agent: CompanyBrainAgent
	surface: ActionItemSurface
	directory: SlackMemberDirectoryCache
	traceId: string
	allowWrites: boolean
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

function formatActionItem(item: BrainActionItem) {
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
					mention: `<@${item.owner}>`,
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
	const { deps, agent, surface, directory, traceId, allowWrites } = args
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
				"List stored action items with their real status from the action-item ledger. Visibility is decided by the current Slack surface: in a public channel you see only items stored from public channels; in a private channel you see that channel's private items plus public items; in a DM you see every item in the org. When the surface is unknown, only items with unknown scope are visible. The returned status is stored and authoritative — never call it 'likely'. Use the total and statusCounts to summarize; use status/owner/source/limit to narrow.",
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
				const result = listActionItems(agent, surface, {
					status,
					owner: input.owner,
					source,
					limit: input.limit,
				})
				console.log(
					`[company-brain][${traceId}] list_action_items surface=${surface.kind} status=${status ?? "any"} owner=${input.owner ?? "any"} returned=${result.returned} total=${result.total} ms=${Date.now() - startedAt}`,
				)
				return {
					surface: describeActionItemSurface(surface),
					items: result.items.map(formatActionItem),
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
			"Store commitments extracted from a meeting transcript, pasted meeting notes, or Slack messages in the durable action-item ledger. Deduplicates by normalised title + owner + source_ref, so re-extracting the same transcript is safe and reports how many rows were skipped. Resolves owners against the Slack directory (one directory fetch per turn, shared with resolve_slack_members). Unresolved and ambiguous owners are returned explicitly — report them to the user, never invent an owner, and ask in the thread when a name is ambiguous. Call once per transcript with every item, up to 50. Not available in passive investigations, scheduled runs, or read-only turns.",
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
					"Stable reference for the source, e.g. the transcript file name/id or thread reference. Reuse the same value when re-extracting the same transcript so dedupe works.",
				),
			scope: deps.z
				.string()
				.optional()
				.describe(
					"Optional stored scope override: dm, unknown, private:<channelId>, or public:<channelId>. Defaults to the current Slack surface. A scope you could not read back on this surface is rejected.",
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

			type PreparedItem = {
				index: number
				title: string
				detail: string | null
				evidence: string | null
				due: string | null
				owner: { reference: SlackMemberReference; rawName: string } | null
			}
			const prepared: PreparedItem[] = []
			const rejected: Array<{ index: number; title: string; reason: string }> =
				[]
			for (const [index, item] of input.items.entries()) {
				const title = item.title.trim()
				if (!title) {
					rejected.push({ index, title: item.title, reason: "empty title" })
					continue
				}
				const due = normalizeActionItemDue(item.due)
				if (!due.ok) {
					rejected.push({ index, title, reason: due.error })
					continue
				}
				prepared.push({
					index,
					title,
					detail: item.detail?.trim() || null,
					evidence: item.evidence?.trim() || null,
					due: due.due,
					owner: ownerReferenceFromInput(item.owner),
				})
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

			const stored: Array<{
				id: string
				title: string
				owner: string | null
				ownerName: string | null
				status: ActionItemStatus
			}> = []
			const unresolvedOwners: UnresolvedOwner[] = []
			const ambiguousOwners: AmbiguousOwner[] = []
			const seenKeys = new Set<string>()
			let duplicates = 0

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
							item.owner.rawName ||
							resolution.member.displayName ||
							resolution.member.name
						ownerResolution =
							resolution.matchedBy === "email"
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

				const dedupeKey = await buildActionItemDedupeKey({
					title: item.title,
					ownerId,
					ownerName,
					sourceRef: input.source_ref,
					source: input.source,
				})
				if (seenKeys.has(dedupeKey)) {
					duplicates += 1
					continue
				}
				seenKeys.add(dedupeKey)
				const insert = insertActionItem(agent, {
					title: item.title,
					detail: item.detail,
					owner: ownerId,
					ownerName,
					ownerResolution,
					status: "open",
					source: input.source,
					sourceRef: input.source_ref?.trim() || null,
					scope,
					due: item.due,
					evidence: item.evidence,
					dedupeKey,
				})
				if (!insert.inserted) {
					duplicates += 1
					continue
				}
				stored.push({
					id: insert.id,
					title: item.title,
					owner: ownerId,
					ownerName,
					status: "open",
				})
			}

			const warnings: string[] = []
			if (unresolvedOwners.length) {
				warnings.push(
					`UNRESOLVED OWNERS (${unresolvedOwners.length}): ${unresolvedOwners
						.map((owner) => `"${owner.rawName}" for "${owner.title}"`)
						.join(", ")}. These items were stored unassigned. Do not invent an owner; name them as unassigned and ask who should own them.`,
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
			if (duplicates > 0) {
				warnings.push(
					`${duplicates} item(s) were already stored from this source and were skipped as duplicates.`,
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
					`Slack directory lookup failed: ${directoryError} All owners are stored unresolved.`,
				)
			}
			console.log(
				`[company-brain][${traceId}] extract_action_items source=${input.source} scope=${scope} stored=${stored.length} duplicates=${duplicates} unresolved=${unresolvedOwners.length} ambiguous=${ambiguousOwners.length} rejected=${rejected.length} ms=${Date.now() - startedAt}`,
			)
			return {
				stored,
				duplicates,
				unresolvedOwners,
				ambiguousOwners,
				rejected,
				warnings,
				scope,
				source: input.source,
				sourceRef: input.source_ref?.trim() || null,
				...(directoryError ? { directoryError } : {}),
			}
		},
	})
	return tools
}
