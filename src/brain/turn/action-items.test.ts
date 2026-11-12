import { tool } from "ai"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import type { CompanyBrainAgent } from "./agent"
import {
	ACTION_ITEM_SIMILARITY_THRESHOLD,
	NON_DECISION_MARKERS,
	actionItemDedupePayload,
	actionItemScopeForSurface,
	actionItemSurfaceForSlackLookup,
	actionItemTitleSimilarity,
	buildActionItemDedupeKey,
	buildTitleFallbackSourceKey,
	canStoreActionItemScope,
	createActionItemTools,
	describeActionItemSurface,
	findNonDecisionMarker,
	hasCommitmentContent,
	insertActionItem,
	isActionItemGroundedInTurn,
	isActionItemVisibleOnSurface,
	isActionItemVisibleToAsker,
	isValidActionItemScope,
	isValidActionItemSource,
	isValidActionItemStatus,
	matchActionItemBatch,
	normalizeActionItemDue,
	normalizeActionItemOwnerFilter,
	normalizeActionItemTitle,
	normalizeNonDecisionText,
	requestsEarlierExtraction,
	resolveActionItemSourceIdentity,
	type ActionItemSource,
	type ActionItemStatus,
	type ActionItemSurface,
} from "./action-items"
import type { TurnDeps } from "./deps"
import type { SlackMember } from "../slack/client"
import { buildSystemPrompt } from "../prompt/system"

type FakeRow = Record<string, unknown>
type FakeSourceRow = {
	scope: string
	source_key: string
	item_count: number
	created_at: number
}

function createFakeActionItemAgent(
	options: {
		failItemInsert?: boolean
		failItemTitles?: Set<string>
	} = {},
): {
	agent: CompanyBrainAgent
	rows: FakeRow[]
	sources: FakeSourceRow[]
} {
	const rows: FakeRow[] = []
	const sources: FakeSourceRow[] = []
	const sql = (
		strings: TemplateStringsArray,
		...values: unknown[]
	): unknown[] => {
		const text = strings.join("?")
		if (/PRAGMA table_info/i.test(text)) {
			return [
				"id",
				"title",
				"detail",
				"owner",
				"owner_name",
				"owner_resolution",
				"status",
				"source",
				"source_ref",
				"source_key",
				"scope",
				"due",
				"evidence",
				"created_by",
				"dedupe_key",
				"created_at",
				"updated_at",
			].map((name) => ({ name }))
		}
		if (/CREATE TABLE|CREATE INDEX/i.test(text)) return []
		if (
			/SELECT scope, source_key, item_count, created_at/i.test(text) &&
			/FROM brain_action_item_source/i.test(text)
		) {
			return sources.filter(
				(source) =>
					source.scope === values[0] && source.source_key === values[1],
			)
		}
		if (
			/SELECT id, title, owner, owner_name, scope, created_by, created_at/i.test(
				text,
			)
		) {
			return rows
				.filter(
					(row) => row.scope === values[0] && row.source_key === values[1],
				)
				.map((row) => ({
					id: row.id,
					title: row.title,
					owner: row.owner,
					owner_name: row.owner_name,
					scope: row.scope,
					created_by: row.created_by,
					created_at: row.created_at,
				}))
		}
		if (
			/SELECT\s+id, title, owner, owner_name, source_key, source_ref, scope,/i.test(
				text,
			)
		) {
			return rows
				.filter((row) => row.scope === values[0])
				.map((row) => ({
					id: row.id,
					title: row.title,
					owner: row.owner,
					owner_name: row.owner_name,
					source_key: row.source_key,
					source_ref: row.source_ref,
					scope: row.scope,
					created_by: row.created_by,
					created_at: row.created_at,
				}))
		}
		if (/SELECT COUNT\(\*\) AS n FROM brain_action_item/i.test(text)) {
			return [
				{
					n: rows.filter(
						(row) =>
							row.scope === values[0] && row.source_key === values[1],
					).length,
				},
			]
		}
		if (/SELECT id, title FROM brain_action_item/i.test(text)) {
			return rows
				.filter(
					(row) => row.scope === values[0] && row.source_key === values[1],
				)
				.map((row) => ({ id: row.id, title: row.title }))
		}
		if (/SELECT id FROM brain_action_item WHERE dedupe_key/i.test(text)) {
			return rows
				.filter((row) => row.dedupe_key === values[0])
				.map((row) => ({ id: row.id }))
		}
		if (/INSERT INTO brain_action_item_source/i.test(text)) {
			const [scope, source_key, item_count, created_at] = values
			const existing = sources.find(
				(source) => source.scope === scope && source.source_key === source_key,
			)
			if (existing) {
				existing.item_count = item_count as number
			} else {
				sources.push({
					scope: scope as string,
					source_key: source_key as string,
					item_count: item_count as number,
					created_at: created_at as number,
				})
			}
			return []
		}
		if (/INSERT INTO brain_action_item/i.test(text)) {
			if (
				options.failItemInsert ||
				options.failItemTitles?.has(String(values[1]))
			) {
				throw new Error("simulated action-item insert failure")
			}
			const [
				id,
				title,
				detail,
				owner,
				owner_name,
				owner_resolution,
				status,
				source,
				source_ref,
				source_key,
				scope,
				due,
				evidence,
				created_by,
				dedupe_key,
				created_at,
				updated_at,
			] = values
			if (!rows.some((row) => row.dedupe_key === dedupe_key)) {
				rows.push({
					id,
					title,
					detail,
					owner,
					owner_name,
					owner_resolution,
					status,
					source,
					source_ref,
					source_key,
					scope,
					due,
					evidence,
					created_by,
					dedupe_key,
					created_at,
					updated_at,
				})
			}
			return []
		}
		if (/SELECT \* FROM brain_action_item/i.test(text)) return [...rows]
		throw new Error(`Unhandled fake SQL: ${text}`)
	}
	return { agent: { sql } as unknown as CompanyBrainAgent, rows, sources }
}

type ExtractToolResult = {
	stored: Array<{
		id: string
		title: string
		owner: string | null
		mention: string | null
	}>
	duplicates: number
	alreadyExtracted?: boolean
	previouslyStored?: Array<{ id: string; title: string }>
	failed?: Array<{ title: string; reason: string }>
	rejected?: Array<{ title: string; reason: string }>
	matchedSource?: { sourceKey: string }
	warnings?: string[]
	sourceKey?: string
	error?: string
	reason?: string
}

