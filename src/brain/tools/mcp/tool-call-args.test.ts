import { describe, expect, it } from "vitest"
import { normalizeToolCallArgs } from "./tool-call-args"

describe("normalizeToolCallArgs", () => {
	it("drops creation_mode draft when a parent is supplied", () => {
		const pages = [{ properties: { title: "memory" } }]
		const args = { parent: "memory", pages, creation_mode: "draft" }

		const normalized = normalizeToolCallArgs(args)

		expect(normalized).toEqual({ parent: "memory", pages })
		expect(normalized.parent).toBe("memory")
		expect("creation_mode" in normalized).toBe(false)
		// The caller's object is not mutated.
		expect(args.creation_mode).toBe("draft")
	})

	it("keeps an object parent intact alongside the dropped draft mode", () => {
		const parent = { page_id: "195de9221179449fab8075a27c979105" }
		const normalized = normalizeToolCallArgs({
			parent,
			pages: [],
			creation_mode: "draft",
		})

		expect(normalized).toEqual({ parent, pages: [] })
		expect(normalized.parent).toBe(parent)
	})

	it("leaves parent-only arguments unchanged", () => {
		const args = { parent: "memory", pages: [] }
		expect(normalizeToolCallArgs(args)).toBe(args)
	})

	it("leaves draft mode alone when there is no parent", () => {
		const args = { pages: [], creation_mode: "draft" }
		expect(normalizeToolCallArgs(args)).toBe(args)
	})

	it("never touches an unrelated tool's arguments", () => {
		const args = { query: "from:alice@example.com", limit: 5 }
		expect(normalizeToolCallArgs(args)).toBe(args)
	})
})
