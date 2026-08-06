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
 * Every byte here is invented for this fixture. The notes belong to Quillrun, a
 * made-up print-job routing service, and to Mara Delgado, a made-up engineer on
 * it; neither exists, and no line describes this project, its authors, or their
 * actual conventions. Nothing is sourced from a real
 * memory directory, and nothing is loaded at run time: no filesystem access, no
 * environment-supplied corpus path, no network. `tests/recall-regression.test.ts`
 * enforces that mechanically: it scans this file's own source for input hooks and
 * requires the module to import nothing at all, so the read cannot be moved one
 * hop away into a helper.
 *
 * One property of this text is load-bearing and easy to break while every
 * visible property survives: how many of a query's content terms its target
 * entry carries. Rewording an entry can leave the shared tokens, the "Why:"
 * lines and the unstemmed token all intact while dropping a target from three
 * matched terms to one, at which point the pair ties its competitors and the key
 * sort, not the ranker, decides it. Three units each rediscovered that
 * separately. `tests/recall-regression.test.ts` now pins the count per pair, so
 * check that guard before and after editing any entry body here.
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

  // The wrong-answer trap for "deployment process": this entry carries "deploy"
  // but never the query's own token, while the datastore note below carries
  // "in-process". Without stemming the datastore note wins a deployment question.
  'project/deploy.md': [
    '---',
    'name: deploy',
    'description: how we deploy Quillrun',
    '---',
    'We deploy Quillrun to the Ashfield cluster from the release branch.',
    'The smoke run must be green before a rollout; a red run stops it.',
  ].join('\n'),

  'project/postgres-old.md': [
    '---',
    'name: postgres-old',
    'description: superseded note about the datastore',
    '---',
    'Dated 2026-01-04. We are planning to move the routing table into Postgres so',
    'two dispatchers can share it.',
  ].join('\n'),

  'project/postgres-new.md': [
    '---',
    'name: postgres-new',
    'description: current decision about the datastore',
    '---',
    'The Postgres migration is parked. A single dispatcher with an in-process lock',
    'is correct for now, and we revisit it when a second dispatcher is real.',
  ].join('\n'),

  'user/prefs.md': [
    '---',
    'name: prefs',
    'description: how Mara likes answers formatted',
    '---',
    'Mara wants numbers first and narrative after, three sentences at most.',
  ].join('\n'),

  'feedback/outward-actions.md': [
    '---',
    'name: outward-actions',
    'description: when a change may leave the team fork',
    '---',
    'Pushing to the shared branch, opening PRs, and mailing shops each want a nod',
    'from the release captain. A go-ahead to build it is not one to publish it.',
    'Finished work waits on the fork until that nod lands, and the captain needs a',
    'diff and a green smoke run before giving it. Send that as its own request,',
    'never folded into the thread that approved the work.',
  ].join('\n'),

  'feedback/commit-style.md': [
    '---',
    'name: commit-style',
    'description: shape of a good commit message',
    '---',
    'Ticket id in the subject, then a verb, then the shop area it touches.',
    'Why: the weekly digest is assembled from subject lines.',
  ].join('\n'),

  'feedback/testing.md': [
    '---',
    'name: testing',
    'description: how tests are expected to be written',
    '---',
    'Every routing rule gets a table case with a sample order attached to it.',
    'Why: a rule with no sample order is untestable once its author forgets it.',
  ].join('\n'),

  'feedback/review.md': [
    '---',
    'name: review',
    'description: what a review pass is for',
    '---',
    'Two reviewers on anything that touches money, one on everything else.',
    'Why: a pricing slip reaches shops faster than we can catch it.',
  ].join('\n'),

  'feedback/planning.md': [
    '---',
    'name: planning',
    'description: when a written plan is required',
    '---',
    'Work spanning more than one service gets a one-page brief in the team doc.',
    'Why: cross-service scope is where our estimates fall apart.',
  ].join('\n'),

  'feedback/tone.md': [
    '---',
    'name: tone',
    'description: register to use in written output',
    '---',
    'Copy that shops read stays plain: no jargon, no exclamation marks.',
    'Why: a shop owner skims, and jargon reads as evasion.',
  ].join('\n'),

  'project/stack.md': [
    '---',
    'name: stack',
    'description: runtime and language choices',
    '---',
    'Go on the dispatcher side, NATS between sites, and no framework on top.',
    'Why: a small surface is easy for one on-call engineer to carry.',
  ].join('\n'),

  'reference/namespaces.md': [
    '---',
    'name: namespaces',
    'description: namespace validation and naming rules',
    '---',
    'A namespace is a region code plus a shop id. Blank segments, spaces and',
    'control bytes are refused.',
    'Why: the namespace becomes a routing key, so a bad name misroutes an order.',
  ].join('\n'),

  'project/ci.md': [
    '---',
    'name: ci',
    'description: what the pipeline runs on every commit',
    '---',
    'Vet, then unit tests, then a replay of yesterday orders. Three gates, all',
    'blocking.',
    'Why: a gate skipped once becomes a gate skipped always.',
  ].join('\n'),

  'project/release.md': [
    '---',
    'name: release',
    'description: how a version reaches the shops',
    '---',
    'A tag is cut from the release branch by the bot; nothing ships by hand.',
    'Why: hand-cut tags drift from the digest.',
  ].join('\n'),

  'project/roadmap.md': [
    '---',
    'name: roadmap',
    'description: what is queued after the current milestone',
    '---',
    'Split billing, then same-day routing, then a self-serve portal for shops.',
    'Why: billing blocks the other two.',
  ].join('\n'),

  'project/onboarding.md': [
    '---',
    'name: onboarding',
    'description: first hour for a new contributor',
    '---',
    'Clone, seed the sample shop, watch an order route end to end, then pick up a',
    'ticket.',
    'Why: an engineer who has not watched an order route guesses at the domain.',
  ].join('\n'),

  // The one-line fact entry.
  'user/editor.md': [
    '---',
    'name: editor',
    'description: the tool Mara drafts in',
    '---',
    'Mara writes every ticket in Nova.',
  ].join('\n'),

  'reference/quotas.md': [
    '---',
    'name: quotas',
    'description: caps applied per shop and per region',
    '---',
    'Queued orders, stored artifact bytes, and monthly volume are counted at once.',
    'Why: a partial check lets one shop starve another.',
  ].join('\n'),

  'reference/ratelimit.md': [
    '---',
    'name: ratelimit',
    'description: throttling of noisy callers',
    '---',
    'A token bucket per storefront, refilled on a fixed interval.',
    'Why: one storefront in a retry loop should not slow the rest.',
  ].join('\n'),

  'reference/storage.md': [
    '---',
    'name: storage',
    'description: adapters behind the artifact interface',
    '---',
    'A local disk adapter and an object-store adapter, both opaque-bytes only.',
    'Why: an adapter that parsed the payload would tie us to one print pipeline.',
  ].join('\n'),

  'reference/errors.md': [
    '---',
    'name: errors',
    'description: status codes the API returns',
    '---',
    'Refusals are 403, missing orders 404, malformed bodies 400.',
    'Why: a shop that sees 200 on a rejected order prints nothing and blames us.',
  ].join('\n'),

  'agent/tools.md': [
    '---',
    'name: tools',
    'description: which actions the dispatch bot exposes',
    '---',
    'Route, pause, reprint, cancel, and status. Nothing else is in scope.',
    'Why: a short action list is easier to audit than a wide one.',
  ].join('\n'),

  'agent/handoff.md': [
    '---',
    'name: handoff',
    'description: what the night shift must be given',
    '---',
    'Live incidents, the queue depth, and which sites are paused.',
    'Why: the remote night shift has none of the context the day shift built up.',
  ].join('\n'),

  'agent/escalation.md': [
    '---',
    'name: escalation',
    'description: when to stop and page a person',
    '---',
    'Anything that misroutes a paid order, and anything that cannot be undone.',
    'Why: a wrong assumption compounds quietly.',
  ].join('\n'),

  // Long, multi-section entry. U6 needs an entry whose useful answer is one
  // region rather than the whole body, so this one is deliberately several
  // hundred characters across several headings. Its only word from the
  // pull-request query is "opening", which the query's "open" reaches solely
  // through stemming, so before U2 this entry does not match that query at all.
  'reference/crypto.md': [
    '---',
    'name: crypto',
    'description: envelope format and key derivation',
    '---',
    '## Key derivation',
    'A bundle key is derived from the shop secret and a salt fixed by the region,',
    'using a memory-hard function. The shop secret stays on the storefront and',
    'never reaches a production site.',
    '',
    '## Envelope',
    'Each envelope carries a leading version byte, then the nonce, then the sealed',
    'artifact. The version byte is there so a later cipher suite can be introduced',
    'without orphaning artifacts already sealed under the current one.',
    '',
    '## Binding',
    'The order id is bound into the sealed artifact as associated data, so an',
    'envelope filed under a different order fails to unseal rather than opening',
    'as some other job.',
    '',
    '## Determinism',
    'The nonce is derived from the key, the order id and the artifact, so equal',
    'artifacts seal to equal bytes. That equality is what lets a reprint skip an',
    'upload; the accepted leak is whether two orders are byte-identical.',
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
    note: 'returns nothing today: no entry carries the unstemmed query token "open" (the rule says "opening PRs"), so every entry is dropped before scoring',
  },
  {
    query: 'what do I need to do before I push my work to the remote',
    expect: 'feedback/outward-actions.md',
    closedBy: ['U2', 'U3'],
    note: 'unstemmed, "push" misses "Pushing" and the rule drops to a one-term tie the key sort decides; stemming restores its three-term match and rarity weighting keeps a common term from levelling it',
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

// Words too common to carry meaning. Must match the ranker's own list, so the
// overlap floor measures the same terms the ranker sees. Exported because
// `tests/recall-regression.test.ts` asserts set equality against the ranker's
// list; the claim used to be a comment nothing enforced.
export const STOPWORDS = new Set(
  (
    'the a an and or to of in is it for on with that this i you my your we our as at be are was ' +
    'were do does what how when which their them they me should would could must may might shall ' +
    'will can did have has had been being am who whom whose why where there here if so but not no ' +
    'yes all any some each both more most other such only same then than too very just also about ' +
    'into over under after before again once from by through without during between against within ' +
    'upon across since until while because he she him her his its us'
  )
    .split(' ')
    .filter(Boolean),
)

/**
 * How a word is normalized when the overlap floor is computed. This module used
 * to carry its own suffix stripper, which drifted from the ranker's the moment
 * the ranker grew one: the floor is supposed to measure the terms the ranker
 * actually sees, so a second implementation makes it measure something else
 * while still reading as if it did the job. The stemmer is now injected instead,
 * and the caller passes `stemTerm` from `src/mcp/relevance.ts`. It has to be a
 * parameter rather than an import because this module must import nothing at
 * all (see the corpus provenance check); it has no default, so nobody can
 * quietly reintroduce a local one.
 */
export type StemFn = (term: string) => string

/** Content terms of a string: lowercased, stopword-free, stemmed, de-duplicated. */
export function contentTerms(s: string, stem: StemFn): Set<string> {
  const out = new Set<string>()
  for (const raw of s.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue
    out.add(stem(raw))
  }
  return out
}

/** Content terms shared between a query and an entry's key plus body. */
export function sharedTerms(query: string, entryKey: string, body: string, stem: StemFn): string[] {
  const entryTerms = contentTerms(`${entryKey} ${body}`, stem)
  return [...contentTerms(query, stem)].filter(t => entryTerms.has(t))
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
 * The four words an unguarded suffix stripper was measured mangling: `thing`
 * became `th`, `king` became `k`, `bring` became `br`, `sing` became `s`. Short
 * stems are what manufacture false matches, so these are named individually as
 * well as covered by the whole-vocabulary property below.
 */
export const DAMAGE_WORDS = ['thing', 'king', 'bring', 'sing']

/** Roots the damage vocabulary is generated from. Ordinary English, no corpus content. */
const VOCAB_ROOTS = [
  'act',
  'add',
  'age',
  'aim',
  'app',
  'arm',
  'ask',
  'bag',
  'ban',
  'bar',
  'bind',
  'board',
  'boss',
  'box',
  'bring',
  'build',
  'call',
  'care',
  'cache',
  'chain',
  'change',
  'class',
  'clock',
  'close',
  'code',
  'copy',
  'count',
  'cover',
  'craft',
  'cross',
  'deploy',
  'design',
  'draw',
  'drive',
  'drop',
  'edit',
  'entry',
  'fail',
  'field',
  'file',
  'fill',
  'find',
  'fix',
  'flag',
  'form',
  'frame',
  'glass',
  'grant',
  'group',
  'guard',
  'hand',
  'hash',
  'help',
  'hold',
  'index',
  'join',
  'key',
  'kind',
  'king',
  'lack',
  'land',
  'lead',
  'learn',
  'level',
  'limit',
  'line',
  'link',
  'list',
  'load',
  'lock',
  'log',
  'look',
  'mail',
  'make',
  'map',
  'mark',
  'mask',
  'match',
  'merge',
  'mind',
  'miss',
  'mount',
  'move',
  'name',
  'note',
  'open',
  'order',
  'pack',
  'pair',
  'part',
  'pass',
  'patch',
  'path',
  'pause',
  'pick',
  'place',
  'plan',
  'play',
  'point',
  'press',
  'print',
  'process',
  'proof',
  'pull',
  'push',
  'query',
  'queue',
  'quote',
  'read',
  'rest',
  'ring',
  'route',
  'rule',
  'run',
  'save',
  'scan',
  'seal',
  'send',
  'set',
  'ship',
  'shop',
  'show',
  'sign',
  'sing',
  'sort',
  'split',
  'stack',
  'stage',
  'stamp',
  'start',
  'state',
  'step',
  'stop',
  'store',
  'stress',
  'swap',
  'sync',
  'tag',
  'talk',
  'task',
  'test',
  'thing',
  'think',
  'throw',
  'time',
  'trace',
  'track',
  'trim',
  'trust',
  'turn',
  'type',
  'use',
  'view',
  'wait',
  'walk',
  'watch',
  'work',
  'wrap',
  'write',
  'yield',
]

/** Endings the generator glues on. Some products are non-words; that is the point. */
const VOCAB_SUFFIXES = [
  '',
  's',
  'es',
  'ed',
  'er',
  'ers',
  'ing',
  'ings',
  'ment',
  'ments',
  'ation',
  'ations',
  'ies',
  'ly',
]

/**
 * Generated vocabulary for the stemmer damage test: every root crossed with
 * every ending, deduplicated and sorted so the set is deterministic and the
 * assertions run over roughly two thousand words rather than a handful somebody
 * remembered to list. Synthetic by construction per the corpus rules: nothing
 * here is read from a memory directory or derived from CORPUS.
 */
export const DAMAGE_VOCAB: string[] = [
  ...new Set(VOCAB_ROOTS.flatMap(root => VOCAB_SUFFIXES.map(suffix => `${root}${suffix}`))),
].sort()

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
