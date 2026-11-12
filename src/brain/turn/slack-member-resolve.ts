import type { ToolSet } from "ai"
import type { SlackMember } from "../slack/client"
import type { TurnDeps } from "./deps"

/**
 * Resolve human-written references from transcripts and messages to Slack
 * members. All matching is pure so it can be unit-tested without a network or
 * a Durable Object.
 */
export type SlackMemberReference = {
	name?: string
	email?: string
	handle?: string
}

export type SlackMemberMatchKind =
	| "id"
	| "email"
	| "handle"
	| "display_name"
	| "real_name"
	| "first_name"

export type SlackMemberCandidate = {
	id: string
	name: string
	handle?: string
	displayName?: string
}

export type SlackMemberResolution =
	| {
			status: "resolved"
			member: SlackMemberCandidate
			matchedBy: SlackMemberMatchKind
	  }
	| {
			status: "ambiguous"
			candidates: SlackMemberCandidate[]
			totalCandidates: number
	  }
	| { status: "unresolved" }

const MAX_AMBIGUOUS_CANDIDATES = 10
const INVISIBLE_SPACE_RE = /[\u00a0\u2007\u202f\u200b-\u200d\ufeff]/g
const PUNCTUATION_RE = /[^\p{L}\p{N}\s]/gu

/**
 * Case-fold, NFKC-normalise, strip punctuation and invisible/non-breaking
 * spaces, collapse whitespace, and trim. "Sam  O'Brien" and "sam o brien"
 * become the same key.
 */
