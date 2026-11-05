/**
 * Neutralize recalled memory text before it reaches the model.
 *
 * A memory note is data the agent wrote in an earlier session, but once it is
 * pasted into a tool result it is read like any other text, so a note that
 * contains `<system-reminder>` or a bidi override can imitate the host's own
 * markup or hide what it says. Claude Code 2.1.284 added exactly this guard for
 * its own `MEMORY.md` and recalled notes ("invisible characters and tags that
 * imitate Claude Code's own markup are neutralized ... before they reach
 * Claude"), and this module is the OpenRecall port of it, applied by the tool
 * layer to recall regions, search snippets, index lines, doctor output and
 * save-gate candidate text. `memory_get` stays verbatim: its contract is
 * byte-for-byte data.
 *
 * Two rules, in this order (so a tag split by an invisible character is still
 * caught by the second):
 *
 *   (a) Invisible controls are removed: U+200B zero width space, U+2060-U+2064
 *       (word joiner and invisible operators), U+FEFF byte order mark, the bidi
 *       overrides and embeddings U+202A-U+202E, the bidi isolates
 *       U+2066-U+2069, and the Unicode tag characters U+E0000-U+E007F. ZWJ
 *       (U+200D) and ZWNJ (U+200C) are kept: emoji sequences and Persian and
 *       Indic scripts need them, and they carry no directionality.
 *
 *   (b) In an opening, closing or self-closing tag whose name is on a short
 *       denylist, the `<` is rewritten to `‹` (U+2039), which keeps the text
 *       readable but stops it from parsing as markup. The names, matched
 *       case-insensitively, are `system`, `system-reminder`, `user`,
 *       `assistant`, `human`, `tool_use`, `tool_result`, `function_calls`,
 *       `function_results`, `invoke`, `instructions` and anything under
 *       `antml:`. Ordinary HTML (`<div>`, `<T>`, `<br/>`) is untouched, so a
 *       note that quotes markup or generics reads as written.
 *
 * The function is idempotent and returns the input unchanged (same string
 * value) when neither rule applies.
 */

const INVISIBLE = /[​⁠-⁤﻿‪-‮⁦-⁩]|[\u{E0000}-\u{E007F}]/gu

const DENYLIST = new Set([
  'system',
  'system-reminder',
  'user',
  'assistant',
  'human',
  'tool_use',
  'tool_result',
  'function_calls',
  'function_results',
  'invoke',
  'instructions',
])

/** `<`, optional `/`, a tag name, then whitespace, `/`, `>` or end of text. */
const TAG = /<(\/?)([A-Za-z][\w:-]*)(?=[\s/>]|$)/g

function denied(name: string): boolean {
  const n = name.toLowerCase()
  return DENYLIST.has(n) || n.startsWith('antml:')
}

/** Strip invisible controls and defuse host-markup lookalike tags. */
export function neutralize(text: string): string {
  const stripped = text.replace(INVISIBLE, '')
  return stripped.replace(TAG, (m, slash: string, name: string) =>
    denied(name) ? `‹${slash}${name}` : m,
  )
}
