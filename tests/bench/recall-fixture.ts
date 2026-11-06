/**
 * Seeded corpus and question generator for the recall quality harness.
 *
 * `tests/recall-corpus.ts` pins twenty-six hand-written notes and twelve
 * held-out probes, which is enough to catch a specific regression and far too
 * little to measure a ranker: a 4/12 top-1 floor moves by a whole pair at a
 * time, and nothing in it reproduces the failure the research audit found at
 * scale, where a short one-fact note loses to long notes that repeat the same
 * topic vocabulary without holding the fact. This module generates that
 * situation on purpose, from a seed, so the number it produces is the same on
 * every machine and any change to it is a change to the ranker or to this
 * file, never to the weather.
 *
 * Shape of one run of `fixture(seed, size)`:
 *
 * - 160 fact notes, one per (template, subject) pair drawn from the folder
 *   templates below: preferences under `user/`, rules under `feedback/`,
 *   decisions under `project/`, links and limits under `reference/`. Each has
 *   frontmatter (`name`, `description`, `type`), a `# title`, the fact in a
 *   sentence, and for rules and decisions a `Why:` line, as the memory guide
 *   prescribes. Most are 150-350 characters; some carry a few `Context:`
 *   sentences and reach 1,500.
 * - A quarter of the facts are update pairs: an older dated note with one
 *   value and a newer note with another, each stamped `updated:` with its
 *   date the way `memory_save` stamps a note. The newer one is the gold
 *   answer and the older one is the note a recency-blind ranker will tie
 *   with; the stamp is what a recency tiebreak has to go on.
 * - Noise up to `size`: a tenth of the corpus is long notes (1,000-2,000
 *   characters) that reuse a fact's topic words and subject without stating
 *   the fact, and the rest are short generic engineering notes on unrelated
 *   topics. The mean note length lands near 400 characters, which is the size
 *   the test budget was measured at.
 * - A generated `MEMORY.md` index naming every note. The ranker drops it; the
 *   grep baseline sees it, as the real `memory_search` does.
 *
 * The questions are generated BEFORE the noise, so the same seed yields the
 * same questions at both sizes and the 10,000-entry run is "the same questions
 * in a bigger haystack". Kinds: `lexical` restates the fact's own topic words
 * (at least two shared content terms with the gold), `paraphrase` shares at
 * most one (the subject), `update` is a lexical question whose gold has a
 * superseded sibling, and `unanswerable` asks about a topic no note covers
 * using words every note uses, so the floor cannot drop it for free.
 *
 * The classification of a question as lexical or paraphrase is INTENDED here
 * and VERIFIED in `tests/recall-bench.test.ts` with the ranker's own stemmer,
 * because this module imports nothing at all. That constraint is the same one
 * `tests/recall-corpus.ts` lives under and is enforced by the same provenance
 * guard in `tests/recall-regression.test.ts`: no filesystem, no environment,
 * no network, no module system, and an exact allowlist of the globals the
 * code may name. Every name, service and value below is invented; none
 * describes this project, its authors, or anyone's real memory directory.
 *
 * Raise `GENERATOR_VERSION` when the output for a given seed changes. The
 * committed questions and baseline carry the version they were produced by,
 * and the test refuses a mismatch rather than comparing numbers from two
 * different corpora.
 */

export const GENERATOR_VERSION = '2'

export type QuestionKind = 'lexical' | 'paraphrase' | 'update' | 'unanswerable'

export type Question = {
  id: string
  query: string
  /** Entry key that answers the question, or null when nothing does. */
  gold: string | null
  kind: QuestionKind
  /** For `update` questions: the older note that the gold replaces. */
  superseded?: string
}

export type FixtureSize = 2000 | 10000

export type Fixture = { corpus: Record<string, string>; questions: Question[] }

/** Facts generated per run; the questions are drawn from these. */
export const FACT_COUNT = 160
/** Facts that get an older sibling with a different value. */
export const UPDATE_COUNT = 40
/** Non-update facts that get a lexical and a paraphrase question each. */
export const QUESTIONED_COUNT = 70

/* ----------------------------------------------------------------------- *
 * Seeded randomness. mulberry32: 32-bit state, one multiply per draw, good
 * enough for shuffling a fixture and small enough to read in full.
 * ----------------------------------------------------------------------- */

type Rng = () => number

