import type { ModelMessage } from "ai"
import {
	formatMessageAttachmentHint,
	normalizeSlackMessageContent,
	type SlackFileRef,
} from "./attachments"
import type { SlackThreadMessage } from "./client"

/**
 * Prior conversation for a top-level DM follow-up. Slack thread history only
 * covers threaded replies, so a DM message that starts a new turn otherwise
 * loses the message it is replying to. This module selects a small, capped
 * window from the DM channel and formats it as the same ModelMessage shape
 * computeTurn already accepts.
 */
export const MAX_DM_HISTORY_MESSAGES = 5
export const MAX_DM_HISTORY_MESSAGE_CHARS = 4_000
export const MAX_DM_HISTORY_TOTAL_CHARS = 12_000

// System/join noise carries no conversational context. Bot messages are kept:
// the bot's own replies are legitimate context for a follow-up.
const SYSTEM_MESSAGE_SUBTYPES = new Set([
	"channel_join",
	"channel_leave",
	"channel_topic",
	"channel_purpose",
	"channel_name",
	"group_join",
	"group_leave",
	"pinned_item",
	"unpinned_item",
	"message_deleted",
	"message_changed",
	"tombstone",
])

export type DmHistorySelectionOptions = {
	excludeTs?: string
	maxMessages?: number
	maxCharsPerMessage?: number
	maxTotalChars?: number
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max)
}

function readableFiles(message: SlackThreadMessage): SlackFileRef[] {
	const out: SlackFileRef[] = []
	for (const file of message.files ?? []) {
		if (!file.name) continue
		out.push({ ...file, name: file.name })
	}
	return out
}

function messageBody(message: SlackThreadMessage, text: string): string {
	const hint = formatMessageAttachmentHint(readableFiles(message))
	return [text, hint].filter(Boolean).join(" ").trim()
}

/** Truncate one DM-history message with an explicit marker, never mid-surrogate. */
export function truncateDmHistoryMessage(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text
	let cut = Math.max(0, maxChars)
	const lastCode = text.charCodeAt(cut - 1)
	if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut -= 1
	const omitted = text.length - cut
	return `${text.slice(0, cut)}\n\n[message truncated: ${omitted} characters omitted]`
}

/**
 * Newest-first selection: take at most five recent messages and stop at the
 * total character budget. The result is returned oldest-first so the
 * conversation reads naturally. A message that does not fit the remaining
 * total is skipped rather than cut; single oversized messages are truncated
 * with a marker.
 */
export function selectDmHistoryMessages(
	messages: ReadonlyArray<SlackThreadMessage>,
	opts: DmHistorySelectionOptions = {},
): SlackThreadMessage[] {
	const maxMessages = clamp(opts.maxMessages ?? MAX_DM_HISTORY_MESSAGES, 1, 50)
	const maxCharsPerMessage = clamp(
		opts.maxCharsPerMessage ?? MAX_DM_HISTORY_MESSAGE_CHARS,
		100,
		100_000,
	)
	const maxTotalChars = clamp(
		opts.maxTotalChars ?? MAX_DM_HISTORY_TOTAL_CHARS,
		100,
		500_000,
	)
	const selected: SlackThreadMessage[] = []
	let usedChars = 0

	for (
		let index = messages.length - 1;
		index >= 0 && selected.length < maxMessages;
		index--
	) {
		const message = messages[index]
		if (!message?.ts || message.ts === opts.excludeTs) continue
		if (message.subtype && SYSTEM_MESSAGE_SUBTYPES.has(message.subtype)) {
			continue
		}
		const body = normalizeSlackMessageContent(message).trim()
		const hint = formatMessageAttachmentHint(readableFiles(message))
		if (!body && !hint) continue
		const hintCost = hint ? hint.length + 1 : 0
		const text = truncateDmHistoryMessage(
			body,
			Math.max(0, maxCharsPerMessage - hintCost),
		)
		const bodyLength = messageBody(message, text).length
		if (selected.length > 0 && usedChars + bodyLength > maxTotalChars) break
		selected.push({
			...message,
			text,
			// The body is already normalised; keep files for the hint only.
			attachments: undefined,
			files: readableFiles(message),
		})
		usedChars += bodyLength
	}

	return selected.reverse()
}

function isOurBot(
	message: SlackThreadMessage,
	botUserId: string | null,
	slackBotId?: string | null,
): boolean {
	return Boolean(
		(botUserId && message.user === botUserId) ||
			(slackBotId && message.bot_id === slackBotId),
	)
}

function isOtherBot(
	message: SlackThreadMessage,
	botUserIds?: ReadonlySet<string>,
): boolean {
	return Boolean(
		message.bot_id ||
			message.app_id ||
			message.subtype === "bot_message" ||
			(message.user && botUserIds?.has(message.user)),
	)
}

