/**
 * Synthetic recall corpus and the tuning / held-out probe sets.
 *
 * The recall work this fixture supports is a ranking problem, and ranking
 * regressions are invisible to the existing unit tests: `tests/relevance.test.ts`
 * scores four entries, which is far too small for term rarity, coverage ties, or
 * a superseded-note ordering to mean anything. This module pins a corpus large
 * enough that those effects are real, and pins the exact query/answer pairs the
 * measured misses came from, so each later unit has a mechanical flip to point
 * at rather than a claim about feeling better. The corpus is also the reason the
 * harness ranks by calling `rankMemories` directly: `tests/setup.ts` freezes the
 * server caps at five entries and 5000 bytes per namespace, so pushing this
 * corpus through a MemlawbClient would trip quota long before it ranked
 * anything. See `src/mcp/relevance.ts` for the ranker and
 * `tests/recall-regression.test.ts` for the assertions.
 *
 * Every byte here is invented for this fixture. Nothing is sourced from a real
 * memory directory, and nothing is loaded at run time: no filesystem access, no
 * environment-supplied corpus path, no network. `tests/recall-regression.test.ts`
 * enforces that mechanically by reading this file's own source.
 *
 * Explicit non-guarantee: this is not a relevance benchmark and the numbers it
 * produces are not comparable to anything outside this repo. It measures one
 * ranker against one hand-authored corpus written by the same hand that tunes
 * the ranker; the held-out set narrows that bias with a term-overlap floor but
 * does not remove it. Treat a rising held-out pass rate as evidence of movement,
 * never as an absolute quality score.
 */

