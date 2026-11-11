import { describe, expect, it } from "vitest"
import { getToolFinishOutput } from "../../observability/log-utils"
import { ToolError } from "../../turn/errors"
import {
	type ConnectedAppFailureOutput,
	connectedAppFailureError,
	connectedAppToolResultOutput,
	failureText,
	isConnectedAppFailureOutput,
	isMcpErrorResult,
	mcpErrorContent,
} from "./tool-failure"

// The payload shape Code Mode produced when Notion rejected a page create with
// a 400. Before the fix this travelled back as a successful tool result.
const NOTION_DETAIL = JSON.stringify({
	name: "APIResponseError",
	code: "validation_error",
	status: 400,
	message: "body failed validation: body.properties.title should be defined.",
})

const notionFailure: ConnectedAppFailureOutput = {
	status: "error",
	kind: "remote_error",
	tool: "mcp_notion.notion_create_pages",
	message: "mcp_notion.notion_create_pages failed on Notion.",
	detail: NOTION_DETAIL,
	suggestion:
		"Correct the call using the expected signature and the server detail, then retry once.",
	retryable: false,
	logs: "",
	calls: [],
}

describe("connected-app failure surfacing", () => {
	it("recognises an error payload", () => {
		expect(isConnectedAppFailureOutput(notionFailure)).toBe(true)
		expect(isConnectedAppFailureOutput({ status: "ok", result: {} })).toBe(
			false,
		)
		expect(isConnectedAppFailureOutput({ status: "paused" })).toBe(false)
		expect(isConnectedAppFailureOutput(undefined)).toBe(false)
	})

	it("re-raises the payload as a ToolError instead of a successful value", () => {
		let thrown: unknown
		try {
			throw connectedAppFailureError(notionFailure)
		} catch (error) {
			thrown = error
		}
		expect(thrown).toBeInstanceOf(ToolError)
		const error = thrown as ToolError
		expect(error.kind).toBe("remote_error")
		expect(error.tool).toBe("mcp_notion.notion_create_pages")
		expect(error.retryable).toBe(false)
		// The server's 400 text must survive: it is what makes the failure
		// diagnosable, both in logs and in the text the model reads.
		expect(error.detail).toBe(NOTION_DETAIL)
		expect(error.message).toContain("failed on Notion.")
		expect(error.message).toContain(NOTION_DETAIL)
		expect(error.message).toContain(notionFailure.suggestion)
	})

	it("marks a resumed failure as an error tool result", () => {
		expect(connectedAppToolResultOutput(notionFailure)).toEqual({
			type: "error-json",
			value: notionFailure,
		})
		expect(connectedAppToolResultOutput({ status: "ok", result: 1 })).toEqual({
			type: "json",
			value: { status: "ok", result: 1 },
		})
	})

	it("keeps the failure text in the harness log and trajectory output", () => {
		const failure = connectedAppFailureError(notionFailure)
		expect(getToolFinishOutput({ success: false, error: failure })).toBe(
			failure.message,
		)
		expect(
			getToolFinishOutput({ success: true, output: { status: "ok" } }),
		).toEqual({ status: "ok" })
	})
})

describe("MCP error results", () => {
	it("detects an isError result and keeps its server text", () => {
		const result = {
			isError: true,
			content: [{ type: "text", text: "Notion 400: validation_error" }],
		}
		expect(isMcpErrorResult(result)).toBe(true)
		expect(mcpErrorContent(result)).toBe("Notion 400: validation_error")
		expect(isMcpErrorResult({ content: [] })).toBe(false)
		expect(mcpErrorContent({ isError: true, error: "boom" })).toBe("boom")
	})

	it("keeps the MCP server text in the model-visible failure text", () => {
		const result = {
			isError: true,
			content: [{ type: "text", text: "Notion 400: validation_error" }],
		}
		const message = failureText(
			"mcp_notion.notion_create_pages failed on the connected app.",
			mcpErrorContent(result),
			"Read the server detail, correct the call, then retry once.",
		)
		expect(message).toContain("Notion 400: validation_error")
		expect(message).toContain("Read the server detail")
	})
})
