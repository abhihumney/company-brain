// Notion rejects a `creation_mode: "draft"` argument when it arrives with a
// `parent`:
//   400 validation_error: The "creation_mode" value "draft" cannot be combined
//   with "parent". Drafts are created as private workspace-level pages.
// Callers copy `creation_mode` from the tool schema even when they name a
// destination, so keep the `parent` they asked for and drop only the key that
// conflicts. The tool schema itself says creation_mode must be omitted when a
// parent is named, so omitting it selects the parent branch rather than
// re-applying draft mode.
export function normalizeToolCallArgs(
	args: Record<string, unknown>,
): Record<string, unknown> {
	// Keyed on the conflicting pair, not on a server or tool name: any call that
	// carries both a destination and draft mode is rejected the same way.
	if (args.parent == null || args.creation_mode !== "draft") return args
	const normalized = { ...args }
	delete normalized.creation_mode
	return normalized
}