/** entryKey -> markdown body, shaped like a memdir on disk. */
export const CORPUS: Record<string, string> = {
  'MEMORY.md': [
    '# index',
    '- [deploy](project/deploy.md)',
    '- [datastore, current](project/postgres-new.md)',
    '- [datastore, superseded](project/postgres-old.md)',
    '- [stack](project/stack.md)',
    '- [ci](project/ci.md)',
    '- [release](project/release.md)',
    '- [roadmap](project/roadmap.md)',
    '- [onboarding](project/onboarding.md)',
    '- [prefs](user/prefs.md)',
    '- [editor](user/editor.md)',
    '- [outward actions](feedback/outward-actions.md)',
    '- [commit style](feedback/commit-style.md)',
    '- [testing](feedback/testing.md)',
    '- [review](feedback/review.md)',
    '- [planning](feedback/planning.md)',
    '- [tone](feedback/tone.md)',
    '- [namespaces](reference/namespaces.md)',
    '- [quotas](reference/quotas.md)',
    '- [rate limit](reference/ratelimit.md)',
    '- [crypto](reference/crypto.md)',
    '- [storage](reference/storage.md)',
    '- [errors](reference/errors.md)',
    '- [tools](agent/tools.md)',
    '- [handoff](agent/handoff.md)',
    '- [escalation](agent/escalation.md)',
  ].join('\n'),

  'project/deploy.md': [
    '---',
    'name: deploy',
    'description: how we deploy memlawb',
    '---',
    'We deploy memlawb to fly.io from the main branch.',
    'CI must be green first; a red pipeline blocks the rollout.',
  ].join('\n'),

  'project/postgres-old.md': [
    '---',
    'name: postgres-old',
    'description: superseded note about the datastore',
    '---',
    'Dated 2026-01-04. We are planning to move the manifest into Postgres so two',
    'instances can share it.',
  ].join('\n'),

  'project/postgres-new.md': [
    '---',
    'name: postgres-new',
    'description: current decision about the datastore',
    '---',
    'The Postgres migration is parked. Single-instance with an in-process lock is',
    'correct for now, and we revisit only when a second instance is real.',
  ].join('\n'),

  'user/prefs.md': [
    '---',
    'name: prefs',
    'description: how the user likes answers formatted',
    '---',
    'Terse, direct answers. No preamble, no restating the question.',
  ].join('\n'),

  'feedback/outward-actions.md': [
    '---',
    'name: outward-actions',
    'description: when the agent may take outward actions',
    '---',
    'Pushing, opening PRs, and commenting all need explicit approval every time.',
    'A grant to do the local half is never a grant to publish it.',
  ].join('\n'),

  'feedback/commit-style.md': [
    '---',
    'name: commit-style',
    'description: shape of a good commit message',
    '---',
    'Conventional prefix, imperative subject, sign-off trailer.',
    'Why: the changelog is generated from the subject lines.',
  ].join('\n'),

  'feedback/testing.md': [
    '---',
    'name: testing',
    'description: how tests are expected to be written',
    '---',
    'Failing assertion first, implementation second, never both in one step.',
    'Why: a test authored beside its fix is vacuously green.',
  ].join('\n'),

  'feedback/review.md': [
    '---',
    'name: review',
    'description: what a review pass is for',
    '---',
    'A review exists to break the change, not to confirm it.',
    'Why: a happy-path pass is not evidence of anything.',
  ].join('\n'),

  'feedback/planning.md': [
    '---',
    'name: planning',
    'description: when a written plan is required',
    '---',
    'Anything larger than a one-line edit gets a plan before any code is typed.',
    'Why: a plan is cheaper to throw away than a branch.',
  ].join('\n'),

  'feedback/tone.md': [
    '---',
    'name: tone',
    'description: register to use in written output',
    '---',
    'Plain sentences, no filler adjectives, no dashes.',
    'Why: machine-sounding prose costs the reader trust.',
  ].join('\n'),

  'project/stack.md': [
    '---',
    'name: stack',
    'description: runtime and language choices',
    '---',
    'Bun and TypeScript, zero dependencies beyond the MCP SDK.',
    'Why: a small surface is auditable by one reader in one sitting.',
  ].join('\n'),

  'reference/namespaces.md': [
    '---',
    'name: namespaces',
    'description: namespace validation and slug rules',
    '---',
    'A namespace is scope plus segments. Traversal, backslash and NUL are rejected.',
    'Why: the slug becomes a path, so an unvalidated name is a traversal bug.',
  ].join('\n'),

  'project/ci.md': [
    '---',
    'name: ci',
    'description: what the pipeline runs on every commit',
    '---',
    'Lint, then type-check, then the full suite. Three gates, all blocking.',
    'Why: a green badge that skipped a gate is worse than no badge.',
  ].join('\n'),

  'project/release.md': [
    '---',
    'name: release',
    'description: how a version reaches the registry',
    '---',
    'A release bot cuts the tag from merged commits; nothing is tagged by hand.',
    'Why: hand-cut tags drift from the changelog.',
  ].join('\n'),

  'project/roadmap.md': [
    '---',
    'name: roadmap',
    'description: what is queued after the current milestone',
    '---',
    'Sharing grants, then multi-writer support, then a hosted control panel.',
    'Why: sharing unlocks the other two.',
  ].join('\n'),

  'project/onboarding.md': [
    '---',
    'name: onboarding',
    'description: first hour for a new contributor',
    '---',
    'Install, run the suite, read the trust-boundary section, then pick a task.',
    'Why: the boundary is the only thing a newcomer can break silently.',
  ].join('\n'),

  'user/editor.md': [
    '---',
    'name: editor',
    'description: the tool the user writes in',
    '---',
    'The user edits everything in Helix.',
  ].join('\n'),

  'reference/quotas.md': [
    '---',
    'name: quotas',
    'description: caps applied per namespace and per owner',
    '---',
    'Entry count, namespace bytes, and owner bytes are all checked together.',
    'Why: a partial cap check lets one tenant starve another.',
  ].join('\n'),

  'reference/ratelimit.md': [
    '---',
    'name: ratelimit',
    'description: throttling of noisy callers',
    '---',
    'A token bucket per caller, refilled on a fixed interval.',
    'Why: a burst from one caller should not degrade the rest.',
  ].join('\n'),

  'reference/storage.md': [
    '---',
    'name: storage',
    'description: adapters behind the blob interface',
    '---',
    'A filesystem adapter and an object-store adapter, both opaque-bytes only.',
    'Why: an adapter that understood the payload would be a boundary leak.',
  ].join('\n'),

  'reference/errors.md': [
    '---',
    'name: errors',
    'description: status codes the API returns',
    '---',
    'Denials are 403, missing entries 404, malformed bodies 400.',
    'Why: a denial rendered as an empty success is the worst failure mode.',
  ].join('\n'),

  'agent/tools.md': [
    '---',
    'name: tools',
    'description: which tools the agent exposes',
    '---',
    'Save, recall, search, list, delete. Everything else is out of scope.',
    'Why: a narrow tool list is easier to reason about than a wide one.',
  ].join('\n'),

  'agent/handoff.md': [
    '---',
    'name: handoff',
    'description: what a cold agent must be given',
    '---',
    'Full paths, exact commands, expected output, and where the work starts.',
    'Why: a cold agent has none of the shared context we do.',
  ].join('\n'),

  'agent/escalation.md': [
    '---',
    'name: escalation',
    'description: when to stop and ask a person',
    '---',
    'Ambiguity that could invalidate the whole task, and anything irreversible.',
    'Why: a wrong assumption compounds silently.',
  ].join('\n'),

  // Long, multi-section entry. U6 needs an entry whose useful answer is one
  // region rather than the whole body, so this one is deliberately several
  // hundred characters across several headings.
  'reference/crypto.md': [
    '---',
    'name: crypto',
    'description: envelope format and key derivation',
    '---',
    '## Key derivation',
    'A key is derived from the passphrase and a salt fixed by the namespace, using',
    'a memory-hard function. The passphrase itself is held only by the caller and',
    'is never transmitted anywhere.',
    '',
    '## Envelope',
    'Each envelope carries a leading version byte, then the nonce, then the sealed',
    'payload. The version byte exists so a future cipher suite can be introduced',
    'without orphaning anything already sealed under the current one.',
    '',
    '## Binding',
    'The entry key is bound into the sealed payload as associated data, so an',
    'envelope moved to a different key fails to open rather than opening as some',
    'other entry.',
    '',
    '## Determinism',
    'The nonce is derived from the key, the entry key and the payload, so equal',
    'payloads seal to equal bytes. That equality is what makes a delta upload',
    'possible at all; the accepted leak is whether two entries are byte-identical.',
  ].join('\n'),
}