function mulberry32(seed: number): Rng {
  let state = seed >>> 0
  return () => {
    // 0x6d2b79f5, written in decimal because the provenance guard's identifier
    // scan reads the hex spelling as a name.
    state = (state + 1831565813) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Integer in [0, n). */
function below(rng: Rng, n: number): number {
  return (rng() * n) | 0
}

function pick(rng: Rng, items: readonly string[]): string {
  return items[below(rng, items.length)]
}

/** A random permutation of 0..n-1 (Fisher-Yates). */
function permutation(rng: Rng, n: number): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(i)
  for (let i = n - 1; i > 0; i--) {
    const j = below(rng, i + 1)
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/* ----------------------------------------------------------------------- *
 * Vocabularies. Services and people are the subjects a fact is about; each
 * template below fixes the rest of the wording.
 * ----------------------------------------------------------------------- */

const SERVICES = [
  'kestrel',
  'marrow',
  'foxglove',
  'tidewater',
  'bramble',
  'larkspur',
  'quarry',
  'saltmarsh',
  'ember',
  'wren',
]

const PEOPLE = [
  'mara',
  'tobias',
  'priya',
  'ines',
  'dmitri',
  'yusuf',
  'hana',
  'lior',
  'noor',
  'sven',
]

const REGIONS = ['eu-west-2', 'us-east-1', 'ap-south-1', 'ca-central-1', 'eu-north-1', 'sa-east-1']

type Folder = 'user' | 'feedback' | 'project' | 'reference'

type Template = {
  folder: Folder
  slug: string
  /** Topic words the lexical questions and the long noise notes reuse. */
  topic: string[]
  /** Values the fact can take; an update pair draws two distinct ones. */
  values: string[]
  title: (s: string) => string
  description: (s: string) => string
  fact: (s: string, v: string) => string
  /** Empty string for notes that carry no Why: line. */
  why: (s: string) => string
  /** Share at least two content terms with the gold (subject plus topic). */
  lexical: ((s: string) => string)[]
  /** Share at most one content term with the gold (the subject). */
  paraphrase: ((s: string) => string)[]
}

const TEMPLATES: Template[] = [
  // ---- project/: decisions ------------------------------------------------
  {
    folder: 'project',
    slug: 'deploy-region',
    topic: ['deploy', 'region', 'cluster', 'rollout'],
    values: REGIONS,
    title: s => `Deploy region for ${s}`,
    description: s => `where ${s} is deployed`,
    fact: (s, v) => `${capitalize(s)} deploys to ${v}; nothing runs outside that region.`,
    why: () => 'the latency target to the main customer base only holds from there.',
    lexical: [s => `which region does ${s} deploy to`, s => `${s} deploy region`],
    paraphrase: [
      s => `where in the world is ${s} hosted`,
      s => `which part of the map serves ${s} traffic`,
    ],
  },
  {
    folder: 'project',
    slug: 'datastore',
    topic: ['datastore', 'storage', 'database', 'migration'],
    values: [
      'postgres',
      'sqlite',
      'dynamo',
      'redis',
      'rocksdb',
      'cassandra',
      'mysql',
      'clickhouse',
    ],
    title: s => `Datastore for ${s}`,
    description: s => `which database ${s} keeps its state in`,
    fact: (s, v) =>
      `${capitalize(s)} keeps its state in ${v}; the migration to anything else is parked.`,
    why: () => 'one datastore per service keeps the on-shift engineer able to carry it.',
    lexical: [s => `which database does ${s} use`, s => `${s} datastore decision`],
    paraphrase: [
      s => `where does ${s} persist its rows`,
      s => `what system holds the records for ${s}`,
    ],
  },
  {
    folder: 'project',
    slug: 'runtime',
    topic: ['runtime', 'version', 'language', 'toolchain'],
    values: ['node 24', 'bun 1.3', 'go 1.24', 'rust 1.86', 'python 3.13', 'deno 2.2', 'java 21'],
    title: s => `Runtime for ${s}`,
    description: s => `language and runtime ${s} is written against`,
    fact: (s, v) =>
      `${capitalize(s)} is written against ${v}; the toolchain is pinned in the repo.`,
    why: () => 'a floating toolchain made two builds of the same commit differ.',
    lexical: [s => `what runtime does ${s} run on`, s => `${s} language and version`],
    paraphrase: [s => `which interpreter executes ${s}`, s => `what is ${s} coded in`],
  },
  {
    folder: 'project',
    slug: 'broker',
    topic: ['queue', 'broker', 'message', 'events'],
    values: ['nats', 'kafka', 'rabbitmq', 'sqs', 'redpanda', 'pulsar'],
    title: s => `Message broker for ${s}`,
    description: s => `which queue carries ${s} events`,
    fact: (s, v) =>
      `${capitalize(s)} events ride on ${v}; there is one broker per region, never a shared one.`,
    why: () => 'a shared broker let one noisy tenant delay everyone.',
    lexical: [s => `which message broker does ${s} use`, s => `${s} queue and events`],
    paraphrase: [
      s => `how do ${s} jobs get handed between workers`,
      s => `what transport ferries ${s} work async`,
    ],
  },
  {
    folder: 'project',
    slug: 'hosting',
    topic: ['hosting', 'provider', 'servers', 'infrastructure'],
    values: ['fly', 'render', 'hetzner', 'railway', 'linode', 'scaleway', 'vultr', 'ovh'],
    title: s => `Hosting for ${s}`,
    description: s => `which provider runs the ${s} servers`,
    fact: (s, v) =>
      `${capitalize(s)} is hosted on ${v}; the infrastructure is declared in the ops repo.`,
    why: () => 'moving providers by hand lost a box once.',
    lexical: [s => `which hosting provider does ${s} use`, s => `where are the ${s} servers`],
    paraphrase: [
      s => `who do we rent the ${s} machines from`,
      s => `what company bills us for ${s} compute`,
    ],
  },
  {
    folder: 'project',
    slug: 'release-cadence',
    topic: ['release', 'cadence', 'ship', 'tag'],
    values: ['weekly on tuesday', 'every second friday', 'monthly', 'on demand', 'daily'],
    title: s => `Release cadence for ${s}`,
    description: s => `how often ${s} ships`,
    fact: (s, v) => `${capitalize(s)} ships ${v}; the bot cuts the tag, nothing goes out by hand.`,
    why: () => 'hand-cut tags drifted from the changelog.',
    lexical: [s => `how often does ${s} release`, s => `${s} release cadence`],
    paraphrase: [
      s => `what rhythm do ${s} deploys follow`,
      s => `when do new builds of ${s} reach customers`,
    ],
  },
  {
    folder: 'project',
    slug: 'branch-model',
    topic: ['branch', 'merge', 'trunk', 'git'],
    values: [
      'trunk-based with short-lived branches',
      'release branches per minor',
      'gitflow',
      'a single main branch and tags',
      'stacked diffs',
    ],
    title: s => `Branch model for ${s}`,
    description: s => `how ${s} branches and merges`,
    fact: (s, v) => `${capitalize(s)} uses ${v}; merges go through the bot, never direct.`,
    why: () => 'direct merges skipped the gate twice.',
    lexical: [s => `what branch model does ${s} use`, s => `how do we merge in ${s}`],
    paraphrase: [
      s => `how is the ${s} history organised`,
      s => `what is the workflow for landing code in ${s}`,
    ],
  },
  {
    folder: 'project',
    slug: 'auth',
    topic: ['auth', 'login', 'identity', 'session'],
    values: ['oidc through keycloak', 'auth0', 'magic links', 'passkeys', 'saml via okta'],
    title: s => `Auth for ${s}`,
    description: s => `how ${s} users log in`,
    fact: (s, v) => `${capitalize(s)} logs users in with ${v}; sessions last twelve hours.`,
    why: () => 'one identity path keeps the audit trail readable.',
    lexical: [s => `how does ${s} auth work`, s => `${s} login and identity`],
    paraphrase: [
      s => `what proves who someone is on ${s}`,
      s => `which sign-in mechanism guards ${s}`,
    ],
  },

  // ---- reference/: links and limits ------------------------------------
  {
    folder: 'reference',
    slug: 'rate-limit',
    topic: ['rate', 'limit', 'throttle', 'requests'],
    values: [
      '120 requests per minute',
      '600 requests per minute',
      '20 requests per second',
      '5000 requests per hour',
      '60 requests per minute',
    ],
    title: s => `Rate limit for ${s}`,
    description: s => `the throttle on ${s} callers`,
    fact: (s, v) =>
      `${capitalize(s)} throttles each caller at ${v}; the bucket refills on a fixed interval.`,
    why: () => 'one caller in a retry loop should not slow the rest.',
    lexical: [s => `what is the rate limit for ${s}`, s => `${s} throttle`],
    paraphrase: [
      s => `how many hits may a single client send to ${s}`,
      s => `at what pace does ${s} start rejecting a chatty consumer`,
    ],
  },
  {
    folder: 'reference',
    slug: 'log-retention',
    topic: ['retention', 'logs', 'days', 'purge'],
    values: ['30 days', '90 days', '7 days', '14 days', '180 days', 'one year'],
    title: s => `Log retention for ${s}`,
    description: s => `how long ${s} logs are kept`,
    fact: (s, v) => `${capitalize(s)} logs are purged after ${v}; nothing older is restorable.`,
    why: () => 'storage cost, and nobody asked for an older log in a year.',
    lexical: [s => `how long are ${s} logs kept`, s => `${s} log retention`],
    paraphrase: [
      s => `when does old ${s} output get deleted`,
      s => `how far back can I inspect ${s} history`,
    ],
  },
  {
    folder: 'reference',
    slug: 'payload-cap',
    topic: ['cap', 'size', 'bytes', 'payload'],
    values: ['250 kb', '1 mb', '64 kb', '512 kb', '4 mb', '100 kb'],
    title: s => `Payload cap for ${s}`,
    description: s => `the largest payload ${s} accepts`,
    fact: (s, v) =>
      `${capitalize(s)} refuses any payload above ${v}; the cap is checked before parsing.`,
    why: () => 'an unbounded body once filled a disk.',
    lexical: [s => `what is the payload cap for ${s}`, s => `max payload size ${s}`],
    paraphrase: [
      s => `how big a request will ${s} swallow`,
      s => `what is the upper bound on what you can send ${s}`,
    ],
  },
  {
    folder: 'reference',
    slug: 'timeout',
    topic: ['timeout', 'deadline', 'seconds', 'latency'],
    values: ['30 seconds', '5 seconds', '2 minutes', '10 seconds', '90 seconds', '1 second'],
    title: s => `Request timeout for ${s}`,
    description: s => `how long ${s} waits before giving up`,
    fact: (s, v) =>
      `${capitalize(s)} gives up on a call after ${v}; the deadline is propagated downstream.`,
    why: () => 'a missing deadline let one stuck call pin a worker for an hour.',
    lexical: [s => `what is the timeout for ${s}`, s => `${s} request deadline`],
    paraphrase: [
      s => `how patient is ${s} with a slow upstream`,
      s => `at what point does ${s} abandon a stalled reply`,
    ],
  },
  {
    folder: 'reference',
    slug: 'port',
    topic: ['port', 'listen', 'socket', 'bind'],
    values: ['8080', '9443', '7700', '3030', '5055', '8443'],
    title: s => `Listen port for ${s}`,
    description: s => `the port ${s} binds`,
    fact: (s, v) => `${capitalize(s)} listens on port ${v}; the socket is bound on loopback only.`,
    why: () => 'a public bind exposed the admin surface once.',
    lexical: [s => `which port does ${s} listen on`, s => `${s} port number`],
    paraphrase: [
      s => `where on the network does ${s} accept connections`,
      s => `what address does the ${s} daemon answer on`,
    ],
  },
  {
    folder: 'reference',
    slug: 'dashboard',
    topic: ['dashboard', 'metrics', 'graphs', 'monitoring'],
    values: [
      'https://dash.example.net/d/a1b2',
      'https://dash.example.net/d/c3d4',
      'https://dash.example.net/d/e5f6',
      'https://dash.example.net/d/g7h8',
      'https://dash.example.net/d/j9k0',
      'https://dash.example.net/d/m2n3',
    ],
    title: s => `Dashboard for ${s}`,
    description: s => `where the ${s} metrics graphs live`,
    fact: (s, v) => `The ${s} dashboard is at ${v}; the top row is the golden signals.`,
    why: () => '',
    lexical: [s => `link to the ${s} dashboard`, s => `${s} metrics dashboard`],
    paraphrase: [
      s => `where can I eyeball ${s} health at a glance`,
      s => `which page shows the ${s} charts`,
    ],
  },
  {
    folder: 'reference',
    slug: 'config-path',
    topic: ['config', 'path', 'file', 'settings'],
    values: [
      '/etc/app/config.toml',
      '/opt/app/settings.yaml',
      '~/.config/app/app.toml',
      '/srv/app/env',
      '/var/lib/app/config.json',
      '/usr/local/etc/app.ini',
    ],
    title: s => `Config path for ${s}`,
    description: s => `where the ${s} settings file lives`,
    fact: (s, v) =>
      `${capitalize(s)} reads its settings from ${v}; environment variables override single keys.`,
    why: () => '',
    lexical: [s => `where is the ${s} config file`, s => `${s} settings path`],
    paraphrase: [
      s => `which location does ${s} load its options from on boot`,
      s => `what holds the knobs for ${s} at startup`,
    ],
  },
  {
    folder: 'reference',
    slug: 'repository',
    topic: ['repo', 'repository', 'source', 'code'],
    values: [
      'git.example.org/platform/core',
      'git.example.org/infra/edge',
      'git.example.org/data/pipes',
      'git.example.org/apps/portal',
      'git.example.org/tools/belt',
      'git.example.org/lab/forge',
    ],
    title: s => `Repository for ${s}`,
    description: s => `where the ${s} source code lives`,
    fact: (s, v) => `The ${s} source is at ${v}; the default branch is protected.`,
    why: () => '',
    lexical: [s => `where is the ${s} source repository`, s => `${s} source code repository`],
    paraphrase: [
      s => `which remote do I clone to hack on ${s}`,
      s => `where is the ${s} codebase hosted`,
    ],
  },

  // ---- feedback/: rules ---------------------------------------------------
  {
    folder: 'feedback',
    slug: 'review-rule',
    topic: ['review', 'reviewers', 'approve', 'change'],
    values: [
      'two reviewers',
      'one reviewer',
      'a reviewer from the owning team',
      'two reviewers and a security read',
      'the on-shift reviewer',
    ],
    title: s => `Review rule for ${s}`,
    description: s => `who must review a change to ${s}`,
    fact: (s, v) => `A change to ${s} needs ${v} before it merges.`,
    why: () => 'a pricing slip reached customers faster than we could catch it.',
    lexical: [s => `how many reviewers does a ${s} change need`, s => `${s} review rule`],
    paraphrase: [
      s => `who has to sign off on ${s} work`,
      s => `what approval must a ${s} diff collect`,
    ],
  },
  {
    folder: 'feedback',
    slug: 'test-rule',
    topic: ['tests', 'suite', 'done', 'green'],
    values: [
      'the full suite',
      'the touched suites plus lint',
      'the full suite and a build',
      'unit tests only, integration in ci',
      'the smoke suite',
    ],
    title: s => `Test rule for ${s}`,
    description: s => `what must be green before ${s} work is called done`,
    fact: (s, v) => `Before calling ${s} work done, run ${v}.`,
    why: () => 'a red suite announced as done cost a release.',
    lexical: [s => `what tests do I run before ${s} work is done`, s => `${s} test rule`],
    paraphrase: [
      s => `what has to pass before I report finishing on ${s}`,
      s => `which checks gate a ${s} task being complete`,
    ],
  },
  {
    folder: 'feedback',
    slug: 'commit-style',
    topic: ['commit', 'message', 'subject', 'ticket'],
    values: [
      'ticket id first, then a verb',
      'a verb first, ticket in the footer',
      'conventional commits with a scope',
      'imperative subject under 50 chars',
      'area prefix then a sentence',
    ],
    title: s => `Commit style for ${s}`,
    description: s => `shape of a ${s} commit message`,
    fact: (s, v) => `${capitalize(s)} commit messages are written as ${v}.`,
    why: () => 'the weekly digest is assembled from subject lines.',
    lexical: [s => `how should I write commit messages for ${s}`, s => `${s} commit message style`],
    paraphrase: [
      s => `what wording belongs in the ${s} history entry`,
      s => `how do we phrase a changeset note in ${s}`,
    ],
  },
  {
    folder: 'feedback',
    slug: 'pull-request-size',
    topic: ['pull', 'request', 'lines', 'split'],
    values: [
      'under 300 lines',
      'under 150 lines',
      'one logical change',
      'under 500 lines or split',
      'reviewable in ten minutes',
    ],
    title: s => `Pull request size for ${s}`,
    description: s => `how large a ${s} pull request may be`,
    fact: (s, v) => `Keep a ${s} pull request ${v}; split anything bigger.`,
    why: () => 'large changes get rubber-stamped.',
    lexical: [s => `how big can a ${s} pull request be`, s => `${s} pull request size limit`],
    paraphrase: [
      s => `when should I break ${s} work into smaller pieces`,
      s => `what is the ceiling on a single ${s} diff`,
    ],
  },
  {
    folder: 'feedback',
    slug: 'migration-rule',
    topic: ['migration', 'schema', 'reversible', 'rollback'],
    values: [
      'always reversible',
      'expand then contract',
      'behind a flag with a backfill',
      'reviewed by the platform team',
      'rehearsed on a copy first',
    ],
    title: s => `Migration rule for ${s}`,
    description: s => `how ${s} schema migrations are done`,
    fact: (s, v) =>
      `${capitalize(s)} schema migrations are ${v}; a rollback is rehearsed before the rollout.`,
    why: () => 'an irreversible migration took a weekend to undo.',
    lexical: [s => `how do we do schema migrations in ${s}`, s => `${s} migration rule`],
    paraphrase: [
      s => `what are the steps for altering ${s} tables`,
      s => `how careful must we be changing the ${s} column structure`,
    ],
  },
  {
    folder: 'feedback',
    slug: 'force-push',
    topic: ['force', 'push', 'rewrite', 'history'],
    values: [
      'never',
      'only on your own branch',
      'only with a lease',
      'never on shared branches',
      'only after a heads-up in chat',
    ],
    title: s => `Force push rule for ${s}`,
    description: s => `when a force push is allowed on ${s}`,
    fact: (s, v) => `Force pushing on ${s}: ${v}.`,
    why: () => 'a rewritten shared branch lost a day of work once.',
    lexical: [s => `am I allowed to force push on ${s}`, s => `${s} force push rule`],
    paraphrase: [
      s => `can I overwrite what is already upstream for ${s}`,
      s => `is rewriting published commits ok in ${s}`,
    ],
  },
  {
    folder: 'feedback',
    slug: 'changelog-rule',
    topic: ['changelog', 'entry', 'user-facing', 'notes'],
    values: [
      'every user-facing change',
      'only breaking changes',
      'every merged pull request',
      'anything a customer could notice',
      'nothing, the release bot writes it',
    ],
    title: s => `Changelog rule for ${s}`,
    description: s => `what gets a ${s} changelog entry`,
    fact: (s, v) => `Add a ${s} changelog entry for ${v}.`,
    why: () => 'support reads the changelog before the release note goes out.',
    lexical: [s => `what needs a changelog entry in ${s}`, s => `${s} changelog rule`],
    paraphrase: [
      s => `which ${s} modifications must be announced to the audience`,
      s => `what deserves a mention in the ${s} public announcements`,
    ],
  },
  {
    folder: 'feedback',
    slug: 'ask-first',
    topic: ['ask', 'confirm', 'destructive', 'delete'],
    values: [
      'deleting anything',
      'touching production data',
      'spending money',
      'contacting a customer',
      'rotating a credential',
    ],
    title: s => `Ask before acting on ${s}`,
    description: s => `what needs explicit confirmation on ${s}`,
    fact: (s, v) => `On ${s}, ask before ${v}; a go-ahead for the task is not one for that.`,
    why: () => 'a wrong assumption compounds quietly.',
    lexical: [s => `what do I need to confirm before acting on ${s}`, s => `${s} ask before rule`],
    paraphrase: [
      s => `which ${s} actions want a human nod and which do not`,
      s => `where is the boundary I must not cross alone on ${s}`,
    ],
  },

  // ---- user/: preferences ---------------------------------------------
  {
    folder: 'user',
    slug: 'answer-format',
    topic: ['answers', 'format', 'numbers', 'narrative'],
    values: [
      'numbers first and narrative after',
      'bullets, never prose',
      'a one-line summary then detail',
      'tables for anything comparative',
      'prose, no bullet lists',
    ],
    title: s => `Answer format for ${capitalize(s)}`,
    description: s => `how ${capitalize(s)} likes answers formatted`,
    fact: (s, v) => `${capitalize(s)} wants ${v}, three sentences at most.`,
    why: () => '',
    lexical: [s => `how does ${s} like answers formatted`, s => `${s} answer format`],
    paraphrase: [
      s => `what shape of reply suits ${s}`,
      s => `how should I lay out a response for ${s}`,
    ],
  },
  {
    folder: 'user',
    slug: 'editor',
    topic: ['editor', 'drafts', 'writes', 'tool'],
    values: ['nova', 'helix', 'zed', 'emacs', 'neovim', 'sublime'],
    title: s => `Editor ${capitalize(s)} uses`,
    description: s => `the tool ${capitalize(s)} drafts in`,
    fact: (s, v) => `${capitalize(s)} writes everything in ${v}.`,
    why: () => '',
    lexical: [s => `which editor does ${s} use`, s => `${s} editor`],
    paraphrase: [
      s => `what program does ${s} prefer for typing`,
      s => `where does ${s} compose text`,
    ],
  },
  {
    folder: 'user',
    slug: 'package-manager',
    topic: ['package', 'manager', 'install', 'lockfile'],
    values: ['pnpm', 'bun', 'yarn', 'npm', 'uv', 'cargo'],
    title: s => `Package manager for ${capitalize(s)}`,
    description: s => `which package manager ${capitalize(s)} wants used`,
    fact: (s, v) => `${capitalize(s)} installs with ${v}; do not switch the lockfile.`,
    why: () => '',
    lexical: [s => `which package manager does ${s} use`, s => `${s} package manager`],
    paraphrase: [
      s => `what does ${s} run to pull in dependencies`,
      s => `how does ${s} add a library to a codebase`,
    ],
  },
  {
    folder: 'user',
    slug: 'shell',
    topic: ['shell', 'terminal', 'prompt', 'scripts'],
    values: ['fish', 'zsh', 'nushell', 'bash', 'elvish', 'xonsh'],
    title: s => `Shell ${capitalize(s)} runs`,
    description: s => `the shell and terminal ${capitalize(s)} works in`,
    fact: (s, v) => `${capitalize(s)} runs ${v}; assume that shell when writing scripts.`,
    why: () => '',
    lexical: [s => `which shell does ${s} use`, s => `${s} shell and terminal`],
    paraphrase: [
      s => `what command line does ${s} live in`,
      s => `which interpreter parses the dotfiles of ${s}`,
    ],
  },
  {
    folder: 'user',
    slug: 'timezone',
    topic: ['timezone', 'hours', 'working', 'schedule'],
    values: ['utc+2', 'utc-5', 'utc+9', 'utc', 'utc-8', 'utc+5:30'],
    title: s => `Timezone for ${capitalize(s)}`,
    description: s => `the working hours ${capitalize(s)} keeps`,
    fact: (s, v) => `${capitalize(s)} works on ${v} and is offline after 18:00 local.`,
    why: () => '',
    lexical: [s => `what timezone is ${s} in`, s => `${s} working hours`],
    paraphrase: [
      s => `when during the day can I expect ${s} to be around`,
      s => `what part of the globe is ${s} awake in`,
    ],
  },
  {
    folder: 'user',
    slug: 'tone',
    topic: ['tone', 'register', 'wording', 'jargon'],
    values: [
      'terse and direct',
      'formal, no contractions',
      'casual with no emoji',
      'plain words, no jargon',
      'short, numbers up front',
    ],
    title: s => `Tone for ${capitalize(s)}`,
    description: s => `the register ${capitalize(s)} wants in written output`,
    fact: (s, v) => `Write to ${capitalize(s)} ${v}.`,
    why: () => '',
    lexical: [s => `what tone does ${s} want`, s => `${s} tone and register`],
    paraphrase: [s => `how chatty should I be with ${s}`, s => `what voice fits messages to ${s}`],
  },
  {
    folder: 'user',
    slug: 'indentation',
    topic: ['indent', 'tabs', 'spaces', 'formatting'],
    values: [
      'tabs',
      'two spaces',
      'four spaces',
      'whatever the formatter emits',
      'tabs for indent, spaces for alignment',
    ],
    title: s => `Indentation for ${capitalize(s)}`,
    description: s => `how ${capitalize(s)} indents code`,
    fact: (s, v) => `${capitalize(s)} indents with ${v}; the formatter config is authoritative.`,
    why: () => '',
    lexical: [s => `how does ${s} indent code`, s => `${s} indentation`],
    paraphrase: [
      s => `what whitespace style does ${s} prefer`,
      s => `how are nested blocks offset in files from ${s}`,
    ],
  },
  {
    folder: 'user',
    slug: 'operating-system',
    topic: ['os', 'machine', 'platform', 'desktop'],
    values: ['macos', 'linux', 'windows with wsl', 'fedora', 'nixos', 'freebsd'],
    title: s => `Operating system for ${capitalize(s)}`,
    description: s => `the platform ${capitalize(s)} works on`,
    fact: (s, v) =>
      `${capitalize(s)} is on ${v}; try shell commands on that platform before sending them.`,
    why: () => '',
    lexical: [s => `what operating system does ${s} use`, s => `${s} platform`],
    paraphrase: [
      s => `which kernel is ${s} sitting on`,
      s => `what kind of computer does ${s} run day to day`,
    ],
  },
]

/**
 * Sentences that lengthen a fact note without restating the fact. Kept to a
 * closed vocabulary on purpose: anything added here lands in the gold notes,
 * so a word that also appears in a paraphrase question would break the
 * one-shared-term floor the test enforces.
 */
const CONTEXT = [
  (s: string, t: string, u: string, d: string) =>
    `Context: the ${t} decision for ${s} was taken in ${d} and has not been revisited. ${capitalize(u)} is covered in its own note.`,
  (s: string, t: string, u: string) =>
    `Context: the ${t} setting is mirrored in the ${s} ops repo, which is the copy to edit; the ${u} side is untouched by it.`,
  (s: string, t: string, u: string) =>
    `Context: ${s} inherited this ${t} choice from the previous owner and kept it when the ${u} rework arrived.`,
  (s: string, t: string) =>
    `Context: a ${t} exception for ${s} exists for the staging tier only and is listed in the ops repo.`,
  (s: string, t: string, u: string, d: string) =>
    `Context: this ${t} note for ${s} is verified by a nightly job that posts to the channel; the ${u} job of ${d} does the same.`,
  (s: string, t: string, u: string, d: string) =>
    `Context: the ${t} sentence above is quoted from the ${s} decision log of ${d}, which also settles the ${u} question.`,
]

/**
 * Sentences for the long noise notes: topic vocabulary and the subject,
 * repeated, with no fact. This is the audit's failure mode built on purpose:
 * a note like this matches every topic word of a lexical question with a high
 * term frequency and a matching description, and wins over the short note
 * that holds the answer.
 */
const LONG_FRAMES = [
  (s: string, t: string, u: string) =>
    `The ${t} work for ${s} is tracked in the weekly digest under the ${u} heading.`,
  (s: string, t: string, u: string) =>
    `Before touching ${t} on ${s}, go through the ${u} section of the runbook and the last three incident write-ups.`,
  (s: string, t: string, u: string) =>
    `Every ${t} change to ${s} gets a table case with a sample attached, and the ${u} owner signs it.`,
  (s: string, t: string, u: string, d: string) =>
    `${capitalize(s)} ${t} timeline: the first pass in ${d} was redone later, and the ${u} part was never finished.`,
  (s: string, t: string, u: string) =>
    `Open question: whether the ${s} ${t} setup should move closer to the ${u} layer.`,
  (s: string, t: string, u: string, _d: string, n: number) =>
    `A ${t} regression on ${s} is caught by the ${u} smoke run, which takes about ${n} minutes.`,
  (s: string, t: string, u: string, _d: string, n: number) =>
    `The ${u} dashboards for ${s} show ${t} counts per hour; a spike above ${n} is worth a look.`,
  (s: string, t: string) =>
    `When the ${t} step for ${s} fails, re-run it once before paging anyone.`,
  (s: string, t: string, u: string) =>
    `${capitalize(s)} keeps its ${t} notes in this file and its ${u} notes in the one next to it.`,
  (s: string, t: string, u: string) =>
    `Nobody owns ${s} ${t} end to end; ask in the channel before changing the ${u} path.`,
  (s: string, t: string, u: string) =>
    `The ${t} glossary for ${s}: ${u} means the same thing here as in the platform docs.`,
  (s: string, t: string, u: string) =>
    `Checklist for a ${s} ${t} change: announce it, land it behind a flag, watch the ${u} graphs for a day.`,
  (s: string, t: string, u: string, d: string) =>
    `${capitalize(s)} ${t} was discussed again in ${d}; the ${u} question stayed open.`,
  (s: string, t: string, u: string, _d: string, n: number) =>
    `Rough cost of ${t} on ${s}: ${n} units a month, most of it in the ${u} tier.`,
  (s: string, t: string, u: string, d: string) =>
    `A ${t} postmortem for ${s} from ${d} blamed the ${u} path and recommended a rehearsal.`,
  (s: string, t: string, u: string, _d: string, n: number) =>
    `The ${s} ${t} onboarding doc walks a new joiner through the ${u} flow in about ${n} minutes.`,
  (s: string, t: string, u: string) =>
    `Known gap: ${s} ${t} has no ${u} alert yet, so a quiet failure can sit for hours.`,
  (s: string, t: string, u: string) =>
    `${capitalize(s)} ${t} naming: prefix with the team, then the ${u} kind, then a short noun.`,
  (s: string, t: string, u: string) =>
    `The ${t} faq for ${s} explains why the ${u} switch is off by default.`,
  (s: string, t: string, u: string, d: string) =>
    `Two ${t} experiments on ${s} ran in ${d}; neither moved the ${u} number.`,
  (s: string, t: string, u: string, _d: string, n: number) =>
    `If a ${s} ${t} job stalls, the ${u} backlog grows first and the alert fires about ${n} minutes later.`,
  (s: string, t: string, u: string) =>
    `Rule of thumb: ${t} on ${s} costs a day of ${u} review for every week of work.`,
  (s: string, t: string, u: string) =>
    `${capitalize(s)} ${t} vocabulary drifts between teams; this note pins the ${u} meaning.`,
  (s: string, t: string, u: string, d: string, n: number) =>
    `The ${t} retro for ${s} in ${d} listed ${n} follow-ups, mostly about ${u}.`,
]

const LONG_STYLES = [
  'runbook',
  'overview',
  'timeline',
  'checklist',
  'faq',
  'postmortem',
  'notes',
  'retro',
]

/** Topics of the short generic noise notes; none is a template topic word. */
const FILLER_TOPICS = [
  'cache',
  'parser',
  'scheduler',
  'allocator',
  'logger',
  'tracer',
  'codec',
  'compressor',
  'serializer',
  'validator',
  'sandbox',
  'shard',
  'replica',
  'cursor',
  'buffer',
  'handshake',
  'backoff',
  'heartbeat',
  'quorum',
  'ledger',
  'manifest',
  'checksum',
  'resolver',
  'dispatcher',
]

const FILLER_ADJECTIVES = [
  'lazy',
  'eager',
  'warm',
  'cold',
  'sticky',
  'shared',
  'nested',
  'legacy',
  'inline',
  'remote',
  'local',
  'paged',
  'sparse',
  'dense',
  'pinned',
  'rolling',
]

const FILLER_FRAMES = [
  (t: string, u: string, n: number) =>
    `The ${t} keeps ${n} ${u} slots warm and evicts the coldest one under pressure.`,
  (t: string, u: string, n: number, d: string) =>
    `A ${t} rewrite in ${d} cut the ${u} overhead by about ${n} percent.`,
  (t: string, u: string, n: number) =>
    `${capitalize(t)} failures surface as a ${u} warning first; the hard error comes ${n} seconds later.`,
  (t: string, u: string, n: number) =>
    `Tuning: the ${t} window defaults to ${n}; raising it helps the ${u} and costs memory.`,
  (t: string, u: string) =>
    `The ${t} and the ${u} share one lock, which is why they cannot be reloaded separately.`,
  (t: string, u: string, n: number) =>
    `Each ${t} instance owns at most ${n} ${u} handles; the pool refuses the next one.`,
  (t: string, u: string) =>
    `Restarting the ${t} drops the ${u} state, so drain it first on a planned restart.`,
  (t: string, u: string, n: number, d: string) =>
    `Since ${d} the ${t} emits a ${u} metric every ${n} seconds for the capacity model.`,
  (t: string, u: string) => `The ${t} is single-threaded on purpose; the ${u} fans out instead.`,
  (t: string, u: string, n: number) =>
    `A ${u} larger than ${n} entries makes the ${t} fall back to the slow path.`,
]

const FILLER_WHY = [
  (t: string) => `Why: the ${t} is the part nobody wants to debug at night.`,
  (t: string, u: string) => `Why: a wrong ${t} default once hid a ${u} leak for a month.`,
  (t: string) => `Why: the ${t} behaviour is easy to forget and hard to rediscover.`,
]

/**
 * Topics no note covers. The unanswerable questions each name one of these
 * next to ordinary corpus words (a subject, a topic word), so a lexical ranker
 * sees plenty to match on and has to decline anyway. The test verifies that
 * none of these terms appears in any generated note.
 */
export const UNCOVERED_TERMS = [
  'backups',
  'payroll',
  'vacation',
  'headcount',
  'pager',
  'licence',
  'budget',
  'dns',
  'firewall',
  'invoice',
  'podcast',
  'badge',
  'catering',
  'offsite',
  'sponsor',
  'trademark',
  'webinar',
  'printer',
  'visa',
  'insurance',
  'lunch',
  'mascot',
  'newsletter',
  'recruiting',
  'warranty',
]

const UNANSWERABLE_FRAMES = [
  (s: string) => `where are the ${s} backups kept`,
  (s: string) => `who signs the ${s} payroll run`,
  (s: string) => `does the ${s} vacation calendar live in the ops repo`,
  (s: string) => `what is the headcount plan for the ${s} team`,
  (s: string) => `who is on the pager rotation for ${s} this week`,
  (s: string) => `what licence does the ${s} source ship under`,
  (s: string) => `what budget was approved for the ${s} cluster this quarter`,
  (s: string) => `which dns provider serves the ${s} zone`,
  (s: string) => `is there a firewall in front of ${s} in the staging region`,
  (s: string) => `how do I get a ${s} invoice reissued`,
  (s: string) => `what is the podcast schedule for the ${s} team`,
  (s: string) => `what badge do I need to enter the ${s} server room`,
  (s: string) => `who pays the catering for the ${s} on-site days`,
  (s: string) => `where is the ${s} offsite this year`,
  (s: string) => `which sponsor covers the ${s} conference booth`,
  (s: string) => `who approves a trademark use for ${s}`,
  (s: string) => `when is the next ${s} webinar and who hosts it`,
  (s: string) => `which printer is near the ${s} desk`,
  (s: string) => `which visa cases does the ${s} team handle`,
  (s: string) => `is there insurance on the ${s} hardware`,
  (s: string) => `what is for lunch at the ${s} release party`,
  (s: string) => `does ${s} have a mascot`,
  (s: string) => `which newsletter announces ${s} releases`,
  (s: string) => `where do I file a recruiting request for the ${s} team`,
  (s: string) => `is ${s} covered by the warranty on the hetzner boxes`,
]

/* ----------------------------------------------------------------------- *
 * Note assembly.
 * ----------------------------------------------------------------------- */

function frontmatter(name: string, description: string, type: Folder, updated?: string): string {
  const lines = ['---', `name: ${name}`, `description: ${description}`, `type: ${type}`]
  if (updated !== undefined) lines.push(`updated: ${updated}`)
  lines.push('---')
  return lines.join('\n')
}

function date(rng: Rng, year: number): string {
  return `${year}-${pad2(1 + below(rng, 12))}-${pad2(1 + below(rng, 28))}`
}

/** `topic` minus one word, so a frame's second slot never repeats its first. */
function otherTopic(rng: Rng, topic: readonly string[], t: string): string {
  const rest = topic.filter(w => w !== t)
  return pick(rng, rest)
}

type Note = {
  key: string
  name: string
  description: string
  content: string
}

function factNote(
  rng: Rng,
  tpl: Template,
  subject: string,
  value: string,
  keySuffix: string,
  lead: string,
  updated?: string,
): Note {
  const name = `${tpl.slug}-${subject}${keySuffix}`
  const key = `${tpl.folder}/${name}.md`
  const description = tpl.description(subject)
  const lines = [frontmatter(name, description, tpl.folder, updated), `# ${tpl.title(subject)}`]
  lines.push(`${lead}${tpl.fact(subject, value)}`)
  // Length spread: most facts stay tiny, a few carry context and get long.
  const roll = rng()
  const extra = roll < 0.6 ? 0 : roll < 0.85 ? 1 + below(rng, 2) : 3 + below(rng, 4)
  if (extra > 0) {
    lines.push('')
    for (let i = 0; i < extra; i++) {
      const t = pick(rng, tpl.topic)
      lines.push(
        CONTEXT[below(rng, CONTEXT.length)](
          subject,
          t,
          otherTopic(rng, tpl.topic, t),
          date(rng, 2025),
        ),
      )
    }
  }
  const why = tpl.why(subject)
  if (why) lines.push('', `Why: ${why}`)
  const content = lines.join('\n')
  return { key, name, description, content }
}

function longNoise(rng: Rng, tpl: Template, subject: string): Note {
  const style = pick(rng, LONG_STYLES)
  const t = pick(rng, tpl.topic)
  const name = `${subject}-${t}-${style}`
  const key = `${tpl.folder}/${name}.md`
  const description = `${style} for ${t} on ${subject}`
  const lines = [
    frontmatter(name, description, tpl.folder),
    `# ${capitalize(subject)} ${t} ${style}`,
  ]
  const sentences = 9 + below(rng, 8)
  for (let i = 0; i < sentences; i++) {
    if (i > 0 && i % 3 === 0) lines.push('')
    const word = pick(rng, tpl.topic)
    const frame = LONG_FRAMES[below(rng, LONG_FRAMES.length)]
    lines.push(
      frame(subject, word, otherTopic(rng, tpl.topic, word), date(rng, 2025), 5 + below(rng, 40)),
    )
  }
  lines.push('', `Why: the ${t} side of ${subject} is where new joiners get lost.`)
  const content = lines.join('\n')
  return { key, name, description, content }
}

function shortNoise(rng: Rng, folder: Folder): Note {
  const t = pick(rng, FILLER_TOPICS)
  const u = otherTopic(rng, FILLER_TOPICS, t)
  const adjective = pick(rng, FILLER_ADJECTIVES)
  const name = `${adjective}-${t}-${u}`
  const key = `${folder}/${name}.md`
  const description = `the ${adjective} ${t} and its ${u}`
  const lines = [frontmatter(name, description, folder), `# ${capitalize(adjective)} ${t}`]
  const sentences = 1 + below(rng, 2)
  for (let i = 0; i < sentences; i++) {
    const frame = FILLER_FRAMES[below(rng, FILLER_FRAMES.length)]
    lines.push(frame(t, u, 2 + below(rng, 60), date(rng, 2025)))
  }
  if (rng() < 0.5) lines.push('', FILLER_WHY[below(rng, FILLER_WHY.length)](t, u))
  const content = lines.join('\n')
  return { key, name, description, content }
}

const FOLDERS: Folder[] = ['user', 'feedback', 'project', 'reference']

/**
 * Generate the corpus and the questions for `seed` at `size` entries. The
 * entry count is exact: `size - 1` ranked notes plus `MEMORY.md`.
 */
export function fixture(seed: number, size: FixtureSize): Fixture {
  const rng = mulberry32(seed)
  const notes: Note[] = []
  const taken = new Set<string>()
  const add = (note: Note) => {
    // Generated names can collide (two short notes drawing the same words);
    // a numbered key keeps the entry count exact instead of silently merging.
    let key = note.key
    for (let n = 2; taken.has(key); n++) key = note.key.replace(/\.md$/, `-${n}.md`)
    taken.add(key)
    notes.push({ ...note, key })
    return key
  }

  // ---- facts ------------------------------------------------------------
  // One fact per (template, subject) pair, drawn without replacement from the
  // full cross product, so two facts never share both a topic and a subject.
  const pairs: [number, number][] = []
  for (let t = 0; t < TEMPLATES.length; t++)
    for (let s = 0; s < SERVICES.length; s++) pairs.push([t, s])
  const order = permutation(rng, pairs.length)

  type Fact = { tpl: Template; subject: string; key: string; superseded?: string }
  const facts: Fact[] = []
  for (let i = 0; i < FACT_COUNT; i++) {
    const [ti, si] = pairs[order[i]]
    const tpl = TEMPLATES[ti]
    const subject = tpl.folder === 'user' ? PEOPLE[si] : SERVICES[si]
    const value = pick(rng, tpl.values)
    if (i < UPDATE_COUNT) {
      let older = pick(rng, tpl.values)
      while (older === value) older = pick(rng, tpl.values)
      const oldDate = date(rng, 2025)
      const newDate = date(rng, 2026)
      // Two realistic memdir states, chosen per pair: the newer note was
      // added beside the old one under a dated key, or the old note was
      // archived under a dated key and the newer one took the plain name.
      // Which key sorts first is therefore a coin flip, and a recency-blind
      // ranker that ties the two wins half of them by key order.
      const datedIsNewer = rng() < 0.5
      const stamp = `-${(datedIsNewer ? newDate : oldDate).slice(0, 7)}`
      const oldKey = add(
        factNote(
          rng,
          tpl,
          subject,
          older,
          datedIsNewer ? '' : stamp,
          `Dated ${oldDate}. `,
          oldDate,
        ),
      )
      const newKey = add(
        factNote(
          rng,
          tpl,
          subject,
          value,
          datedIsNewer ? stamp : '',
          `Updated ${newDate}; replaces the earlier note. `,
          newDate,
        ),
      )
      facts.push({ tpl, subject, key: newKey, superseded: oldKey })
    } else {
      facts.push({ tpl, subject, key: add(factNote(rng, tpl, subject, value, '', '')) })
    }
  }

  // ---- questions --------------------------------------------------------
  const questions: Question[] = []
  for (let i = 0; i < FACT_COUNT; i++) {
    const f = facts[i]
    const lex = f.tpl.lexical[below(rng, f.tpl.lexical.length)](f.subject)
    if (i < UPDATE_COUNT) {
      questions.push({ id: '', query: lex, gold: f.key, kind: 'update', superseded: f.superseded })
    } else if (i < UPDATE_COUNT + QUESTIONED_COUNT) {
      questions.push({ id: '', query: lex, gold: f.key, kind: 'lexical' })
      const para = f.tpl.paraphrase[below(rng, f.tpl.paraphrase.length)](f.subject)
      questions.push({ id: '', query: para, gold: f.key, kind: 'paraphrase' })
    }
  }
  for (const frame of UNANSWERABLE_FRAMES) {
    const subject = rng() < 0.7 ? pick(rng, SERVICES) : pick(rng, PEOPLE)
    questions.push({ id: '', query: frame(subject), gold: null, kind: 'unanswerable' })
  }
  // Shuffled so that any prefix or stride of the list mixes the kinds, then
  // numbered in that order.
  const qOrder = permutation(rng, questions.length)
  const shuffled = qOrder.map(i => questions[i])
  const width = String(shuffled.length).length
  for (let i = 0; i < shuffled.length; i++) {
    let id = String(i + 1)
    while (id.length < width) id = `0${id}`
    shuffled[i].id = `q${id}`
  }

  // ---- noise ------------------------------------------------------------
  const longCount = size / 10
  for (let i = 0; i < longCount; i++) {
    const tpl = TEMPLATES[below(rng, TEMPLATES.length)]
    const subject = tpl.folder === 'user' ? pick(rng, PEOPLE) : pick(rng, SERVICES)
    add(longNoise(rng, tpl, subject))
  }
  const shortCount = size - 1 - notes.length
  for (let i = 0; i < shortCount; i++) add(shortNoise(rng, FOLDERS[below(rng, FOLDERS.length)]))

  // ---- index ------------------------------------------------------------
  const corpus: Record<string, string> = {}
  corpus['MEMORY.md'] = [
    '# index',
    ...notes.map(n => `- [${n.name}](${n.key}): ${n.description}`),
  ].join('\n')
  for (const n of notes) corpus[n.key] = n.content
  return { corpus, questions: shuffled }
}
