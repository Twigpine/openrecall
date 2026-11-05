/**
 * What the running stdio MCP server knows about its own health.
 *
 * Why this exists: both answers were only ever written to stderr. An embedder —
 * the CLI bundle, a launcher, a test harness, another agent's supervisor — had
 * to scrape a log to learn that the server never bound its tools, and could not
 * tell "no memory configured" apart from "the last call was refused" at all.
 * Those are different problems with different fixes, so they are two questions
 * here: `getSetupError()` (startup) and `hadToolError()` (a call failed).
 *
 * The state lives in this module rather than in `server.ts` because `server.ts`
 * serves stdio from `main()`: a caller that wants the answer must be able to
 * import it without starting a transport. `server.ts` re-exports both readers,
 * so the surface it promises is still the surface callers import.
 *
 * Nothing here writes anywhere. stdout is the MCP protocol channel and stderr
 * is the launcher's log; the caller decides where a diagnostic goes.
 */

/** The startup diagnostic that left the tools unbound, or null when ready. */
let setupError: string | null = null

/**
 * Whether any tool call has failed since this module was loaded.
 *
 * Deliberately sticky. A single refused save is the thing a supervisor wants to
 * know about after the fact, and the next successful recall must not erase the
 * evidence that this session is degraded. The failure text itself is not kept:
 * every failing tool result already carries it back to the model that called.
 */
let toolFailed = false

/** Record the diagnostic that stopped the server from binding its tools. */
export function recordSetupError(message: string): void {
  setupError = message
}

/**
 * Drop the startup diagnostic once the tools are bound.
 *
 * A process can start the server more than once — a test driving `main()`, a
 * supervisor restarting it in place — and the second, working start must not
 * keep reporting the first one's diagnosis. Deliberately narrower than
 * `resetServerStatus()`: the tool-failure flag records what a caller was
 * already told, and a later good start does not unsay it.
 */
export function clearSetupError(): void {
  setupError = null
}

/** Record that a tool call came back as an error. */
export function recordToolFailure(): void {
  toolFailed = true
}

/** The startup diagnostic, or null when the server bound its tools cleanly. */
export function getSetupError(): string | null {
  return setupError
}

/**
 * True once any tool call has returned an error result.
 *
 * The count is of `isError` results this server sent, which in the MCP protocol
 * means a tool result: `isError` is defined on `CallToolResult` and on nothing
 * else this server serves. See ./server.ts for the one way that can be widened.
 */
export function hadToolError(): boolean {
  return toolFailed
}

/**
 * Restore the pristine state. `bun test` shares one module instance across every
 * suite in a run, so a test that records a failure would otherwise decide what
 * the next one observes.
 */
export function resetServerStatus(): void {
  setupError = null
  toolFailed = false
}
