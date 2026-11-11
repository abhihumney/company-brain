import { type SerializedToolError, ToolError } from "../../turn/errors"

/**
 * A failed connected-app run as Code Mode reports it: the serialized ToolError
 * plus the run's logs, native calls, and any partial result. Returning this as
 * a normal tool result lets the model read a failed write as a success.
 */
export type ConnectedAppFailureOutput = SerializedToolError & {
	logs?: string
	calls?: unknown[]
	partialResult?: unknown
}

export function isConnectedAppFailureOutput(
	output: unknown,
): output is ConnectedAppFailureOutput {
	if (!output || typeof output !== "object" || Array.isArray(output)) {
		return false
	}
	const item = output as Partial<ConnectedAppFailureOutput>
	return (
		item.status === "error" &&
		typeof item.kind === "string" &&
		typeof item.tool === "string" &&
		typeof item.message === "string" &&
		typeof item.suggestion === "string" &&
		typeof item.retryable === "boolean"
	)
}

function boundedDetail(value: string): string {
	const normalized = value.replace(/\s+/g, " ").trim()
	return normalized.length <= 2_000
		? normalized
		: `${normalized.slice(0, 1_999)}…`
}

/**
 * On a thrown tool error the model receives only the message, not the error
 * object, so the server detail and suggestion ride along in that text. The
 * payload fields themselves stay exactly as the runtime produced them.
 */
export function failureText(
	message: string,
	detail?: string,
	suggestion?: string,
): string {
	const parts = [message]
	if (detail?.trim()) parts.push(`Detail: ${boundedDetail(detail)}`)
	if (suggestion?.trim()) parts.push(`Next: ${suggestion}`)
	return parts.join("\n")
}

/** Re-raise a connected-app failure through the framework's error channel. */
export function connectedAppFailureError(
	output: ConnectedAppFailureOutput,
): ToolError {
	return new ToolError({
		kind: output.kind,
		tool: output.tool,
		message: failureText(output.message, output.detail, output.suggestion),
		suggestion: output.suggestion,
		retryable: output.retryable,
		contract: output.expected,
		detail: output.detail,
	})
}

/**
 * The tool result the model resumes from after an approval decision. A failed
 * or denied run must be an error result, never a successful JSON value.
 */
export function connectedAppToolResultOutput(
	output: unknown,
): { type: "json"; value: never } | { type: "error-json"; value: never } {
	return isConnectedAppFailureOutput(output)
		? { type: "error-json", value: output as never }
		: { type: "json", value: output as never }
}

/**
 * MCP tool errors arrive as a successful RPC whose result sets isError: true,
 * which reads like ordinary data; surface them as errors instead.
 */
export function isMcpErrorResult(result: unknown): boolean {
	return (
		Boolean(result) &&
		typeof result === "object" &&
		!Array.isArray(result) &&
		(result as { isError?: unknown }).isError === true
	)
}

/** The server text carried by an MCP error result, for the model and logs. */
export function mcpErrorContent(result: unknown): string | undefined {
	if (!result || typeof result !== "object" || Array.isArray(result)) {
		return undefined
	}
	const record = result as {
		content?: unknown
		error?: unknown
		message?: unknown
	}
	const texts: string[] = []
	if (Array.isArray(record.content)) {
		for (const part of record.content) {
			if (!part || typeof part !== "object") continue
			const text = (part as { text?: unknown }).text
			if (typeof text === "string" && text.trim()) texts.push(text)
		}
	}
	if (texts.length > 0) return texts.join("\n")
	if (typeof record.error === "string" && record.error.trim()) {
		return record.error
	}
	if (typeof record.message === "string" && record.message.trim()) {
		return record.message
	}
	return undefined
}