function createExtractHarness(
	options: {
		failItemInsert?: boolean
		failItemTitles?: Set<string>
		turnTextLength?: number
		turnHasCommitmentContent?: boolean
		turnText?: string
		hasTranscriptAttachment?: boolean
		directoryMembers?: SlackMember[]
		askerSlackUserId?: string
		seedRows?: FakeRow[]
	} = {},
) {
	const fake = createFakeActionItemAgent(options)
	if (options.seedRows) fake.rows.push(...options.seedRows)
	const tools = createActionItemTools({
		deps: { z, tool } as unknown as TurnDeps,
		agent: fake.agent,
		surface: { kind: "dm" },
		directory: {
			load: async () => ({
				ok: true as const,
				members: options.directoryMembers ?? [],
			}),
		},
		traceId: "test",
		allowWrites: true,
		channelId: "D1",
		turnTs: "1762345679.000001",
		askerSlackUserId: options.askerSlackUserId ?? "U-ASKER",
		turnTextLength: options.turnTextLength ?? 500,
		turnHasCommitmentContent: options.turnHasCommitmentContent ?? false,
		turnText: options.turnText,
		hasTranscriptAttachment: options.hasTranscriptAttachment ?? false,
	})
	const extract = tools.extract_action_items as unknown as {
		execute(input: unknown): Promise<ExtractToolResult>
	}
	return { ...fake, extract }
}

describe("normalizeActionItemTitle", () => {
	it("folds case, whitespace, non-breaking spaces, and trailing punctuation", () => {
		expect(normalizeActionItemTitle("  Send\u00a0 the   deck. ")).toBe(
			"send the deck",
		)
		expect(normalizeActionItemTitle("Ship API v2.0")).toBe("ship api v2.0")
	})

	it("treats only real differences as different titles", () => {
		expect(normalizeActionItemTitle("Fix billing!")).toBe(
			normalizeActionItemTitle("  fix   billing "),
		)
		expect(normalizeActionItemTitle("Fix billing")).not.toBe(
			normalizeActionItemTitle("Fix invoices"),
		)
	})
})

describe("dedupe", () => {
	it("hashes the same normalised title and owner to the same key", async () => {
		const first = buildActionItemDedupeKey({
			scope: "dm",
			title: "Send the deck",
			ownerId: "U1",
		})
		const second = buildActionItemDedupeKey({
			scope: "dm",
			title: "  send  THE deck. ",
			ownerId: "U1",
		})
		expect(await first).toBe(await second)
	})

	it("changes the key when the owner changes", () => {
		const payload = (ownerId: string | null, ownerName: string | null) =>
			actionItemDedupePayload({
				scope: "dm",
				title: "Send the deck",
				ownerId,
				ownerName,
			})
		expect(payload("U1", null)).not.toBe(payload("U2", null))
		expect(payload(null, "Priya Shah")).not.toBe(payload(null, "Sam Rivera"))
		expect(payload("U1", "Priya")).toBe(payload("u1", "Someone Else"))
	})

	it("changes the key when the stored scope changes", () => {
		const payload = (scope: string) =>
			actionItemDedupePayload({
				scope,
				title: "Send the deck",
				ownerId: "U1",
			})
		expect(payload("dm")).not.toBe(payload("public:C1"))
		expect(payload("public:C1")).not.toBe(payload("private:C1"))
	})
})

describe("validateActionItemInput", () => {
	it("accepts the four statuses and three sources only", () => {
		for (const status of ["open", "in_progress", "done", "dropped"]) {
			expect(isValidActionItemStatus(status)).toBe(true)
		}
		expect(isValidActionItemStatus("closed")).toBe(false)
		for (const source of ["meeting", "message", "manual"]) {
			expect(isValidActionItemSource(source)).toBe(true)
		}
		expect(isValidActionItemSource("email")).toBe(false)
	})

	it("accepts ISO dates, real calendar dates, and empty due dates", () => {
		expect(normalizeActionItemDue("2028-02-29")).toEqual({
			ok: true,
			due: "2028-02-29",
		})
		expect(normalizeActionItemDue("2027-02-29").ok).toBe(false)
		expect(normalizeActionItemDue("2026-13-01").ok).toBe(false)
		expect(normalizeActionItemDue("tomorrow").ok).toBe(false)
		expect(normalizeActionItemDue("")).toEqual({ ok: true, due: null })
		expect(normalizeActionItemDue(undefined)).toEqual({ ok: true, due: null })
	})

	it("validates stored scope shapes", () => {
		for (const scope of ["dm", "unknown", "private:C1", "public:C2"]) {
			expect(isValidActionItemScope(scope)).toBe(true)
		}
		for (const scope of ["team", "private:", "public:", "public"]) {
			expect(isValidActionItemScope(scope)).toBe(false)
		}
	})
})

describe("surface privacy", () => {
	const dm: ActionItemSurface = { kind: "dm" }
	const publicC1: ActionItemSurface = {
		kind: "public_channel",
		channelId: "C1",
	}
	const privateC1: ActionItemSurface = {
		kind: "private_channel",
		channelId: "C1",
	}
	const unknown: ActionItemSurface = { kind: "unknown" }

	it("lets a DM see every scope", () => {
		for (const scope of ["dm", "unknown", "private:C2", "public:C9"]) {
			expect(isActionItemVisibleOnSurface(scope, dm)).toBe(true)
		}
	})

	it("restricts a public channel to public items", () => {
		expect(isActionItemVisibleOnSurface("public:C1", publicC1)).toBe(true)
		expect(isActionItemVisibleOnSurface("public:C9", publicC1)).toBe(true)
		for (const scope of ["dm", "unknown", "private:C1"]) {
			expect(isActionItemVisibleOnSurface(scope, publicC1)).toBe(false)
		}
	})

	it("lets a private channel see its own private items plus public items", () => {
		expect(isActionItemVisibleOnSurface("private:C1", privateC1)).toBe(true)
		expect(isActionItemVisibleOnSurface("public:C9", privateC1)).toBe(true)
		for (const scope of ["private:C2", "dm", "unknown"]) {
			expect(isActionItemVisibleOnSurface(scope, privateC1)).toBe(false)
		}
	})

	it("defaults to the strictest view when the surface is unknown", () => {
		expect(isActionItemVisibleOnSurface("unknown", unknown)).toBe(true)
		for (const scope of ["dm", "private:C1", "public:C1"]) {
			expect(isActionItemVisibleOnSurface(scope, unknown)).toBe(false)
		}
	})

	it("only lets a DM store dm or unknown scope", () => {
		expect(canStoreActionItemScope("dm", dm)).toBe(true)
		expect(canStoreActionItemScope("unknown", dm)).toBe(true)
		expect(canStoreActionItemScope("public:C1", dm)).toBe(false)
		expect(canStoreActionItemScope("private:C2", dm)).toBe(false)
	})

	it("lets a public channel store its own scope, dm, or unknown", () => {
		expect(canStoreActionItemScope("public:C1", publicC1)).toBe(true)
		expect(canStoreActionItemScope("dm", publicC1)).toBe(true)
		expect(canStoreActionItemScope("unknown", publicC1)).toBe(true)
		expect(canStoreActionItemScope("public:C2", publicC1)).toBe(false)
		expect(canStoreActionItemScope("private:C1", publicC1)).toBe(false)
	})

	it("lets a private channel store its own scope, dm, or unknown", () => {
		const privateC2: ActionItemSurface = {
			kind: "private_channel",
			channelId: "C2",
		}
		expect(canStoreActionItemScope("private:C2", privateC2)).toBe(true)
		expect(canStoreActionItemScope("dm", privateC2)).toBe(true)
		expect(canStoreActionItemScope("unknown", privateC2)).toBe(true)
		expect(canStoreActionItemScope("private:C3", privateC2)).toBe(false)
		expect(canStoreActionItemScope("public:C1", privateC2)).toBe(false)
	})

	it("only lets an unknown surface store unknown or dm", () => {
		expect(canStoreActionItemScope("unknown", unknown)).toBe(true)
		expect(canStoreActionItemScope("dm", unknown)).toBe(true)
		expect(canStoreActionItemScope("public:C1", unknown)).toBe(false)
		expect(canStoreActionItemScope("private:C1", unknown)).toBe(false)
	})

	it("rejects malformed scopes on every surface", () => {
		for (const surface of [dm, publicC1, privateC1, unknown]) {
			expect(canStoreActionItemScope("not-a-scope", surface)).toBe(false)
		}
	})
})

