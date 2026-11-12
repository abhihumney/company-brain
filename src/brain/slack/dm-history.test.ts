import { describe, expect, it, vi } from "vitest"
import type { SlackThreadMessage } from "./client"
import {
	formatDmHistoryConversation,
	loadDmHistoryConversation,
	MAX_DM_HISTORY_MESSAGE_CHARS,
	MAX_DM_HISTORY_MESSAGES,
	selectDmHistoryMessages,
	shouldLoadDmHistory,
	truncateDmHistoryMessage,
} from "./dm-history"

function message(
	ts: string,
	text: string,
	overrides: Partial<SlackThreadMessage> = {},
): SlackThreadMessage {
	return { ts, text, user: "U-HUMAN", ...overrides }
}

function formattedText(
	formatted: ReturnType<typeof formatDmHistoryConversation>,
): string {
	return formatted
		.map((entry) => (typeof entry.content === "string" ? entry.content : ""))
		.join("\n")
}

describe("selectDmHistoryMessages", () => {
	it("returns the newest messages oldest-first", () => {
		const selected = selectDmHistoryMessages([
			message("1", "one"),
			message("2", "two"),
			message("3", "three"),
		])
		expect(selected.map((entry) => entry.ts)).toEqual(["1", "2", "3"])
	})

	it("excludes the message currently being answered", () => {
		const selected = selectDmHistoryMessages(
			[message("1", "one"), message("2", "two"), message("3", "current")],
			{ excludeTs: "3" },
		)
		expect(selected.map((entry) => entry.ts)).toEqual(["1", "2"])
		expect(selected.map((entry) => entry.text)).not.toContain("current")
	})

	it("takes at most five messages", () => {
		const messages = ["1", "2", "3", "4", "5", "6", "7"].map((ts) =>
			message(ts, `message ${ts}`),
		)
		const selected = selectDmHistoryMessages(messages)
		expect(selected).toHaveLength(MAX_DM_HISTORY_MESSAGES)
		expect(selected.map((entry) => entry.ts)).toEqual(["3", "4", "5", "6", "7"])
	})

	it("truncates one oversized message with an explicit marker", () => {
		const text = "a".repeat(MAX_DM_HISTORY_MESSAGE_CHARS + 25)
		const selected = selectDmHistoryMessages([message("1", text)])
		expect(selected).toHaveLength(1)
		const selectedText = selected[0]?.text ?? ""
		expect(selectedText.startsWith("a".repeat(MAX_DM_HISTORY_MESSAGE_CHARS))).toBe(
			true,
		)
		expect(selectedText).toContain(
			"[message truncated: 25 characters omitted]",
		)
	})

	it("selects newest-first until the total character cap is reached", () => {
		const text = "a".repeat(4_000)
		const selected = selectDmHistoryMessages(
			[
				message("1", text),
				message("2", text),
				message("3", text),
			],
			{
				maxCharsPerMessage: 4_000,
				maxTotalChars: 9_000,
			},
		)
		// Newest two fit; the oldest would push the total to 12,000.
		expect(selected.map((entry) => entry.ts)).toEqual(["2", "3"])
	})

	it("skips system/join noise but keeps bot messages", () => {
		const selected = selectDmHistoryMessages([
			message("1", "joined the channel", {
				subtype: "channel_join",
				user: "U-HUMAN",
			}),
			message("2", "Bot reply", {
				bot_id: "B1",
				subtype: "bot_message",
			}),
			message("3", "human reply"),
		])
		expect(selected.map((entry) => entry.ts)).toEqual(["2", "3"])
	})

	it("returns an empty list for empty input", () => {
		expect(selectDmHistoryMessages([])).toEqual([])
	})
})

describe("formatDmHistoryConversation", () => {
	it("formats selected messages oldest-first and includes bot context", () => {
		const formatted = formatDmHistoryConversation(
			[
				message("1", "past question", { user: "U-HUMAN" }),
				message("2", "bot answer", { user: "UBOT" }),
				message("3", "current request"),
			],
			{
				excludeTs: "3",
				botUserId: "UBOT",
				userNames: new Map([["U-HUMAN", "Priya"]]),
			},
		)
		const text = formattedText(formatted)
		expect(text).toContain("past question")
		expect(text).toContain("bot answer")
		expect(text).not.toContain("current request")
		expect(text.indexOf("past question")).toBeLessThan(
			text.indexOf("bot answer"),
		)
		expect(text).toContain("(ts=1)")
		expect(text).toContain("(ts=2)")
		expect(formatted.some((entry) => entry.role === "assistant")).toBe(true)
	})

	it("labels another bot without treating it as Company Brain", () => {
		const formatted = formatDmHistoryConversation(
			[
				message("1", "third-party bot reply", {
					bot_id: "B-OTHER",
					subtype: "bot_message",
				}),
			],
			{ botUserId: "UBOT" },
		)
		const text = formattedText(formatted)
		expect(text).toContain("another Slack bot")
		expect(text).toContain("third-party bot reply")
		expect(formatted.some((entry) => entry.role === "assistant")).toBe(false)
	})

	it("returns an empty conversation for empty input", () => {
		expect(
			formatDmHistoryConversation([], { botUserId: null }),
		).toEqual([])
	})
})

describe("truncateDmHistoryMessage", () => {
	it("leaves short text alone and marks long text", () => {
		expect(truncateDmHistoryMessage("short", 20)).toBe("short")
		const result = truncateDmHistoryMessage("a".repeat(30), 10)
		expect(result.startsWith("a".repeat(10))).toBe(true)
		expect(result).toContain("[message truncated: 20 characters omitted]")
	})
})

describe("shouldLoadDmHistory / loadDmHistoryConversation", () => {
	const base = {
		isDm: true,
		botToken: "xoxb-test",
		channel: "D1",
		currentTs: "3",
		botUserId: "UBOT",
	}

	it("only loads for top-level DMs", () => {
		expect(shouldLoadDmHistory({ isDm: true, threadTs: undefined })).toBe(true)
		expect(shouldLoadDmHistory({ isDm: true, threadTs: "2" })).toBe(false)
		expect(shouldLoadDmHistory({ isDm: false, threadTs: undefined })).toBe(
			false,
		)
	})

	it("does not fetch for a threaded reply", async () => {
		const fetchMessages = vi.fn(async () => [])
		const result = await loadDmHistoryConversation({
			...base,
			threadTs: "2",
			fetchMessages,
		})
		expect(result).toEqual([])
		expect(fetchMessages).not.toHaveBeenCalled()
	})

	it("fetches once for a top-level DM and never for a channel", async () => {
		const fetchMessages = vi.fn(async () => [])
		await loadDmHistoryConversation({ ...base, fetchMessages })
		expect(fetchMessages).toHaveBeenCalledTimes(1)
		expect(fetchMessages).toHaveBeenCalledWith("xoxb-test", "D1", "3")
		await loadDmHistoryConversation({
			...base,
			isDm: false,
			fetchMessages,
		})
		expect(fetchMessages).toHaveBeenCalledTimes(1)
	})

	it("soft-fails to an empty conversation when the fetcher throws", async () => {
		const result = await loadDmHistoryConversation({
			...base,
			fetchMessages: async () => {
				throw new Error("ratelimited")
			},
		})
		expect(result).toEqual([])
	})
})
