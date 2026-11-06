# Performance

How fast the memory tools are expected to be, how recall quality is measured,
and the rules a change has to meet before it may claim to be faster or better.
Every number here is produced on the developer's machine from committed,
seeded inputs; nothing reads a real memory directory.

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

## Recall quality harness

`memory_recall` ranks locally with the BM25F ranker in `src/mcp/relevance.ts`,
over an in-process index per namespace that is brought up to date from each
pull's entry fingerprints, so an unchanged entry is never re-tokenized. The
harness in `tests/bench/` is the yardstick a ranker change is judged by; it
calls the ranker as a pure function, which builds a transient index per
query, so its `ms/q` column is the cold cost (tokenize plus score), not the
warm one. The row name `tfidf` is kept for the baseline's sake: it is the
product ranker, whatever it is called.

**What it measures.** `tests/bench/recall-fixture.ts` generates, from a seed, a
corpus of 2,000 (or 10,000) notes in the shape the memory guide prescribes:
160 one-fact notes under `user/`, `feedback/`, `project/` and `reference/`, a
quarter of them as update pairs (an older dated note and a newer note with a
different value), a tenth of the corpus as long notes that repeat a fact's
topic words without holding the fact, the rest short generic notes, and a
`MEMORY.md` index. It generates 205 questions: `lexical` ones that share at
least two content terms with their gold note, `paraphrase` ones that share at
most one, `update` ones whose gold has a superseded sibling, and
`unanswerable` ones that name a topic no note covers using words every note
uses. Three systems answer them with one signature: `tfidf` (the product
ranker, called as a pure function), `substring` (a per-term grep, ties by key,
sees the index as `memory_search` does) and `full` (every entry, the cost
ceiling). The same seed yields the same questions at both sizes, so the
10,000-entry run is the same questions in a bigger haystack.

**How to read the table.** `bun run bench:recall` prints one row per system:

| column | meaning | better |
|---|---|---|
| R@1, R@5, R@10 | share of answerable questions whose gold is in the first 1, 5, 10 results | higher |
| MRR | mean of 1/rank of the gold within the first 10 | higher |
| nDCG@10 | mean of 1/log2(rank+1) of the gold within the first 10 | higher |
| stale | share of update questions where the superseded note ranks above the gold | lower |
| absP | of the questions the system returned nothing for, the share that were unanswerable (`n/a` when it never abstained) | higher |
| absR | of the unanswerable questions, the share the system returned nothing for | higher |
| false | share of all questions answered with something whose first result is not the gold | lower |
| bytes/q | mean plaintext bytes returned per query | cost |
| ms/q | mean wall time per query on this machine | informational |

Measured at commit `ebac262` (seed 1, 2,000 entries, M4 Pro):

```
system        R@1     R@5    R@10     MRR  nDCG@10   stale  absP    absR   false  bytes/q  ms/q
tfidf      0.3778  0.6278  0.6833  0.4930   0.5397  0.4000   n/a  0.0000  0.6683     9798  25.6
substring  0.0389  0.6056  0.6667  0.2934   0.3869  0.5000   n/a  0.0000  0.9659   200115   1.4
full       0.0000  0.0111  0.0167  0.0050   0.0077  0.0250   n/a  0.0000  1.0000   984323   0.0
```

At 10,000 entries the same questions dropped to R@1 0.26 and R@10 0.58 for
that ranker at ~130 ms per query: more notes about a topic bury the short
note that answers it, which is the failure the fixture is built to reproduce.
Neither that ranker nor grep ever abstained; every unanswerable question got
an answer.

Measured with the BM25F ranker and the relevance floor fitted in
`src/mcp/relevance.ts` (same seed, corpus and questions):

```
system        R@1     R@5    R@10     MRR  nDCG@10   stale    absP    absR   false  bytes/q  ms/q
tfidf      0.4389  0.6167  0.6389  0.5234   0.5524  0.5250  0.1702  0.3200  0.3854     6700  24.9
```

Length normalization is what moved R@1 and MRR: a one-fact note now beats a
long note that repeats its topic words. The floor is what moved abstention
and the false-answer rate: 8 of the 25 unanswerable questions come back
empty, where none did. It also costs R@10: 12 paraphrase questions whose gold
sat inside a ten-way tie on one shared word (a person's name) are now
withheld, because that is the same lexical shape as an unanswerable question
and no floor tells them apart. `stale` moved the wrong way for a reason the
fixture makes visible: the newer note of each update pair carries an extra
"replaces the earlier note" sentence, and a length-normalizing ranker prefers
the shorter, older one; both rankers are recency-blind, and the tiebreak on
`updatedAt` that fixes this is a later change.

**The preregistered rule.** `tests/bench/recall-baseline.json` holds the
numbers the committed ranker produces for the committed seed and corpus
digest, with `minEffect: 0.02`.

- A change may claim an improvement only when a metric moves by at least
  `minEffect` in the better direction.
- A change may not move any quality metric the wrong way by `minEffect` or
  more. `tests/recall-bench.test.ts` enforces this for `tfidf` and blocks
  `bun run verify` when it fails. It also requires `tfidf` to beat
  `substring` on MRR.
- The baseline is updated only by `bun run bench:recall --update-baseline`,
  committed in a reviewed diff next to the change that justifies the new
  numbers. A fixture change bumps `GENERATOR_VERSION` and regenerates both the
  baseline and `recall-questions.jsonl` (`--write-questions`) in the same
  diff; the test refuses a baseline whose generator version or corpus digest
  does not match what it generated.

Per-question weight is about 0.005 on the answerable metrics and 0.04 on the
unanswerable ones, so `minEffect` is roughly four lexical questions or half an
unanswerable one. The harness is deterministic, so a number that moved is a
ranker that moved.

**Budget.** The blocking test runs the 2,000-entry corpus only, scored once at
collection time: about six seconds on an M4 Pro, nearly all of it the ranker
at ~26 ms per query over 205 questions. The 10,000-entry corpus belongs to the
script (`--size 10000`, about thirty seconds) and is never run in `bun test`.
If the blocking test ever exceeds eight seconds on the development machine,
the fallback is a deterministic every-other subset of the questions in the
test with the full set in the script, not a smaller corpus.

## Claiming a latency improvement

A performance change states its numbers in the PR body, from `status
--timings` or from the benchmark scripts, before and after, on the same machine
and the same store. Timings are single-machine medians and are compared only
against the same machine's baseline.