describe("surface derivation", () => {
	it("maps Slack lookup kinds to stored scopes", () => {
		expect(
			actionItemSurfaceForSlackLookup({
				channel: "D1",
				memoryScope: { kind: "dm", channelId: "D1" },
			}),
		).toEqual({ kind: "dm" })
		expect(
			actionItemSurfaceForSlackLookup({
				channel: "C1",
				memoryScope: { kind: "private_channel", channelId: "C1" },
			}),
		).toEqual({ kind: "private_channel", channelId: "C1" })
		expect(
			actionItemSurfaceForSlackLookup({
				channel: "C2",
				memoryScope: { kind: "shared", channelId: "C2" },
			}),
		).toEqual({ kind: "public_channel", channelId: "C2" })
		expect(
			actionItemSurfaceForSlackLookup({
				channel: "C1",
				memoryScope: { kind: "shared", channelId: "C1" },
			}),
		).toEqual({ kind: "public_channel", channelId: "C1" })
		// Without an explicit memory scope, privacy cannot be guessed from the
		// channel id prefix: C channels can be private and D is not enough.
		expect(actionItemSurfaceForSlackLookup({ channel: "D9" })).toEqual({
			kind: "unknown",
		})
		expect(actionItemSurfaceForSlackLookup({ channel: "C9" })).toEqual({
			kind: "unknown",
		})
		expect(actionItemSurfaceForSlackLookup(undefined)).toEqual({
			kind: "unknown",
		})
	})

	it("round-trips a surface to its stored scope", () => {
		expect(actionItemScopeForSurface({ kind: "dm" })).toBe("dm")
		expect(actionItemScopeForSurface({ kind: "unknown" })).toBe("unknown")
		expect(
			actionItemScopeForSurface({ kind: "private_channel", channelId: "C1" }),
		).toBe("private:C1")
		expect(
			actionItemScopeForSurface({ kind: "public_channel", channelId: "C1" }),
		).toBe("public:C1")
	})

	it("describes the surface for the model", () => {
		expect(describeActionItemSurface({ kind: "dm" })).toContain(
			"your own items",
		)
		expect(
			describeActionItemSurface({ kind: "public_channel", channelId: "C1" }),
		).toContain("only public items")
	})
})

describe("source identity", () => {
	const ts = "1762345678.123456"

	it("uses a Slack message ts with the channel", () => {
		expect(
			resolveActionItemSourceIdentity({
				sourceRef: ts,
				channelId: "C1",
				turnTs: "1762345679.000001",
			}),
		).toEqual({ sourceKey: `slack:C1:${ts}`, kind: "slack_message" })
	})

	it("uses a Slack file id", () => {
		expect(
			resolveActionItemSourceIdentity({
				sourceRef: "F0123ABCD",
				channelId: "C1",
			}),
		).toEqual({ sourceKey: "file:F0123ABCD", kind: "slack_file" })
	})

	it("falls back to the current turn ts and ignores a model-written source_ref", () => {
		const identity = resolveActionItemSourceIdentity({
			sourceRef: "RBK test - Q4 launch sync (synthetic transcript)",
			channelId: "C1",
			turnTs: "1762345679.000001",
		})
		expect(identity).toEqual({
			sourceKey: "slack:C1:1762345679.000001",
			kind: "turn_message",
			warning:
				"source_ref was not a Slack message ts or file id, so the current turn's message ts was used as the source identity.",
		})
	})

	it("returns no source identity for a non-Slack turn", () => {
		expect(
			resolveActionItemSourceIdentity({ sourceRef: "some transcript" }),
		).toBeUndefined()
		expect(
			resolveActionItemSourceIdentity({
				sourceRef: ts,
				channelId: undefined,
				turnTs: undefined,
			}),
		).toBeUndefined()
	})

	it("builds a stable title fallback for non-Slack turns", async () => {
		const first = await buildTitleFallbackSourceKey({
			scope: "dm",
			items: [
				{ title: "Send the deck", ownerId: "U1" },
				{ title: "Book the offsite", ownerId: "U2" },
			],
		})
		const reordered = await buildTitleFallbackSourceKey({
			scope: "dm",
			items: [
				{ title: "Book the offsite", ownerId: "U2" },
				{ title: "Send the deck", ownerId: "U1" },
			],
		})
		const different = await buildTitleFallbackSourceKey({
			scope: "dm",
			items: [{ title: "Send the deck", ownerId: "U1" }],
		})
		expect(first).toBe(reordered)
		expect(first).not.toBe(different)
		expect(first.startsWith("title:")).toBe(true)
	})
})

describe("batch similarity safety net", () => {
	const pass1 = [
		"Finalize and circulate the Q1 budget draft to finance",
		"Send vendor spend numbers",
		"Update the travel policy",
	]
	const pass2 = [
		"Circulate the Q1 budget draft to finance",
		"Pull vendor spend numbers and send to Abhishek",
		"Update the travel policy before month end",
		"Get Q1 budget signed off",
	]

	it("matches each paraphrase pair at or above the 0.6 similarity threshold", () => {
		for (let index = 0; index < pass1.length; index++) {
			const similarity = actionItemTitleSimilarity(
				pass2[index] ?? "",
				pass1[index] ?? "",
			)
			expect(similarity).toBeGreaterThanOrEqual(
				ACTION_ITEM_SIMILARITY_THRESHOLD,
			)
		}
	})

	it("treats the four-item paraphrase batch as the same extraction", () => {
		const match = matchActionItemBatch(
			pass2.map((title) => ({ title, ownerKey: "id:u1" })),
			pass1.map((title) => ({ title, ownerKey: "id:u1" })),
		)
		expect(match.matched).toBe(true)
		expect(match.matchedCount).toBe(3)
		expect(match.ratio).toBe(0.75)
	})

	it("does not merge a weak small batch", () => {
		const match = matchActionItemBatch(
			[{ title: "Get Q1 budget signed off", ownerKey: "id:u1" }],
			pass1.map((title) => ({ title, ownerKey: "id:u1" })),
		)
		expect(match.matched).toBe(false)
	})

	it("does not let one existing item satisfy multiple incoming items", () => {
		const match = matchActionItemBatch(
			[
				{ title: "Review launch plan", ownerKey: "id:u1" },
				{ title: "Review the launch plan", ownerKey: "id:u1" },
				{ title: "Review launch plans", ownerKey: "id:u1" },
			],
			[{ title: "Review launch plan", ownerKey: "id:u1" }],
		)
		expect(match.matchedCount).toBe(1)
		expect(match.ratio).toBeCloseTo(1 / 3)
		expect(match.matched).toBe(false)
	})

	it("requires the same owner key", () => {
		const match = matchActionItemBatch(
			[{ title: pass2[0] ?? "", ownerKey: "id:u2" }],
			pass1.map((title) => ({ title, ownerKey: "id:u1" })),
		)
		expect(match.matched).toBe(false)
	})
})

