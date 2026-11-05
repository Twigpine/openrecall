# Performance

How fast the memory tools are expected to be, how that is measured, and the
rule for claiming an improvement.

## Latency targets

Measured on a warm MCP process (the key already derived, the namespace already
read once), in local mode, at the namespace entry cap of 2,000 entries:

| tool | target |
|---|---|
| `memory_recall` | p50 ≤ 50 ms, p95 ≤ 200 ms |
| `memory_get`, `memory_list` | p50 ≤ 10 ms at any size under the cap |
| MCP `initialize` (Node bundle) | ≤ 150 ms |

These are targets, not a description of today. At 0.2.1 one recall pulled,
decrypted and re-ranked the whole namespace on every call: about 170 ms at
2,000 entries of realistic length, and 430 ms at 5,000. The first round of
changes removes measured waste (the single-entry read for `memory_get`, the
lock-free read path in local mode) and adds the measurement below; reaching the
recall target needs the in-process index and the delta pull that follow.

## Measuring

Every tool result carries its stage timings in the MCP result's `_meta`, under
the key `com.twigpine.openrecall/timings`. A host can read them; a model never
sees them, so measuring costs no context. The stages:

| field | what it covers |
|---|---|
| `fetch` | the client call: transport plus, for a pull, the JSON parse |
| `decrypt` | the AES-GCM pass over every entry the call decrypted |
| `rank` | tokenizing and scoring the corpus (recall), or matching (search) |
| `format` | region selection and output budgeting (recall) |
| `total` | wall time of the whole call |
| `entries`, `bytes` | entries read or scored, and response bytes fetched |

With `OPENRECALL_TIMINGS=1` in the MCP server's environment, the same numbers
are also appended to the tool text as a `[timings …]` trailer, for a human
reading a transcript, and written as one JSON line on stderr per call, for the
launcher's log. The stderr line is an allowlisted shape (`TIMING_FIELDS` in
`src/log.ts`): tool name, durations and counts. It carries no namespace, key,
query or content, because it is produced on the client side of the crypto,
where all of those are plaintext.

`openrecall status --timings` runs one cold and eleven warm recalls with a
generic probe against the pinned namespace and prints a per-stage table with
the cold value, the warm median and the warm 95th percentile, followed by the
SLO verdict. The verdict is `PASS` or `FAIL` only when the namespace holds at
least 2,000 entries; below that it is reported as informational, since a small
namespace cannot fail a target defined for a full one. The recall text itself
is never printed.

## Claiming an improvement

A performance change states its numbers in the PR body, from `status
--timings` or from the benchmark scripts, before and after, on the same machine
and the same store. Timings are single-machine medians and are compared only
against the same machine's baseline.
