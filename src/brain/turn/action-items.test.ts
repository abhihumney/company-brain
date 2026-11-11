import { tool } from "ai"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import type { CompanyBrainAgent } from "./agent"
import {
	actionItemDedupePayload,
	actionItemScopeForSurface,
	actionItemSurfaceForSlackLookup,
	buildActionItemDedupeKey,
	canStoreActionItemScope,
	createActionItemTools,
	describeActionItemSurface,
	insertActionItem,
	isActionItemVisibleOnSurface,
	isValidActionItemScope,
	isValidActionItemSource,
	isValidActionItemStatus,
	normalizeActionItemDue,
	normalizeActionItemOwnerFilter,
	normalizeActionItemTitle,
	type ActionItemSource,
	type ActionItemStatus,
	type ActionItemSurface,
} from "./action-items"
import type { TurnDeps } from "./deps"

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
	it("hashes the same normalised item to the same key", async () => {
		const first = buildActionItemDedupeKey({
			title: "Send the deck",
			ownerId: "U1",
			source: "meeting",
			sourceRef: "transcript-abc",
		})
		const second = buildActionItemDedupeKey({
			title: "  send  THE deck. ",
			ownerId: "U1",
			source: "meeting",
			sourceRef: "  transcript-abc ",
		})
		expect(await first).toBe(await second)
	})

	it("changes when the owner changes", () => {
		const payload = (ownerId: string | null, ownerName: string | null) =>
			actionItemDedupePayload({
				title: "Send the deck",
				ownerId,
				ownerName,
				source: "meeting",
				sourceRef: "transcript-abc",
			})
		expect(payload("U1", null)).not.toBe(payload("U2", null))
		expect(payload(null, "Priya Shah")).not.toBe(payload(null, "Sam Rivera"))
		expect(payload("U1", "Priya")).toBe(payload("u1", "Someone Else"))
	})

	it("changes when the source_ref family changes and falls back to source", () => {
		const payload = (
			sourceRef: string | null,
			source: "meeting" | "message" = "meeting",
		) =>
			actionItemDedupePayload({
				title: "Send the deck",
				ownerId: "U1",
				source,
				sourceRef,
			})
		expect(payload("transcript-a")).not.toBe(payload("transcript-b"))
		expect(payload("  TRANSCRIPT-A  ")).toBe(payload("transcript-a"))
		expect(payload(null)).toBe(payload(""))
		expect(payload("transcript-a", "message")).not.toBe(
			payload("transcript-a", "meeting"),
		)
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
		expect(actionItemSurfaceForSlackLookup({ channel: "D9" })).toEqual({
			kind: "dm",
		})
		expect(actionItemSurfaceForSlackLookup({ channel: "C9" })).toEqual({
			kind: "public_channel",
			channelId: "C9",
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
			"all org action items",
		)
		expect(
			describeActionItemSurface({ kind: "public_channel", channelId: "C1" }),
		).toContain("only public items")
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