describe("DM visibility", () => {
	const dm: ActionItemSurface = { kind: "dm" }
	const asker = "U-ASKER"

	it("shows items owned by the asker, DM items they captured, and public items", () => {
		expect(
			isActionItemVisibleToAsker(
				{ owner: asker, scope: "private:C2", created_by: "U-OTHER" },
				dm,
				asker,
			),
		).toBe(true)
		expect(
			isActionItemVisibleToAsker(
				{ owner: null, scope: "dm", created_by: asker },
				dm,
				asker,
			),
		).toBe(true)
		expect(
			isActionItemVisibleToAsker(
				{ owner: null, scope: "public:C1", created_by: "U-OTHER" },
				dm,
				asker,
			),
		).toBe(true)
		expect(
			isActionItemVisibleToAsker(
				{ owner: "U-OTHER", scope: "public:C1", created_by: asker },
				dm,
				asker,
			),
		).toBe(true)
	})

	it("never shows private-channel items unless owned, and hides legacy rows", () => {
		expect(
			isActionItemVisibleToAsker(
				{ owner: "U-OTHER", scope: "private:C2", created_by: asker },
				dm,
				asker,
			),
		).toBe(false)
		expect(
			isActionItemVisibleToAsker(
				{ owner: null, scope: "dm", created_by: null },
				dm,
				asker,
			),
		).toBe(false)
		// Legacy rows predate created_by and stay hidden even when owned by the
		// asker or carrying a public scope.
		expect(
			isActionItemVisibleToAsker(
				{ owner: asker, scope: "private:C2", created_by: null },
				dm,
				asker,
			),
		).toBe(false)
		expect(
			isActionItemVisibleToAsker(
				{ owner: null, scope: "public:C1", created_by: null },
				dm,
				asker,
			),
		).toBe(false)
		expect(
			isActionItemVisibleToAsker(
				{ owner: null, scope: "unknown", created_by: asker },
				dm,
				asker,
			),
		).toBe(false)
	})

	it("leaves public and private channel rules unchanged", () => {
		const publicC1: ActionItemSurface = {
			kind: "public_channel",
			channelId: "C1",
		}
		const privateC1: ActionItemSurface = {
			kind: "private_channel",
			channelId: "C1",
		}
		expect(
			isActionItemVisibleToAsker(
				{ owner: null, scope: "public:C9", created_by: null },
				publicC1,
				asker,
			),
		).toBe(true)
		expect(
			isActionItemVisibleToAsker(
				{ owner: null, scope: "private:C1", created_by: null },
				publicC1,
				asker,
			),
		).toBe(false)
		expect(
			isActionItemVisibleToAsker(
				{ owner: null, scope: "private:C1", created_by: null },
				privateC1,
				asker,
			),
		).toBe(true)
		expect(
			isActionItemVisibleToAsker(
				{ owner: null, scope: "public:C9", created_by: null },
				privateC1,
				asker,
			),
		).toBe(true)
	})

	it("filters the DM ledger by asker in list_action_items", async () => {
		const fake = createFakeActionItemAgent()
		const base = {
			detail: null,
			owner: null,
			owner_name: null,
			owner_resolution: null,
			status: "open",
			source: "manual",
			source_ref: null,
			source_key: null,
			scope: "dm",
			due: null,
			evidence: null,
			created_by: null,
			created_at: 1000,
			updated_at: 1000,
		}
		fake.rows.push(
			{
				...base,
				id: "owned",
				title: "Owned private item",
				owner: asker,
				scope: "private:C9",
				created_by: asker,
				dedupe_key: "owned",
			},
			{
				...base,
				id: "captured",
				title: "Captured DM item",
				created_by: asker,
				dedupe_key: "captured",
			},
			{
				...base,
				id: "public",
				title: "Public item",
				owner: "U-OTHER",
				owner_name: "Priya Shah",
				scope: "public:C1",
				created_by: asker,
				dedupe_key: "public",
			},
			{
				...base,
				id: "private-other",
				title: "Private item owned by someone else",
				owner: "U-OTHER",
				scope: "private:C2",
				created_by: asker,
				dedupe_key: "private-other",
			},
			{
				...base,
				id: "legacy",
				title: "Legacy DM item",
				dedupe_key: "legacy",
			},
			{
				...base,
				id: "unknown",
				title: "Unknown-scope item",
				scope: "unknown",
				created_by: asker,
				dedupe_key: "unknown",
			},
		)
		const tools = createActionItemTools({
			deps: { z, tool } as unknown as TurnDeps,
			agent: fake.agent,
			surface: { kind: "dm" },
			directory: {
				load: async () => ({ ok: true as const, members: [] }),
			},
			traceId: "test",
			allowWrites: false,
			askerSlackUserId: asker,
		})
		const list = tools.list_action_items as unknown as {
			execute(input: unknown): Promise<{
				items: Array<{
					id: string
					owner: { slackUserId: string; mention: string | null } | null
				}>
			}>
		}
		const result = await list.execute({})
		expect(result.items.map((item) => item.id).sort()).toEqual([
			"captured",
			"owned",
			"public",
		])
		const owned = result.items.find((item) => item.id === "owned")
		const publicItem = result.items.find((item) => item.id === "public")
		expect(owned?.owner?.mention).toBeNull()
		expect(publicItem?.owner?.mention).toBe("<@U-OTHER>")
	})
})

describe("owner filter", () => {
	it("normalises raw ids, mentions, and names", () => {
		expect(normalizeActionItemOwnerFilter("U123")).toBe("u123")
		expect(normalizeActionItemOwnerFilter(" <@U123> ")).toBe("u123")
		expect(normalizeActionItemOwnerFilter("<@U123|Priya>")).toBe("u123")
		expect(normalizeActionItemOwnerFilter(" Priya Shah ")).toBe("priya shah")
	})
})

