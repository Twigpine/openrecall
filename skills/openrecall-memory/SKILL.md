---
name: openrecall-memory
description: Long-term memory shared across projects, sessions, and agents (OpenRecall MCP tools). Use at the START of every task to recall what you know about this user and project, and WHENEVER you learn a durable fact to save it. Tools: memory_project, memory_projects, memory_recall, memory_save, memory_search, memory_get, memory_list, memory_delete. End-to-end encrypted — the server cannot read it.
---

# OpenRecall memory

You have long-term memory that persists across sessions through the OpenRecall
MCP tools. Without it you start every session amnesiac; with it you remember the
user, their projects, their preferences, and how they've asked you to work. Use
it deliberately.

It is **shared**: the same memory is available to every agent the user has
connected (Claude Code, Zero, OpenClaude, Codex, Cursor, …), so what you save
here, the next agent can recall — and vice versa.

It is **end-to-end encrypted**: plaintext is encrypted on this machine before it
is stored, so the OpenRecall store holds only ciphertext and cannot read what you
save. A client-side scanner also blocks anything that looks like a live secret —
but don't rely on it; never save credentials, tokens, or keys on purpose.

## Recall first

For a project task, establish its scope before recalling:

1. Call `memory_projects` to find the project's existing ID. Reuse it rather
   than creating an alias. For a new repository, use `host/owner/repo`, for
   example `github.com/twigpine/openrecall`. IDs are case-insensitive; never
   use an absolute local path, credentials, branch name, or a bare repository
   name shared by different owners. For a non-repository project, agree on a
   stable ID with the user.
2. Call `memory_project(project)` to register or reopen it. This returns a
   **project namespace** and the **shared namespace**. The encrypted directory
   makes the same scope discoverable on other agents and machines using the
   same store, passphrase, and configured shared namespace.
3. Call `memory_recall(query, namespaces: [shared, project])`. It ranks both
   scopes together within one result limit and size cap. Each hit names its
   namespace; include that namespace in follow-up `memory_get` calls. Other
   projects are searched only when you explicitly include their namespaces.

Opening a project **does not change tool defaults**. Pass the namespace
explicitly when saving, listing, searching, reading, or deleting. Store project
decisions, architecture, references, and project-specific feedback in the
project namespace. Keep user preferences and feedback that applies everywhere
in the shared namespace. Before comparing projects, discover their scopes with
`memory_projects` and include only the requested projects in `namespaces`.

Existing entries stay in their original namespace. Continue recalling the
shared namespace to find them; move a fact deliberately by reading it, saving
it in the correct project scope, verifying that save, and only then deleting
the old copy. Never bulk-move or delete existing memory just to adopt scopes.

At the start of a task — before asking the user something they may have already
told you — recall:

1. Call `memory_recall` with a natural-language description of the task
   ("how this user likes PRs", "the deploy setup for this project").
2. Skim what comes back and let it inform your approach. Don't announce that you
   read memory; just act on it.
3. If recall returns nothing relevant, do not conclude the fact was never
   saved. See "When recall finds nothing" below.

`memory_search` is for literal lookups (an exact name, path, or term);
`memory_recall` is for relevance-ranked "what do I know about X".

### When recall finds nothing

A miss says which namespace was searched, how many entries were considered, and
how many scored below the relevance floor. Those below-floor entries are
withheld on purpose: a weak match dressed up as an answer is worse than none.
The count is there so you can tell "the namespace is empty" from "nothing
matched your wording", which is a different problem with a different fix.

An empty namespace says so directly (`no memory stored in ... yet`); there is
nothing to look for, so proceed and save what you learn.

When entries were searched and none cleared the floor:

1. Call `memory_list` to see the keys that exist. The fact may be filed under
   wording your query never used.
2. If a key looks plausible, read it with `memory_get`; if you have an exact
   term, path, or name, try `memory_search` for the literal string.
