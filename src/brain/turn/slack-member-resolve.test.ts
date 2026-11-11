import { describe, expect, it } from "vitest"
import type { SlackMember } from "../slack/client"
import {
	createSlackMemberDirectoryCache,
	normalizeMemberEmail,
	normalizeMemberMatchText,
	resolveSlackMemberReference,
	resolveSlackMemberReferences,
	type SlackMemberReference,
} from "./slack-member-resolve"

function member(overrides: Partial<SlackMember> & { id: string }): SlackMember {
	return {
		name: overrides.name ?? overrides.id,
		...overrides,
	}
}

const DIRECTORY: SlackMember[] = [
	member({
		id: "U1",
		name: "Priya Shah",
		handle: "priya",
		displayName: "Priya",
		email: "priya@example.com",
	}),
	member({
		id: "U2",
		name: "Sam Rivera",
		handle: "sam.r",
		email: "sam.rivera@example.com",
	}),
	member({
		id: "U3",
		name: "Sam Chen",
		handle: "sam.chen",
		email: "sam.chen@example.com",
	}),
	member({
		id: "U4",
		name: "Jonathan Smith",
		handle: "jon",
		email: "jon@example.com",
	}),
	member({
		id: "U5",
		name: "Anne-Marie O'Brien",
		handle: "anne",
		email: "anne@example.com",
	}),
	member({
		id: "UBOT",
		name: "Sam Bot",
		handle: "sambot",
		email: "bot@example.com",
		isBot: true,
	}),
]

function resolve(reference: SlackMemberReference) {
	return resolveSlackMemberReference(reference, DIRECTORY)
}

describe("normalizeMemberMatchText", () => {
	it("folds case, punctuation, extra whitespace, and non-breaking spaces", () => {
		expect(normalizeMemberMatchText("  Sam\u00a0  O'Brien ")).toBe("sam obrien")
		expect(normalizeMemberMatchText("ANNE-MARIE")).toBe("annemarie")
		expect(normalizeMemberMatchText(undefined)).toBe("")
	})

	it("normalises emails without stripping meaningful punctuation", () => {
		expect(normalizeMemberEmail("  Priya@Example.com ")).toBe("priya@example.com")
		expect(normalizeMemberEmail("sam.rivera@example.com")).toBe(
			"sam.rivera@example.com",
		)
	})
})

describe("resolveSlackMemberReference", () => {
	it("resolves an exact full name", () => {
		const result = resolve({ name: "Priya Shah" })
		expect(result).toEqual({
			status: "resolved",
			matchedBy: "real_name",
			member: {
				id: "U1",
				name: "Priya Shah",
				handle: "priya",
				displayName: "Priya",
			},
		})
	})

	it("resolves an exact display name before the fuller real name", () => {
		const result = resolve({ name: "Priya" })
		expect(result.status).toBe("resolved")
		if (result.status !== "resolved") return
		expect(result.member.id).toBe("U1")
		expect(result.matchedBy).toBe("display_name")
	})

	it("returns ambiguous when a first name matches two people", () => {
		const result = resolve({ name: "Sam" })
		expect(result.status).toBe("ambiguous")
		if (result.status !== "ambiguous") return
		expect(result.totalCandidates).toBe(2)
		expect(result.candidates.map((candidate) => candidate.id).sort()).toEqual([
			"U2",
			"U3",
		])
	})

	it("never picks one of several identical full names", () => {
		const directory = [
			member({ id: "U10", name: "Alex Kim" }),
			member({ id: "U11", name: "Alex Kim" }),
		]
		const result = resolveSlackMemberReference(
			{ name: "Alex Kim" },
			directory,
		)
		expect(result.status).toBe("ambiguous")
		if (result.status !== "ambiguous") return
		expect(result.candidates.map((candidate) => candidate.id)).toEqual([
			"U10",
			"U11",
		])
	})

	it("prefers an exact full name over another person's exact first name", () => {
		const directory = [
			member({ id: "U20", name: "Sam" }),
			member({ id: "U21", name: "Sam Rivera" }),
		]
		const result = resolveSlackMemberReference({ name: "Sam" }, directory)
		expect(result.status).toBe("resolved")
		if (result.status !== "resolved") return
		expect(result.member.id).toBe("U20")
	})

	it("lets an exact email win over a different matching name", () => {
		const result = resolve({
			name: "Sam Chen",
			email: "priya@example.com",
		})
		expect(result.status).toBe("resolved")
		if (result.status !== "resolved") return
		expect(result.member.id).toBe("U1")
		expect(result.matchedBy).toBe("email")
	})

	it("matches email case-insensitively and ignores surrounding whitespace", () => {
		const result = resolve({ email: "  SAM.RIVERA@EXAMPLE.COM " })
		expect(result.status).toBe("resolved")
		if (result.status !== "resolved") return
		expect(result.member.id).toBe("U2")
		expect(result.matchedBy).toBe("email")
	})

	it("falls back to the name when the email does not match", () => {
		const result = resolve({
			name: "Sam Rivera",
			email: "missing@example.com",
		})
		expect(result.status).toBe("resolved")
		if (result.status !== "resolved") return
		expect(result.member.id).toBe("U2")
		expect(result.matchedBy).toBe("real_name")
	})

	it("resolves a handle with or without the @ and case-insensitively", () => {
		const withAt = resolve({ handle: "@Priya" })
		const withoutAt = resolve({ handle: "priya" })
		expect(withAt).toEqual(withoutAt)
		expect(withAt.status).toBe("resolved")
		if (withAt.status !== "resolved") return
		expect(withAt.member.id).toBe("U1")
		expect(withAt.matchedBy).toBe("handle")
	})

	it("handles punctuation, case, and non-breaking spaces in names", () => {
		const curly = resolve({ name: "  anne-marie\u00a0  o’brien " })
		expect(curly.status).toBe("resolved")
		if (curly.status !== "resolved") return
		expect(curly.member.id).toBe("U5")
		expect(curly.matchedBy).toBe("real_name")
	})

	it("resolves a prefix of a full name", () => {
		const result = resolve({ name: "Jon" })
		expect(result.status).toBe("resolved")
		if (result.status !== "resolved") return
		expect(result.member.id).toBe("U4")
		expect(result.matchedBy).toBe("real_name")
	})

	it("ignores bots", () => {
		const result = resolve({ email: "bot@example.com" })
		expect(result).toEqual({ status: "unresolved" })
		const byName = resolve({ name: "Sam Bot" })
		expect(byName).toEqual({ status: "unresolved" })
	})

	it("ignores deactivated members when the directory exposes the flag", () => {
		const directory = [
			{
				...member({ id: "U30", name: "Gone Person" }),
				deleted: true,
			} as SlackMember,
		]
		expect(
			resolveSlackMemberReference({ name: "Gone Person" }, directory),
		).toEqual({ status: "unresolved" })
	})

	it("returns unresolved for an unknown person and an empty reference", () => {
		expect(resolve({ name: "Nobody Here" })).toEqual({ status: "unresolved" })
		expect(resolve({})).toEqual({ status: "unresolved" })
	})

	it("resolves a batch in input order", () => {
		const results = resolveSlackMemberReferences(
			[{ name: "Priya Shah" }, { name: "Sam" }, { name: "Nobody" }],
			DIRECTORY,
		)
		expect(results.map((result) => result.status)).toEqual([
			"resolved",
			"ambiguous",
			"unresolved",
		])
	})
})

describe("directory cache", () => {
	it("returns a clear error instead of throwing when the token is missing", async () => {
		const result = await createSlackMemberDirectoryCache(undefined).load()
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error).toContain("no bot token")
	})
})