describe("write gate", () => {
	const deps = { z, tool } as unknown as TurnDeps
	const directory = {
		load: async () => ({ ok: true as const, members: [] }),
	}
	const base = {
		deps,
		agent: {} as CompanyBrainAgent,
		surface: { kind: "dm" } as ActionItemSurface,
		directory,
		traceId: "test",
	}

	it("exposes only the read tool when writes are disallowed", () => {
		const tools = createActionItemTools({ ...base, allowWrites: false })
		expect(Object.keys(tools).sort()).toEqual(["list_action_items"])
	})

	it("exposes extract_action_items only when writes are allowed", () => {
		const tools = createActionItemTools({ ...base, allowWrites: true })
		expect(Object.keys(tools).sort()).toEqual([
			"extract_action_items",
			"list_action_items",
		])
	})

	it("rejects a widening scope override from a DM and stores nothing", async () => {
		const tools = createActionItemTools({
			...base,
			// Any SQL call means the write gate let the widening scope through.
			agent: {
				sql: () => {
					throw new Error("SQL should not run for a rejected scope")
				},
			} as unknown as CompanyBrainAgent,
			allowWrites: true,
		})
		const extract = tools.extract_action_items as unknown as {
			execute(input: unknown): Promise<{ error?: string; stored?: unknown[] }>
		}
		const result = await extract.execute({
			items: [{ title: "Ship the deck" }],
			source: "meeting",
			scope: "public:C1",
		})
		expect(result.error).toContain(
			'Cannot store action items with scope "public:C1"',
		)
		expect(result.error).toContain("direct message")
		expect(result.stored).toEqual([])
	})
})

describe("insertActionItem write validation", () => {
	const base = {
		title: "Send the deck",
		source: "meeting" as const,
		scope: "dm",
		dedupeKey: "key",
	}
	// Validation runs before any SQL, so a bare agent is enough here.
	const agent = {} as CompanyBrainAgent

	it("rejects statuses, sources, scopes, and due dates the ledger disallows", () => {
		expect(() =>
			insertActionItem(agent, {
				...base,
				status: "closed" as unknown as ActionItemStatus,
			}),
		).toThrow(/status/)
		expect(() =>
			insertActionItem(agent, {
				...base,
				source: "email" as unknown as ActionItemSource,
			}),
		).toThrow(/source/)
		expect(() =>
			insertActionItem(agent, { ...base, scope: "team" }),
		).toThrow(/scope/)
		expect(() =>
			insertActionItem(agent, { ...base, due: "tomorrow" }),
		).toThrow(/due/)
	})
})

describe("extract dedupe across source_ref variants", () => {
	it("stores four items once, then skips all four when source_ref is worded differently", async () => {
		const { agent, rows } = createFakeActionItemAgent()
		const members: SlackMember[] = [
			{ id: "U1", name: "Priya Shah", handle: "priya" },
			{ id: "U2", name: "Sam Rivera", handle: "sam.r" },
			{ id: "U3", name: "Sam Chen", handle: "sam.c" },
		]
		const tools = createActionItemTools({
			deps: { z, tool } as unknown as TurnDeps,
			agent,
			surface: { kind: "dm" },
			directory: {
				load: async () => ({ ok: true as const, members }),
			},
			traceId: "test",
			allowWrites: true,
		})
		const extract = tools.extract_action_items as unknown as {
			execute(input: unknown): Promise<{
				stored: Array<{
					title: string
					owner: string | null
					mention: string | null
				}>
				duplicates: number
			}>
		}
		const items = [
			{ title: "Send the deck", owner: { name: "Priya Shah" } },
			{ title: "Book the offsite", owner: { name: "Sam Rivera" } },
			{ title: "Write the runbook", owner: { name: "Sam Chen" } },
			{ title: "Unassigned follow-up" },
		]

		const first = await extract.execute({
			items,
			source: "meeting",
			source_ref: "RBK test - Q4 launch sync (synthetic transcript)",
		})
		expect(first.stored).toHaveLength(4)
		expect(first.duplicates).toBe(0)
		expect(first.stored[0]?.mention).toBe("<@U1>")
		expect(first.stored[3]?.mention).toBeNull()

		const second = await extract.execute({
			items,
			source: "meeting",
			source_ref: "RBK-test-q4-launch-sync-transcript-synthetic",
		})
		expect(second.stored).toHaveLength(0)
		expect(second.duplicates).toBe(4)
		expect(rows).toHaveLength(4)
	})
})