export type DmHistoryFormatOptions = {
	excludeTs?: string
	botUserId: string | null
	slackBotId?: string | null
	userNames?: Map<string, string>
	botUserIds?: ReadonlySet<string>
	selection?: Omit<DmHistorySelectionOptions, "excludeTs">
}

function messagePrefix(label: string, ts: string | undefined): string {
	return `[Slack message from ${label}${ts ? ` (ts=${ts})` : ""}]`
}

/**
 * Pure formatter: raw DM messages in, the ModelMessage[] shape computeTurn
 * expects out. It includes the bot's own replies and labels every speaker with
 * the message ts so the model can cite an earlier transcript exactly.
 */
export function formatDmHistoryConversation(
	messages: ReadonlyArray<SlackThreadMessage>,
	opts: DmHistoryFormatOptions,
): ModelMessage[] {
	const selected = selectDmHistoryMessages(messages, {
		...opts.selection,
		excludeTs: opts.excludeTs,
	})
	const formatted: ModelMessage[] = []
	for (const message of selected) {
		const body = messageBody(message, message.text ?? "")
		if (!body || /^new assistant thread$/i.test(body)) continue
		if (isOurBot(message, opts.botUserId, opts.slackBotId)) {
			formatted.push({
				role: "assistant",
				content: `${messagePrefix("Company Brain", message.ts)}\n${body}`,
			})
			continue
		}
		const name = message.user ? opts.userNames?.get(message.user) : undefined
		const label = isOtherBot(message, opts.botUserIds)
			? (name ?? "another Slack bot")
			: message.user
				? `${name ?? message.user} (slack_user_id=${message.user})`
				: "an unidentified teammate"
		formatted.push({
			role: "user",
			content: `${messagePrefix(label, message.ts)}\n${body}`,
		})
	}
	return mergeConsecutiveMessages(formatted)
}

function mergeConsecutiveMessages(messages: ModelMessage[]): ModelMessage[] {
	const merged: ModelMessage[] = []
	for (const message of messages) {
		const previous = merged[merged.length - 1]
		if (
			previous?.role === message.role &&
			typeof previous.content === "string" &&
			typeof message.content === "string"
		) {
			previous.content = `${previous.content}\n\n${message.content}`
			continue
		}
		merged.push(message)
	}
	return merged
}

export type DmHistoryFetcher = (
	botToken: string,
	channel: string,
	latestTs: string,
) => Promise<SlackThreadMessage[]>

/** One conversations.history page, newest six, no pagination. Soft-fails empty. */
export async function fetchDmHistoryMessages(
	botToken: string,
	channel: string,
	latestTs: string,
): Promise<SlackThreadMessage[]> {
	try {
		// Loaded lazily so pure formatter tests never pull in the Slack client.
		const { getSlackChannelHistoryResult } = await import("./client")
		const result = await getSlackChannelHistoryResult(botToken, channel, {
			limit: MAX_DM_HISTORY_MESSAGES + 1,
			maxMessages: MAX_DM_HISTORY_MESSAGES + 1,
			maxPages: 1,
			...(latestTs ? { latest: latestTs } : {}),
		})
		if (!result.ok) {
			console.warn(
				`[slack] dm history unavailable channel=${channel}: ${result.error}`,
			)
			return []
		}
		return result.messages
	} catch (error) {
		console.warn("[slack] dm history failed:", error)
		return []
	}
}

export type LoadDmHistoryArgs = {
	isDm: boolean
	threadTs?: string
	botToken: string
	channel: string
	currentTs: string
	botUserId: string | null
	slackBotId?: string | null
	userNames?: Map<string, string>
	botUserIds?: ReadonlySet<string>
	selection?: DmHistoryFormatOptions["selection"]
	/** Test seam; production uses fetchDmHistoryMessages. */
	fetchMessages?: DmHistoryFetcher
}

export function shouldLoadDmHistory(args: {
	isDm: boolean
	threadTs?: string
}): boolean {
	return args.isDm && !args.threadTs
}

/**
 * Gate + fetch + format. Only top-level DMs get the extra call; threaded
 * replies already carry complete thread history and must not double it.
 */
export async function loadDmHistoryConversation(
	args: LoadDmHistoryArgs,
): Promise<ModelMessage[]> {
	if (!shouldLoadDmHistory(args)) return []
	try {
		const messages = await (args.fetchMessages ?? fetchDmHistoryMessages)(
			args.botToken,
			args.channel,
			args.currentTs,
		)
		return formatDmHistoryConversation(messages, {
			excludeTs: args.currentTs,
			botUserId: args.botUserId,
			slackBotId: args.slackBotId,
			userNames: args.userNames,
			botUserIds: args.botUserIds,
			selection: args.selection,
		})
	} catch (error) {
		console.warn("[slack] dm history unavailable:", error)
		return []
	}
}
