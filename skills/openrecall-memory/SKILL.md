---
name: openrecall-memory
description: Long-term memory shared across sessions and agents (OpenRecall MCP tools). Use at the START of every task to recall what you know about this user and project, and WHENEVER you learn a durable fact (a preference, decision, convention, or feedback) to save it. Tools: memory_recall, memory_save, memory_search, memory_list, memory_delete. End-to-end encrypted — the server cannot read it.
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

At the start of a task — before asking the user something they may have already
told you — recall:

1. Call `memory_recall` with a natural-language description of the task
   ("how this user likes PRs", "the deploy setup for this project").
2. Skim what comes back and let it inform your approach. Don't announce that you
   read memory; just act on it.
3. If recall returns nothing relevant, proceed normally — and watch for facts
   worth saving as you go.

`memory_search` is for literal lookups (an exact name, path, or term);
`memory_recall` is for relevance-ranked "what do I know about X".

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
- `memory_search(query)` — literal substring/keyword search.
- `memory_list()` — list entry keys without downloading content.
- `memory_delete(key)` — remove an entry that's wrong or stale.

### Entry-key conventions

Keep a flat, predictable layout:

- `MEMORY.md` — a short index: one line per memory with a link and a hook.
- `user/*.md`, `feedback/*.md`, `project/*.md`, `reference/*.md` — one fact per
  file, named in kebab-case (`feedback/run-tests-before-done.md`).

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

Each tool optionally takes a `namespace`; it defaults to the one this MCP server
is configured with (typically `user:<you>`). Use a different namespace only to
separate distinct scopes — e.g. a per-project space (`user:<you>/acme`) — and be
consistent so recall later finds it.