describe("source-level idempotence", () => {
	it("stores once per Slack source ts and reports the existing items on retry", async () => {
		const { extract, rows } = createExtractHarness()
		const items = [
			{ title: "Send the deck" },
			{ title: "Book the offsite" },
		]
		const sourceRef = "1762345678.123456"

		const first = await extract.execute({
			items,
			source: "meeting",
			source_ref: sourceRef,
		})
		expect(first.stored).toHaveLength(2)
		expect(first.duplicates).toBe(0)
		expect(first.alreadyExtracted).toBe(false)
		expect(first.sourceKey).toBe(`slack:D1:${sourceRef}`)
		expect(rows).toHaveLength(2)
		expect(rows[0]?.created_by).toBe("U-ASKER")
		expect(rows[0]?.source_key).toBe(`slack:D1:${sourceRef}`)

		const second = await extract.execute({
			items,
			source: "meeting",
			source_ref: sourceRef,
		})
		expect(second.stored).toEqual([])
		expect(second.duplicates).toBe(2)
		expect(second.alreadyExtracted).toBe(true)
		expect(
			second.previouslyStored?.map((item) => item.title).sort(),
		).toEqual(["Book the offsite", "Send the deck"])
		expect(rows).toHaveLength(2)
	})

	it("catches a paraphrased re-extraction from a different source ts", async () => {
		const { extract, rows } = createExtractHarness()
		const first = await extract.execute({
			items: [
				{ title: "Finalize and circulate the Q1 budget draft to finance" },
				{ title: "Send vendor spend numbers" },
				{ title: "Update the travel policy" },
			],
			source: "meeting",
			source_ref: "1762345678.111111",
		})
		expect(first.stored).toHaveLength(3)

		const second = await extract.execute({
			items: [
				{ title: "Circulate the Q1 budget draft to finance" },
				{ title: "Pull vendor spend numbers and send to Abhishek" },
				{ title: "Update the travel policy before month end" },
				{ title: "Get Q1 budget signed off" },
			],
			source: "meeting",
			source_ref: "1762345678.222222",
		})
		expect(second.stored).toHaveLength(1)
		expect(second.stored[0]?.title).toBe("Get Q1 budget signed off")
		expect(second.alreadyExtracted).toBe(false)
		expect(second.duplicates).toBe(3)
		expect(second.matchedSource?.sourceKey).toBe(
			"slack:D1:1762345678.111111",
		)
		expect(
			second.warnings?.some((warning) => warning.includes("MATCHED EXISTING")),
		).toBe(true)
		expect(rows).toHaveLength(4)

		const third = await extract.execute({
			items: [
				{ title: "Circulate the Q1 budget draft to finance" },
				{ title: "Pull vendor spend numbers and send to Abhishek" },
				{ title: "Update the travel policy before month end" },
				{ title: "Get Q1 budget signed off" },
			],
			source: "meeting",
			source_ref: "1762345678.222222",
		})
		expect(third.stored).toEqual([])
		expect(third.duplicates).toBe(4)
		expect(third.alreadyExtracted).toBe(true)
		expect(rows).toHaveLength(4)
	})

	it("does not block a weakly overlapping new source on an identical title", async () => {
		const { extract, rows } = createExtractHarness()
		const first = await extract.execute({
			items: [
				{ title: "Send the deck" },
				{ title: "Book the offsite" },
				{ title: "Write the runbook" },
			],
			source: "meeting",
			source_ref: "1762345678.444444",
		})
		expect(first.stored).toHaveLength(3)
		const second = await extract.execute({
			items: [
				{ title: "Send the deck" },
				{ title: "Hire a designer" },
				{ title: "Review pricing" },
				{ title: "Plan offsite menu" },
			],
			source: "meeting",
			source_ref: "1762345678.555555",
		})
		// Only 1 of 4 overlaps the earlier batch (25%), below the 60% net, so
		// this is a new extraction even though one title is identical.
		expect(second.stored).toHaveLength(4)
		expect(second.alreadyExtracted).toBe(false)
		expect(rows).toHaveLength(7)
	})

	it("surfaces a failed insert instead of reporting it as a duplicate", async () => {
		const { extract, rows, sources } = createExtractHarness({
			failItemInsert: true,
		})
		const result = await extract.execute({
			items: [{ title: "Send the deck" }],
			source: "meeting",
			source_ref: "1762345678.333333",
		})
		expect(result.stored).toEqual([])
		expect(result.duplicates).toBe(0)
		expect(result.failed).toHaveLength(1)
		expect(result.failed?.[0]?.reason).toContain(
			"simulated action-item insert failure",
		)
		expect(
			result.warnings?.some((warning) => warning.includes("FAILED INSERTS")),
		).toBe(true)
		expect(rows).toHaveLength(0)
		expect(sources).toHaveLength(0)
	})

	it("stores the remainder after a partial insert failure on retry", async () => {
		const failTitles = new Set(["Book the offsite"])
		const { extract, rows, sources } = createExtractHarness({
			failItemTitles: failTitles,
		})
		const items = [
			{ title: "Send the deck" },
			{ title: "Book the offsite" },
		]
		const sourceRef = "1762345678.555555"

		const first = await extract.execute({
			items,
			source: "meeting",
			source_ref: sourceRef,
		})
		expect(first.stored).toHaveLength(1)
		expect(first.failed).toHaveLength(1)
		expect(sources[0]?.item_count).toBe(1)

		failTitles.clear()
		const second = await extract.execute({
			items,
			source: "meeting",
			source_ref: sourceRef,
		})
		expect(second.stored).toHaveLength(1)
		expect(second.stored[0]?.title).toBe("Book the offsite")
		expect(second.duplicates).toBe(1)
		expect(second.failed).toBeUndefined()
		expect(rows).toHaveLength(2)
		expect(sources[0]?.item_count).toBe(2)
	})

	it("stores items beyond the first 50 across two calls to the same source", async () => {
		const { extract, rows, sources } = createExtractHarness()
		const sourceRef = "1762345678.666666"
		const firstItems = Array.from({ length: 50 }, (_, index) => ({
			title: `Commitment ${index + 1}`,
		}))
		const first = await extract.execute({
			items: firstItems,
			source: "meeting",
			source_ref: sourceRef,
		})
		expect(first.stored).toHaveLength(50)
		expect(sources[0]?.item_count).toBe(50)

		const second = await extract.execute({
			items: [
				{ title: "Commitment 1" },
				{ title: "Commitment 2" },
				{ title: "Commitment 51" },
				{ title: "Commitment 52" },
			],
			source: "meeting",
			source_ref: sourceRef,
		})
		expect(second.stored).toHaveLength(2)
		expect(second.duplicates).toBe(2)
		expect(second.alreadyExtracted).toBe(false)
		expect(rows).toHaveLength(52)
		expect(sources[0]?.item_count).toBe(52)
	})
})

describe("commitment content predicate", () => {
	it("recognises speaker lines, transcript markers, and commitment cues", () => {
		expect(
			hasCommitmentContent("Alice will send the deck. Bob books the room."),
		).toBe(true)
		expect(hasCommitmentContent("Alice: I'll send the deck.")).toBe(true)
		expect(hasCommitmentContent("Here is the meeting transcript.")).toBe(true)
		expect(hasCommitmentContent("Need to update the deck")).toBe(true)
		expect(hasCommitmentContent("Due Friday")).toBe(true)
		expect(hasCommitmentContent("I will follow up tomorrow")).toBe(true)
	})

	it("does not treat a contentless check as a commitment", () => {
		expect(hasCommitmentContent("quick check, please reply briefly")).toBe(
			false,
		)
		expect(hasCommitmentContent("")).toBe(false)
	})
})

describe("extract guard", () => {
	const items = [{ title: "Send the deck" }]

	it("rejects a short meeting call with no source_ref and no attachment", async () => {
		const { extract, rows } = createExtractHarness({ turnTextLength: 50 })
		const result = await extract.execute({ items, source: "meeting" })
		expect(result.error).toContain(
			"short message with no transcript attachment",
		)
		expect(result.error).toContain("Prior conversation is background")
		expect(result.stored).toEqual([])
		expect(rows).toHaveLength(0)
	})

	it("allows a long current message with no source_ref", async () => {
		const { extract } = createExtractHarness({ turnTextLength: 500 })
		const result = await extract.execute({ items, source: "meeting" })
		expect(result.error).toBeUndefined()
		expect(result.stored).toHaveLength(1)
	})

	it("allows a short message when the earlier message ts is passed", async () => {
		const { extract } = createExtractHarness({ turnTextLength: 50 })
		const result = await extract.execute({
			items,
			source: "meeting",
			source_ref: "1762345678.123456",
		})
		expect(result.error).toBeUndefined()
		expect(result.stored).toHaveLength(1)
	})

	it("allows a short message that contains commitment content", async () => {
		const { extract } = createExtractHarness({
			turnTextLength: 50,
			turnHasCommitmentContent: true,
		})
		const result = await extract.execute({ items, source: "meeting" })
		expect(result.error).toBeUndefined()
		expect(result.stored).toHaveLength(1)
	})

	it("allows a short message when a transcript attachment is present", async () => {
		const { extract } = createExtractHarness({
			turnTextLength: 50,
			hasTranscriptAttachment: true,
		})
		const result = await extract.execute({ items, source: "meeting" })
		expect(result.error).toBeUndefined()
		expect(result.stored).toHaveLength(1)
	})
})