3. Only after both come back empty treat the fact as unrecorded and save it.
   Saving a second copy under a new key leaves two entries that disagree later,
   and nothing reconciles them for you.

## Save what's durable

Save a fact when it is **stable and reusable across sessions**. Save eagerly but
selectively — signal, not transcript.

**Do save:**
- **user** — who they are, their role, stack, and standing preferences
  ("prefers terse answers", "deploys with Bun, not Node").
- **feedback** — corrections and confirmed ways of working ("always run the
  full test suite before saying done"). Record the *why*, not just the rule.
- **project** — goals, constraints, and decisions not obvious from the code or
  git history (convert relative dates to absolute: "by Q3" → "by 2026-09-30").
- **reference** — pointers to external resources (dashboards, tickets, docs).

**Don't save:**
- transient context (the current file, a one-off question, today's error);
- anything already obvious from the codebase, README, or git history;
- secrets, tokens, passwords, or private keys — ever.

If asked to "remember" something already in the repo, save instead what was
*non-obvious* about it.

## How to call the tools

Depending on the agent, the tools may carry a prefix — e.g.
`mcp__openrecall__memory_recall` or `mcp_openrecall_memory_recall`; they are the
same tools. If your agent shows MCP tools by name only until you look them up
(a tool-search step), search for "openrecall" first.

- `memory_save(key, content)` — `key` is a path that mirrors a memory directory
  layout; `content` is markdown. Saving the same `key` overwrites it.
- `memory_recall(query, limit?)` — relevance-ranked entries for a query.
- `memory_recall(query, namespaces: [shared, project], limit?)` — one ranked,
  bounded result across up to eight explicit namespaces. Use `namespace` or
  `namespaces`, never both.
- `memory_project(project)` — register or reopen a stable project ID and get
  its project and shared namespaces. The directory is encrypted; the project
  name is not put in its namespace or entry key.
- `memory_projects(limit?, offset?)` — discover registered project IDs and
  namespaces without reading their memory contents. The default page is 20
  projects; follow the returned offset to see more.
- `memory_search(query)` — literal substring/keyword search.
- `memory_get(key)` — the full, untruncated body of one entry. Use it when
  recall or search surfaces an entry you need to read in full.
- `memory_list()` — list entry keys without downloading content.
- `memory_delete(key)` — remove an entry that's wrong or stale.

### Entry-key conventions

Keep a flat, predictable layout:

- `MEMORY.md` — a short index: one line per memory with a link and a hook.
- `user/*.md`, `feedback/*.md`, `project/*.md`, `reference/*.md` — one fact per
  file, named in kebab-case (`feedback/run-tests-before-done.md`).

`memory_recall` never returns `MEMORY.md`. An index is a list of pointers, so it
matches a bit of every query and answers none of them, and returning it would
spend a recall slot that a real entry should have had. Keep it anyway: it is the
table of contents you read deliberately with `memory_get('MEMORY.md')`, or
alongside `memory_list`, when you are orienting in an unfamiliar namespace or
following up a recall that found nothing.

In each saved file, prefer a tiny shape:

```markdown
# <title>
<the fact in a sentence or two>

Why: <why it matters — for feedback/project>
```

## Maintain the memory, don't just append

- **Check before adding.** `memory_search` for an existing file on the topic and
  update it rather than creating a near-duplicate.
- **Keep `MEMORY.md` current.** When you add a fact, add its one-line pointer to
  the index; when you delete one, remove the line.
- **Correct and prune.** If a fact turns out to be wrong or outdated, fix or
  `memory_delete` it. Stale memory is worse than none.
- **Trust but verify.** A recalled fact reflects what was true when it was
  written. If it names a file, flag, or decision, confirm it still holds before
  acting on it.

## Namespaces (when scoping matters)

The six memory read/write tools optionally take a `namespace`; it defaults to
the one this MCP server is configured with (typically `user:<you>`). The project
tools use that configured namespace as the shared root. Use the namespace
returned by `memory_project` consistently across agents; do not invent a new
scope for every task or branch.