/** A probe pair: a query, the entry it should surface, and what closes it. */
export type TuningPair = {
  query: string
  /** Entry key that must rank first, or null when nothing should rank. */
  expect: string | null
  /** Plan unit ids whose combined landing flips this pair. Empty = not closed by phase 1. */
  closedBy: string[]
  /**
   * True when phase 1 is not expected to fix this pair. Distinguishes an
   * accepted miss from the control pair, which is also `closedBy: []` because it
   * already passes. The harness reports residuals instead of asserting them.
   */
  residual?: boolean
  /** Why this pair exists, and for residuals, why phase 1 leaves it open. */
  note: string
}

/**
 * The measured probes. `closedBy: []` means phase 1 does not close the pair, so
 * the harness reports it rather than marking it `test.failing` (a marker that
 * never flips is noise, and would go red the day it accidentally passes).
 */
export const TUNING: TuningPair[] = [
  {
    query: 'namespace validation rules',
    expect: 'reference/namespaces.md',
    closedBy: [],
    note: 'exact-term control: the current ranker already passes this, hard-asserted from day one',
  },
  {
    query: 'deployment process',
    expect: 'project/deploy.md',
    closedBy: ['U2'],
    note: 'silent wrong answer today: "deployment" matches nothing, and "process" matches the in-process lock note',
  },
  {
    query: 'am I allowed to open a pull request',
    expect: 'feedback/outward-actions.md',
    closedBy: ['U2'],
    note: 'returns nothing today: the note says "opening PRs", so no query term matches unstemmed',
  },
  {
    query: 'what do I need to do before I push my work to the remote',
    expect: 'feedback/outward-actions.md',
    closedBy: ['U2', 'U3'],
    note: 'three-way one-term tie today; needs stemming to match "pushing" and rarity weighting to break the tie',
  },
  {
    query: 'how should I format my response',
    expect: 'user/prefs.md',
    closedBy: [],
    residual: true,
    note: 'accepted residual: "response" and "answers" are different words, and no phase 1 unit adds a synonym or embedding path',
  },
  {
    query: 'why do we hold these conventions',
    expect: null,
    closedBy: [],
    residual: true,
    note: 'accepted residual: every note carries a "Why:" line, so this ties broadly; phase 1 reduces ties, it does not eliminate them',
  },
  {
    query: 'are we moving to postgres',
    expect: 'project/postgres-new.md',
    closedBy: [],
    residual: true,
    note: 'accepted residual: the superseded note is textually just as good a match, and supersession needs the phase 2 confidence work',
  },
]

/** A held-out pair, authored against the low-overlap floor rather than the ranker. */
export type HeldOutPair = { query: string; expect: string }

/**
 * Held-out probes, never used to tune weights. The floor the harness enforces is
 * at most one shared content term (post-stemming) between the query and the
 * target's key plus body. Restating a sentence from the entry is ruled out by
 * construction: it would pass for any lexical ranker and would exclude exactly
 * the paraphrase failures this work exists to fix.
 *
 * Known limitation, recorded rather than hidden: these were authored by the same
 * hand that tunes the ranker, so the overlap floor is the only real independence
 * guarantee here. Independent authorship remains preferable and is unresolved.
 */
