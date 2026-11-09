import type { ProfileBucketDef } from "@repo/db/schema/common"
import { memoryClient } from "./client"

export type ContainerTagSettings = {
	containerTag: string
	name: string | null
	entityContext: string | null
	profileBuckets: ProfileBucketDef[]
}

/** A container tag's settings, or null before anything has created it. */
export async function getContainerTagSettings(
	env: Env,
	containerTag: string,
): Promise<ContainerTagSettings | null> {
	try {
		return await memoryClient(env).get<ContainerTagSettings>(
			`/v3/container-tags/${encodeURIComponent(containerTag)}`,
		)
	} catch (error) {
		if ((error as { status?: number }).status === 404) return null
		throw error
	}
}

/**
 * supermemory rejects a container tag's `entityContext` longer than this.
 *
 * Measured against the self-hosted server on 2026-11-09: 1500 characters is
 * accepted, 1501 comes back HTTP 400 with the request echoed and no field-level
 * message. The tuned brain prompts run to ~2500 characters, and the hosted API
 * tolerated them, so the ceiling is applied here at the wire boundary instead of
 * trimming the prompts themselves.
 */
export const SUPERMEMORY_ENTITY_CONTEXT_MAX = 1500

/** Marks where the context was cut; one character, counted against the cap. */
const TRUNCATION_MARK = "…"

/**
 * How far below the cap we will look for a sentence or prompt-line break.
 * Beyond this a tidier cut would discard more guidance than it is worth.
 */
const BOUNDARY_WINDOW = 200

/**
 * Index just past the last completed sentence (or prompt line) within the
 * window, or -1. The brain contexts are line-oriented instructions, so ending
 * on a full stop loses far less meaning than stopping mid-clause.
 */
function sentenceBoundary(context: string, budget: number): number {
	const floor = Math.max(1, budget - BOUNDARY_WINDOW)
	for (let end = budget; end > floor; end--) {
		const before = context.charAt(end - 1)
		const after = context.charAt(end)
		if (before === "\n") return end - 1
		if (
			(before === "." || before === "!" || before === "?") &&
			/\s/.test(after)
		) {
			return end
		}
	}
	return -1
}

/** Index just past the last whole word that fits, or -1. */
function wordBoundary(context: string, budget: number): number {
	for (let end = budget; end > 0; end--) {
		if (/\s/.test(context.charAt(end - 1))) return end - 1
	}
	return -1
}

/**
 * Clamp an entity context to supermemory's ceiling, cutting at a sentence or
 * word boundary near the cap where one exists and only falling back to a hard
 * cut when there is none. Never splits a UTF-16 surrogate pair. Returns the
 * input untouched when it already fits, and never throws — a slightly shorter
 * context is better than a failed write.
 */
export function truncateEntityContext(
	context: string,
	containerTag: string,
): string {
	if (context.length <= SUPERMEMORY_ENTITY_CONTEXT_MAX) return context

	// Reserve room for the marker so the result still fits under the cap.
	const budget = SUPERMEMORY_ENTITY_CONTEXT_MAX - TRUNCATION_MARK.length

	let end = sentenceBoundary(context, budget)
	if (end < 0) end = wordBoundary(context, budget)
	if (end < 0) end = budget

	// The cap is measured in UTF-16 code units (JS string length, which is what
	// a JS server's own string limit measures). If the cut lands between the
	// halves of a surrogate pair, drop the orphaned high surrogate.
	if (end > 0 && end < context.length) {
		const unit = context.charCodeAt(end - 1)
		if (unit >= 0xd800 && unit <= 0xdbff) end -= 1
	}

	const truncated = `${context.slice(0, end).trimEnd()}${TRUNCATION_MARK}`
	console.warn(
		`[memory] entityContext for ${containerTag} truncated to fit supermemory's ${SUPERMEMORY_ENTITY_CONTEXT_MAX}-char cap: ${context.length} -> ${truncated.length} chars`,
	)
	return truncated
}

/**
 * Set a container tag's display name, entity context and profile buckets.
 * supermemory reads the context and buckets whenever it extracts memories from
 * a document in this container. Creates the tag if it doesn't exist yet.
 *
 * This is the one place that PATCHes a tag, so the entity-context ceiling is
 * enforced here: the limit belongs to the transport, not to whoever built the
 * prompt, and every current and future caller is covered by construction.
 */
export async function updateContainerTagSettings(
	env: Env,
	containerTag: string,
	settings: {
		name?: string
		entityContext?: string
		profileBuckets?: ProfileBucketDef[]
	},
): Promise<void> {
	const { entityContext, ...rest } = settings
	await memoryClient(env).patch(
		`/v3/container-tags/${encodeURIComponent(containerTag)}`,
		{
			body: {
				...rest,
				...(entityContext === undefined
					? {}
					: { entityContext: truncateEntityContext(entityContext, containerTag) }),
			},
		},
	)
}