describe("legacy batch similarity", () => {
	it("matches an unrecorded legacy batch grouped by source_ref", async () => {
		const titles = [
			"Send the vendor report",
			"Update the travel policy",
			"Book the offsite",
			"Review the budget",
		]
		const base = {
			detail: null,
			owner: "U1",
			owner_name: "Abhishek H.",
			owner_resolution: "id",
			status: "open",
			source: "meeting",
			source_key: null,
			source_ref: "legacy-fixture-2",
			scope: "dm",
			due: null,
			evidence: null,
			created_by: "U-ASKER",
			created_at: 1000,
			updated_at: 1000,
		}
		const { extract, rows } = createExtractHarness({
			directoryMembers: [{ id: "U1", name: "Abhishek Humney" }],
			seedRows: titles.map((title, index) => ({
				...base,
				id: `legacy-${index}`,
				title,
				dedupe_key: `legacy-${index}`,
			})),
		})
		const result = await extract.execute({
			items: titles.map((title) => ({
				title,
				owner: { name: "Abhishek Humney" },
			})),
			source: "meeting",
			source_ref: "1762345678.999999",
		})
		expect(result.stored).toEqual([])
		expect(result.alreadyExtracted).toBe(true)
		expect(result.duplicates).toBe(4)
		expect(result.matchedSource?.sourceKey).toBe("ref:legacy-fixture-2")
		expect(
			result.warnings?.some((warning) => warning.includes("SIMILAR BATCH")),
		).toBe(true)
		expect(rows).toHaveLength(4)
	})

	it("does not let another asker's DM rows suppress extraction", async () => {
		const titles = [
			"Send the vendor report",
			"Update the travel policy",
			"Book the offsite",
			"Review the budget",
		]
		const base = {
			detail: null,
			owner: "U-B",
			owner_name: "B Person",
			owner_resolution: "id",
			status: "open",
			source: "meeting",
			source_key: null,
			source_ref: "b-batch",
			scope: "dm",
			due: null,
			evidence: null,
			created_by: "U-B",
			created_at: 1000,
			updated_at: 1000,
		}
		const { extract, rows } = createExtractHarness({
			askerSlackUserId: "U-A",
			directoryMembers: [{ id: "U-B", name: "B Person" }],
			seedRows: [
				...titles.map((title, index) => ({
					...base,
					id: `b-${index}`,
					title,
					dedupe_key: `b-${index}`,
				})),
				...titles.map((title, index) => ({
					...base,
					id: `legacy-${index}`,
					title,
					created_by: null,
					source_ref: "legacy-b",
					dedupe_key: `legacy-${index}`,
				})),
			],
		})
		const result = await extract.execute({
			items: titles.map((title) => ({
				title,
				owner: { name: "B Person" },
			})),
			source: "meeting",
			source_ref: "1762345678.777777",
		})
		expect(result.stored).toHaveLength(4)
		expect(result.alreadyExtracted).toBe(false)
		expect(rows).toHaveLength(12)
	})
})

describe("owner mention output", () => {
	it("returns null for the asker and a token for another owner", async () => {
		const { extract } = createExtractHarness({
			directoryMembers: [
				{ id: "U-ASKER", name: "Abhishek Humney" },
				{ id: "U-OTHER", name: "Priya Shah" },
			],
		})
		const result = await extract.execute({
			items: [
				{ title: "My own item", owner: { name: "Abhishek Humney" } },
				{ title: "Someone else's item", owner: { name: "Priya Shah" } },
			],
			source: "meeting",
			source_ref: "1762345678.777777",
		})
		expect(result.stored[0]?.mention).toBeNull()
		expect(result.stored[1]?.mention).toBe("<@U-OTHER>")
	})
})

describe("non-decision markers", () => {
	it("keeps the literal marker list narrow", () => {
		expect(NON_DECISION_MARKERS).toContain("didn't decide")
		expect(NON_DECISION_MARKERS).toContain("no agreement")
		expect(NON_DECISION_MARKERS).toContain("we will decide later")
		expect(NON_DECISION_MARKERS).toContain("decide later")
		expect(NON_DECISION_MARKERS).not.toContain("decide")
		expect(NON_DECISION_MARKERS).not.toContain("later")
	})

	it("normalises curly apostrophes and case", () => {
		expect(normalizeNonDecisionText("  DIDN’T   decide ")).toBe(
			"didn't decide",
		)
		expect(findNonDecisionMarker(["We didn’t decide."])).toBe("didn't decide")
		expect(findNonDecisionMarker(["DID NOT DECIDE"])).toBe("did not decide")
		expect(findNonDecisionMarker(["We'll decide later"])).toBe(
			"we'll decide later",
		)
	})

	it("does not reject generic words or a real commitment", () => {
		expect(
			findNonDecisionMarker(["Decide on the pricing tier by Friday"]),
		).toBeUndefined()
		expect(findNonDecisionMarker(["Send the pricing deck to the customer"])).toBe(
			undefined,
		)
		expect(findNonDecisionMarker(["Review the contract redlines"])).toBe(
			undefined,
		)
		expect(findNonDecisionMarker(["Discuss pricing later"])).toBeUndefined()
	})
})

describe("non-decision extraction filter", () => {
	const sourceRef = "1762345678.123456"

	it("rejects explicit non-decisions before storing", async () => {
		const { extract, rows } = createExtractHarness()
		const result = await extract.execute({
			items: [
				{
					title: "Decide on the price increase",
					evidence:
						"We talked about the price increase, but we didn't decide.",
				},
				{ title: "Decide later on pricing" },
				{
					title: "Update the travel policy",
					evidence: "The policy update was deferred.",
				},
				{
					title: "Finalize vendor terms",
					evidence: "There was no agreement on the vendor terms.",
				},
			],
			source: "meeting",
			source_ref: sourceRef,
		})
		expect(result.stored).toEqual([])
		expect(result.rejected).toHaveLength(4)
		expect(result.rejected?.every((item) => item.reason === "non-decision")).toBe(
			true,
		)
		expect(rows).toHaveLength(0)
	})

	it("keeps genuine commitments and stores exactly four of five", async () => {
		const { extract, rows, sources } = createExtractHarness()
		const result = await extract.execute({
			items: [
				{ title: "Send the pricing deck to the customer" },
				{ title: "Decide on the pricing tier by Friday" },
				{ title: "Review the contract redlines before Thursday" },
				{ title: "Update the onboarding checklist" },
				{
					title: "Decide on the price increase",
					evidence:
						"We talked about the price increase, but we didn't decide.",
				},
			],
			source: "meeting",
			source_ref: sourceRef,
		})
		expect(result.stored).toHaveLength(4)
		expect(result.rejected).toEqual([
			{ title: "Decide on the price increase", reason: "non-decision" },
		])
		expect(rows).toHaveLength(4)
		expect(sources).toHaveLength(1)
		expect(sources[0]?.item_count).toBe(4)
	})
})

describe("earlier extraction request predicate", () => {
	it("recognises extraction requests aimed at prior material", () => {
		expect(
			requestsEarlierExtraction(
				"pull the commitments from yesterday's meeting",
			),
		).toBe(true)
		expect(
			requestsEarlierExtraction(
				"what action items did we agree in the last meeting",
			),
		).toBe(true)
		expect(
			requestsEarlierExtraction(
				"extract the action items from the transcript I sent",
			),
		).toBe(true)
		expect(requestsEarlierExtraction("show me the todos")).toBe(true)
	})

	it("does not treat ordinary notes or status questions as extraction requests", () => {
		expect(
			requestsEarlierExtraction(
				"Alice will send the onboarding pack. Bob will book the room.",
			),
		).toBe(false)
		expect(
			requestsEarlierExtraction("quick check, please reply briefly"),
		).toBe(false)
		expect(
			requestsEarlierExtraction("what's the status of the renewal items"),
		).toBe(false)
	})
})