export const HELD_OUT: HeldOutPair[] = [
  { query: 'keep replies short', expect: 'user/prefs.md' },
  { query: 'do I have permission to publish this', expect: 'feedback/outward-actions.md' },
  { query: 'where does the code go live', expect: 'project/deploy.md' },
  { query: 'which program does she type into', expect: 'user/editor.md' },
  { query: 'will there be a second box serving traffic', expect: 'project/postgres-new.md' },
  { query: 'is there a ceiling on what a customer may keep', expect: 'reference/quotas.md' },
  { query: 'what happens if somebody floods us', expect: 'reference/ratelimit.md' },
  { query: 'which language did we build this in', expect: 'project/stack.md' },
  { query: 'what wording belongs in the history entry', expect: 'feedback/commit-style.md' },
  { query: 'at which point do I bring in a human', expect: 'agent/escalation.md' },
  { query: 'how does a sealed blob resist being swapped around', expect: 'reference/crypto.md' },
  { query: 'what should a fresh joiner do on day one', expect: 'project/onboarding.md' },
]

// Words too common to carry meaning. Kept in step with the ranker's own list so
// the overlap floor measures the same terms the ranker would.
const STOPWORDS = new Set(
  (
    'the a an and or to of in is it for on with that this i you my your we our as at be are was ' +
    'were do does what how when which their them they me'
  )
    .split(' ')
    .filter(Boolean),
)

/**
 * Deliberately aggressive suffix stripper, used ONLY to compute the held-out
 * overlap floor, never by the ranker. Over-stemming is the safe direction here:
 * it merges more words, so it can only make the floor stricter.
 */
export function stemTerm(term: string): string {
  let t = term
  for (const suffix of ['ements', 'ement', 'ments', 'ment', 'ations', 'ation', 'ings', 'ing']) {
    if (t.length > suffix.length + 2 && t.endsWith(suffix)) {
      t = t.slice(0, -suffix.length)
      break
    }
  }
  if (t.length > 4 && t.endsWith('ies')) t = `${t.slice(0, -3)}y`
  else
    for (const suffix of ['ers', 'er', 'ed', 'es', 's']) {
      if (t.length > suffix.length + 2 && t.endsWith(suffix)) {
        t = t.slice(0, -suffix.length)
        break
      }
    }
  // Collapse a doubled final consonant ("formatted" -> "formatt" -> "format")
  // and a silent final "e" ("move" and "moving" both -> "mov").
  if (t.length > 3 && t[t.length - 1] === t[t.length - 2] && !'aeiou'.includes(t[t.length - 1])) {
    t = t.slice(0, -1)
  }
  if (t.length > 3 && t.endsWith('e')) t = t.slice(0, -1)
  return t
}

/** Content terms of a string: lowercased, stopword-free, stemmed, de-duplicated. */
export function contentTerms(s: string): Set<string> {
  const out = new Set<string>()
  for (const raw of s.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue
    out.add(stemTerm(raw))
  }
  return out
}

/** Content terms shared between a query and an entry's key plus body. */
export function sharedTerms(query: string, entryKey: string, body: string): string[] {
  const entryTerms = contentTerms(`${entryKey} ${body}`)
  return [...contentTerms(query)].filter(t => entryTerms.has(t))
}

const FILLER_TOPICS = [
  'cache',
  'index',
  'queue',
  'router',
  'schema',
  'session',
  'transport',
  'worker',
]

/**
 * Deterministic near-cap corpus for latency work (U3). Content is derived from
 * the index alone: no clock, no randomness, so two runs on two machines produce
 * byte-identical input and a timing comparison means something.
 */
export function nearCapCorpus(n: number): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < n; i++) {
    const topic = FILLER_TOPICS[i % FILLER_TOPICS.length]
    const key = `generated/${topic}-${String(i).padStart(4, '0')}.md`
    out[key] = [
      '---',
      `name: ${topic}-${i}`,
      `description: generated note ${i} about the ${topic} layer`,
      '---',
      `Entry ${i} covers the ${topic} layer at revision ${i % 7}.`,
      `It mentions ${FILLER_TOPICS[(i + 3) % FILLER_TOPICS.length]} once for term spread.`,
      `Why: generated filler ${i} exists to make rarity and ties measurable.`,
    ].join('\n')
  }
  return out
}

/**
 * Baseline latency of the CURRENT ranker over `nearCapCorpus(2000)`, in
 * milliseconds. Measured 2026-08-06 on the project's Linux dev box (aarch64,
 * bun 1.3.14, 4 cores), median of thirteen consecutive runs, rounded up.
 *
 * Frozen literal on purpose, never re-measured in-run: U2 and U3 edit
 * `rankMemories` in place, so once they land there is no baseline ranker left to
 * measure and an in-run number would silently compare a change against itself.
 */
export const BASELINE_RANK_MS = 28