export function normalizeMemberMatchText(value: string | undefined): string {
	if (!value) return ""
	return value
		.normalize("NFKC")
		.replace(INVISIBLE_SPACE_RE, " ")
		.replace(PUNCTUATION_RE, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase()
}

/** Email matching is exact and case-insensitive; punctuation is meaningful. */
export function normalizeMemberEmail(value: string | undefined): string {
	if (!value) return ""
	return value.normalize("NFKC").replace(INVISIBLE_SPACE_RE, "").trim().toLowerCase()
}

function firstToken(value: string | undefined): string {
	const normalized = normalizeMemberMatchText(value)
	return normalized.split(" ")[0] ?? ""
}

/** Native mentions and raw Slack user ids are authoritative id references. */
function slackIdFromReference(
	reference: SlackMemberReference,
): string | undefined {
	for (const value of [reference.handle, reference.name]) {
		const trimmed = value?.trim()
		if (!trimmed) continue
		const mention = trimmed.match(/^<@([A-Z0-9]+)(?:\|[^>]*)?>$/i)
		if (mention?.[1]) return mention[1].toUpperCase()
		if (/^[UW][A-Z0-9]{2,}$/i.test(trimmed)) {
			return trimmed.toUpperCase()
		}
	}
	return undefined
}

function memberCandidates(member: SlackMember): SlackMemberCandidate {
	return {
		id: member.id,
		name: member.name,
		handle: member.handle,
		displayName: member.displayName,
	}
}

type MatchHit = {
	member: SlackMember
	matchedBy: SlackMemberMatchKind
}

/** Deleted flags are not part of SlackMember, but tolerate a directory that has them. */
function isUsableMember(member: SlackMember): boolean {
	if (!member.id || member.isBot === true) return false
	const deleted = (member as SlackMember & { deleted?: boolean }).deleted
	return deleted !== true
}

function dedupeHits(hits: ReadonlyArray<MatchHit>): MatchHit[] {
	const byId = new Map<string, MatchHit>()
	for (const hit of hits) {
		if (!byId.has(hit.member.id)) byId.set(hit.member.id, hit)
	}
	return [...byId.values()]
}

function resolutionFromHits(
	hits: ReadonlyArray<MatchHit>,
): SlackMemberResolution | undefined {
	const unique = dedupeHits(hits)
	const first = unique[0]
	if (!first) return undefined
	if (unique.length === 1) {
		return {
			status: "resolved",
			member: memberCandidates(first.member),
			matchedBy: first.matchedBy,
		}
	}
	return {
		status: "ambiguous",
		candidates: unique
			.slice(0, MAX_AMBIGUOUS_CANDIDATES)
			.map((hit) => memberCandidates(hit.member)),
		totalCandidates: unique.length,
	}
}

function resolveByName(
	name: string,
	members: ReadonlyArray<SlackMember>,
): SlackMemberResolution {
	// Tier 1: exact full name. Tier 2: exact first name. Tier 3: full-name
	// prefix. Tier 4: first-name prefix. Within a tier, more than one member is
	// ambiguous — never silently pick one.
	const exactFull: MatchHit[] = []
	const exactFirst: MatchHit[] = []
	const prefixFull: MatchHit[] = []
	const prefixFirst: MatchHit[] = []

	for (const member of members) {
		const display = normalizeMemberMatchText(member.displayName)
		const real = normalizeMemberMatchText(member.name)
		const firstName = firstToken(member.name || member.displayName)

		if (display && display === name) {
			exactFull.push({ member, matchedBy: "display_name" })
			continue
		}
		if (real && real === name) {
			exactFull.push({ member, matchedBy: "real_name" })
			continue
		}
		if (firstName && firstName === name) {
			exactFirst.push({ member, matchedBy: "first_name" })
			continue
		}
		if (display && display.startsWith(name)) {
			prefixFull.push({ member, matchedBy: "display_name" })
			continue
		}
		if (real && real.startsWith(name)) {
			prefixFull.push({ member, matchedBy: "real_name" })
			continue
		}
		if (firstName && firstName.startsWith(name)) {
			prefixFirst.push({ member, matchedBy: "first_name" })
		}
	}

	for (const tier of [exactFull, exactFirst, prefixFull, prefixFirst]) {
		const resolution = resolutionFromHits(tier)
		if (resolution) return resolution
	}
	return { status: "unresolved" }
}

/**
 * Resolve one reference. A native mention or raw Slack user id matches by id
 * first and is authoritative. Otherwise email is authoritative when it matches
 * exactly; then handle, then name. A `name` may be a full name, first name, or
 * a prefix of either.
 */
export function resolveSlackMemberReference(
	reference: SlackMemberReference,
	directory: ReadonlyArray<SlackMember>,
): SlackMemberResolution {
	const members = directory.filter(isUsableMember)

	const slackId = slackIdFromReference(reference)
	if (slackId) {
		const byId = resolutionFromHits(
			members
				.filter((member) => member.id.toUpperCase() === slackId)
				.map((member) => ({ member, matchedBy: "id" as const })),
		)
		return byId ?? { status: "unresolved" }
	}

	const email = normalizeMemberEmail(reference.email)
	if (email) {
		const byEmail = resolutionFromHits(
			members
				.filter((member) => normalizeMemberEmail(member.email) === email)
				.map((member) => ({ member, matchedBy: "email" as const })),
		)
		if (byEmail) return byEmail
	}

	const handle = normalizeMemberMatchText(reference.handle)
	if (handle) {
		const byHandle = resolutionFromHits(
			members
				.filter((member) => normalizeMemberMatchText(member.handle) === handle)
				.map((member) => ({ member, matchedBy: "handle" as const })),
		)
		if (byHandle) return byHandle
	}

	const name = normalizeMemberMatchText(reference.name)
	if (!name) return { status: "unresolved" }
	return resolveByName(name, members)
}

export function resolveSlackMemberReferences(
	references: ReadonlyArray<SlackMemberReference>,
	directory: ReadonlyArray<SlackMember>,
): SlackMemberResolution[] {
	return references.map((reference) =>
		resolveSlackMemberReference(reference, directory),
	)
}

export type SlackMemberDirectoryResult =
	| { ok: true; members: SlackMember[] }
	| { ok: false; error: string }

export type SlackMemberDirectoryCache = {
	load(): Promise<SlackMemberDirectoryResult>
}

async function fetchSlackMemberDirectory(
	botToken: string | undefined,
): Promise<SlackMemberDirectoryResult> {
	const token = botToken?.trim()
	if (!token) {
		return {
			ok: false,
			error:
				"Slack member directory is unavailable because this turn has no bot token. Resolve owners manually or retry in a Slack turn.",
		}
	}
	try {
		// Loaded lazily so the pure matching module (and its tests) never pulls
		// in the Slack client and its connected-app catalog dependencies.
		const { getSlackTeamDirectory } = await import("../slack/client")
		const members = await getSlackTeamDirectory(token, 1000)
		if (!members.length) {
			return {
				ok: false,
				error:
					"Slack returned an empty member directory. The bot may lack the users:read scope.",
			}
		}
		return { ok: true, members }
	} catch (error) {
		return {
			ok: false,
			error: `Slack member directory lookup failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		}
	}
}

/**
 * One directory fetch per turn, shared by resolve_slack_members and
 * extract_action_items. Concurrent callers share the same in-flight promise.
 */
export function createSlackMemberDirectoryCache(
	botToken: string | undefined,
): SlackMemberDirectoryCache {
	let pending: Promise<SlackMemberDirectoryResult> | undefined
	return {
		load() {
			pending ??= fetchSlackMemberDirectory(botToken)
			return pending
		},
	}
}

export type ResolveSlackMembersToolArgs = {
	deps: TurnDeps
	directory: SlackMemberDirectoryCache
	traceId: string
}

type ResolveMembersToolResult =
	| {
			index: number
			input: SlackMemberReference
			status: "resolved"
			userId: string
			name: string
			displayName: string
			mention: string
			handle?: string
			matchedBy: SlackMemberMatchKind
	  }
	| {
			index: number
			input: SlackMemberReference
			status: "ambiguous"
			candidates: SlackMemberCandidate[]
			totalCandidates: number
	  }
	| {
			index: number
			input: SlackMemberReference
			status: "unresolved"
			reason: "empty_reference" | "no_match"
	  }

function isEmptyReference(reference: SlackMemberReference): boolean {
	return !reference.name?.trim() && !reference.email?.trim() && !reference.handle?.trim()
}

export function createResolveSlackMembersTool(
	args: ResolveSlackMembersToolArgs,
): ToolSet {
	const { deps, directory, traceId } = args
	const referenceSchema = deps.z.object({
		name: deps.z
			.string()
			.optional()
			.describe("Name as written, e.g. 'Sam Rivera' or 'Sam'."),
		email: deps.z.string().optional().describe("Exact work email, if known."),
		handle: deps.z
			.string()
			.optional()
			.describe("Slack handle, with or without the @."),
	})
	return {
		resolve_slack_members: deps.tool({
			description:
				"Resolve names, handles, emails, native mentions (<@U123>), or raw Slack user ids from a transcript or message to real Slack users. Use this before assigning an action-item owner when the reference is not already a Slack mention. Returns a resolved user id and display name with how it matched (id, email, handle, display_name, real_name, first_name), an ambiguous result with every plausible user, or unresolved. Never invent or guess a Slack id. The member directory is fetched at most once per turn and shared with extract_action_items.",
			inputSchema: deps.z.object({
				candidates: deps.z
					.array(referenceSchema)
					.min(1)
					.max(50)
					.describe(
						"References to resolve, in the same order your caller needs them.",
					),
			}),
			execute: async ({ candidates }) => {
				const startedAt = Date.now()
				const loaded = await directory.load()
				if (!loaded.ok) {
					console.log(
						`[company-brain][${traceId}] resolve_slack_members unavailable: ${loaded.error}`,
					)
					return { ok: false, error: loaded.error }
				}
				const results: ResolveMembersToolResult[] = candidates.map(
					(input, index) => {
						if (isEmptyReference(input)) {
							return {
								index,
								input,
								status: "unresolved",
								reason: "empty_reference",
							}
						}
						const resolution = resolveSlackMemberReference(
							input,
							loaded.members,
						)
						if (resolution.status === "resolved") {
							const displayName =
								resolution.member.displayName ?? resolution.member.name
							return {
								index,
								input,
								status: "resolved",
								userId: resolution.member.id,
								name: resolution.member.name,
								displayName,
								mention: `<@${resolution.member.id}>`,
								handle: resolution.member.handle,
								matchedBy: resolution.matchedBy,
							}
						}
						if (resolution.status === "ambiguous") {
							return {
								index,
								input,
								status: "ambiguous",
								candidates: resolution.candidates,
								totalCandidates: resolution.totalCandidates,
							}
						}
						return {
							index,
							input,
							status: "unresolved",
							reason: "no_match",
						}
					},
				)
				const count = (status: ResolveMembersToolResult["status"]) =>
					results.filter((result) => result.status === status).length
				console.log(
					`[company-brain][${traceId}] resolve_slack_members count=${results.length} resolved=${count("resolved")} ambiguous=${count("ambiguous")} unresolved=${count("unresolved")} ms=${Date.now() - startedAt}`,
				)
				return {
					ok: true,
					results,
					resolvedCount: count("resolved"),
					ambiguousCount: count("ambiguous"),
					unresolvedCount: count("unresolved"),
				}
			},
		}),
	}
}