describe("current-message grounding", () => {
	const turnText =
		"Alice will send the onboarding pack. Bob will book the room."
	const currentItems = [
		{
			title: "Send the onboarding pack",
			evidence: "Alice will send the onboarding pack.",
		},
		{ title: "Book the room", evidence: "Bob will book the room." },
	]

	it("normalises evidence before substring matching", () => {
		expect(
			isActionItemGroundedInTurn(
				{
					title: "Send the onboarding pack",
					evidence: "  ALICE   will send the onboarding pack. ",
				},
				turnText,
			),
		).toBe(true)
		expect(
			isActionItemGroundedInTurn(
				{
					title: "Finalize the partner integration",
					evidence: "We will finalize the partner integration by Friday.",
				},
				turnText,
			),
		).toBe(false)
	})

	it("accepts current-message items with matching evidence", async () => {
		const { extract } = createExtractHarness({
			turnText,
			turnTextLength: 60,
			turnHasCommitmentContent: true,
		})
		const result = await extract.execute({
			items: currentItems,
			source: "meeting",
		})
		expect(result.stored).toHaveLength(2)
		expect(result.rejected).toEqual([])
	})

	it("rejects a history-derived item but stores the legitimate current ones", async () => {
		const { extract, rows, sources } = createExtractHarness({
			turnText,
			turnTextLength: 60,
			turnHasCommitmentContent: true,
		})
		const result = await extract.execute({
			items: [
				...currentItems,
				{
					title: "Finalize the partner integration",
					evidence:
						"We will finalize the partner integration by Friday.",
				},
			],
			source: "meeting",
		})
		expect(result.stored).toHaveLength(2)
		expect(result.rejected).toEqual([
			{
				title: "Finalize the partner integration",
				reason: "not_from_current_message",
			},
		])
		expect(rows).toHaveLength(2)
		expect(sources[0]?.item_count).toBe(2)
	})

	it("rejects a title-only item whose tokens are mostly absent", async () => {
		const { extract } = createExtractHarness({
			turnText,
			turnTextLength: 60,
			turnHasCommitmentContent: true,
		})
		const result = await extract.execute({
			items: [{ title: "Finalize partner integration" }],
			source: "meeting",
		})
		expect(result.stored).toEqual([])
		expect(result.rejected).toEqual([
			{
				title: "Finalize partner integration",
				reason: "not_from_current_message",
			},
		])
	})

	it("accepts the same history item when source_ref is supplied", async () => {
		const { extract } = createExtractHarness({
			turnText: "extract the action items from that transcript",
			turnTextLength: 60,
			turnHasCommitmentContent: true,
		})
		const result = await extract.execute({
			items: [
				{
					title: "Finalize the partner integration",
					evidence:
						"We will finalize the partner integration by Friday.",
				},
			],
			source: "meeting",
			source_ref: "1794492339.018209",
		})
		expect(result.stored).toHaveLength(1)
		expect(result.rejected).toEqual([])
	})

	it("skips grounding when turnText is unavailable", async () => {
		const { extract } = createExtractHarness()
		const result = await extract.execute({
			items: [
				{
					title: "Finalize the partner integration",
					evidence:
						"We will finalize the partner integration by Friday.",
				},
			],
			source: "meeting",
		})
		expect(result.stored).toHaveLength(1)
		expect(result.rejected).toEqual([])
	})

	it("stores exactly one item when current and history items are mixed", async () => {
		const { extract } = createExtractHarness({
			turnText,
			turnTextLength: 60,
			turnHasCommitmentContent: true,
		})
		const result = await extract.execute({
			items: [
				currentItems[0]!,
				{
					title: "Finalize the partner integration",
					evidence:
						"We will finalize the partner integration by Friday.",
				},
			],
			source: "meeting",
		})
		expect(result.stored).toHaveLength(1)
		expect(result.stored[0]?.title).toBe("Send the onboarding pack")
		expect(result.rejected).toHaveLength(1)
	})
})

describe("earlier source_ref gate", () => {
	const note =
		"Alice will send the onboarding pack. Bob will book the room."
	const earlierSourceRef = "1794492339.018209"
	const historyItem = {
		title: "Finalize the partner integration",
		evidence: "We will finalize the partner integration by Friday.",
	}

	it("rejects a source_ref for prior material when the message did not ask for it", async () => {
		const { extract, rows, sources } = createExtractHarness({
			turnText: note,
			turnTextLength: 60,
			turnHasCommitmentContent: true,
		})
		const result = await extract.execute({
			items: [historyItem],
			source: "meeting",
			source_ref: earlierSourceRef,
		})
		expect(result.stored).toEqual([])
		expect(result.reason).toBe("source_ref_not_requested")
		expect(result.error).toContain("source_ref_not_requested")
		expect(rows).toHaveLength(0)
		expect(sources).toHaveLength(0)
	})

	it("allows the same source_ref when the message asks for earlier extraction", async () => {
		const { extract } = createExtractHarness({
			turnText: "extract the action items from that transcript",
			turnTextLength: 60,
			turnHasCommitmentContent: true,
		})
		const result = await extract.execute({
			items: [historyItem],
			source: "meeting",
			source_ref: earlierSourceRef,
		})
		expect(result.stored).toHaveLength(1)
		expect(result.reason).toBeUndefined()
	})

	it("leaves the current-message path unaffected", async () => {
		const { extract } = createExtractHarness({
			turnText: note,
			turnTextLength: 60,
			turnHasCommitmentContent: true,
		})
		const result = await extract.execute({
			items: [
				{
					title: "Send the onboarding pack",
					evidence: "Alice will send the onboarding pack.",
				},
			],
			source: "meeting",
		})
		expect(result.stored).toHaveLength(1)
		expect(result.reason).toBeUndefined()
	})

	it("allows a source_ref equal to the current turn ts", async () => {
		const { extract } = createExtractHarness({
			turnText: note,
			turnTextLength: 60,
			turnHasCommitmentContent: true,
		})
		const result = await extract.execute({
			items: [historyItem],
			source: "meeting",
			source_ref: "1762345679.000001",
		})
		expect(result.stored).toHaveLength(1)
		expect(result.reason).toBeUndefined()
	})

	it("leaves the source_ref path unaffected when turnText is unavailable", async () => {
		const { extract } = createExtractHarness()
		const result = await extract.execute({
			items: [historyItem],
			source: "meeting",
			source_ref: earlierSourceRef,
		})
		expect(result.stored).toHaveLength(1)
		expect(result.reason).toBeUndefined()
	})
})

describe("action-items prompt", () => {
	it("is present even in memory-only mode and scopes mentions to other people", () => {
		const prompt = buildSystemPrompt({ toolMode: "memory_only" })
		expect(prompt).toContain("<action_items>")
		expect(prompt).toContain("prior conversation is background")
		expect(prompt).toContain("we talked about X, but we didn't decide")
		expect(prompt).toContain("missing item is cheaper")
		expect(prompt).toContain(
			"One extract_action_items call must describe one source only",
		)
		expect(prompt).toContain(
			"Only supply source_ref for an earlier message when the user explicitly asks",
		)
		expect(prompt).toContain("someone other than the asker")
		expect(prompt).toContain("tool returns a null mention")
		expect(prompt).toContain('write "you" in plain text')
	})
})
