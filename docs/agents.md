# Connecting agents to OpenRecall

Every agent you connect shares **one encrypted memory**. What Claude Code saves,
Zero and OpenClaude can recall, and the reverse.

Each agent registers the same command, and that command contains no secrets.
Your passphrase lives in one place, `~/.openrecall/config.json`, which is
readable only by you.

## Quick setup

```bash
npm i -g @twigpine/openrecall   # or prefix each command with: npx -y @twigpine/openrecall
openrecall init                 # creates ~/.openrecall/config.json with a fresh passphrase
openrecall setup                # lists the agents found on this machine
openrecall setup all            # dry run: prints exactly what would change
openrecall setup all --write    # applies it
```

Restart each agent, or start a new session, afterwards.

**Details:**
- **Rerunning is safe.** `setup` replaces its own `openrecall` entry and leaves
  everything else alone.
- **Backups.** Any JSON config it edits is backed up next to the original as
  `*.openrecall-bak`.
- **Pick agents by name** instead of `all`:
  `openrecall setup claude-code zero --write`.
- **Global install vs npx.** With a global install, `setup` registers absolute
  paths. These start fast, work offline, and work in GUI apps with a minimal
  `PATH`. If you run `setup` through `npx`, it registers the portable
  `npx -y @twigpine/openrecall mcp` instead. `--npx` forces the portable form.

`openrecall status` shows the active config and checks that the store
responds.

## Project memory and shared preferences

The agent starts a project task with `memory_projects` to find its existing ID,
then `memory_project` to register or reopen it. Use a stable repository identity
such as `github.com/twigpine/openrecall`, including host and owner. Avoid local
paths and branch names, which vary across machines and sessions.

The project tool returns two namespaces. Save project decisions, architecture,
and references in the project namespace; save user preferences and feedback
that applies everywhere in the shared namespace. `memory_recall` can take both
as `namespaces: [shared, project]`, producing one ranked, bounded answer with
the namespace attached to each hit. Follow-up reads and all writes should pass
their namespace explicitly. Opening a project does not change defaults.

The directory is encrypted and paginated (`limit` defaults to 20, maximum 50;
`offset` selects the next page). Other agents see it through the same store and
passphrase. Local stores on different machines remain separate until synced
to the same remote store. Existing entries are left in their original scopes.

## What `setup` does for each agent

| Agent | Registers the MCP server | Teaches the memory discipline |
|---|---|---|
| Claude Code | `claude mcp add --scope user` | skill in `~/.claude/skills`, plus MCP instructions |
| Zero | `zero mcp add` | skill in `~/.agents/skills` |
| OpenClaude | `openclaude mcp add -s user` | skill in `~/.agents/skills`, plus MCP instructions |
| Codex | `codex mcp add` | skill in `~/.codex/skills` |
| Cursor | `~/.cursor/mcp.json` | MCP instructions and the `memory_guide` prompt |
| Gemini CLI | `~/.gemini/settings.json` | MCP instructions |
| opencode | `~/.config/opencode/opencode.json` (`mcp`, `type: local`) | MCP instructions |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | MCP instructions |
| Claude Desktop | `claude_desktop_config.json` | MCP instructions |
| VS Code | prints a `.vscode/mcp.json` block for your workspace | MCP instructions |

**Any other MCP client:** register a stdio server that runs
`npx -y @twigpine/openrecall mcp`, or `openrecall mcp` after a global install.
It needs no environment variables.

## Claude Code and OpenClaude plugin

Instead of `setup`, you can install OpenRecall as a plugin. The plugin bundles
the MCP server and the memory skill.

```text
# Claude Code 2.1.275+
/plugin install openrecall --marketplace Twigpine/openrecall

# Older Claude Code, or OpenClaude
/plugin marketplace add Twigpine/openrecall
/plugin install openrecall@openrecall
```

From a shell, OpenClaude uses
`openclaude plugin marketplace add Twigpine/openrecall`, then
`openclaude plugin install openrecall@openrecall`.

**Use the plugin or `setup` for a given agent, not both.** Using both
registers two copies of the same tools.

You still need to run `openrecall init` once, since that is where the
passphrase lives.

## Zero

Zero is the strictest client, so it needs a few extra steps. `setup` handles
the first two.

- **Instructions come from the skill.** Zero doesn't pass MCP server
  instructions or prompts to the model. The `openrecall-memory` skill in
  `~/.agents/skills` provides the guidance instead.
- **Sandbox write access.** Zero runs MCP servers inside its sandbox, which
  only allows writes to the workspace. For local mode, `setup` adds your
  OpenRecall home (`~/.openrecall`) to `sandbox.additionalWriteRoots` in
  `~/.config/zero/config.json`. That grant covers only OpenRecall's own
  directory.
- **Network is denied in the sandbox.** Two things follow:
  - Install OpenRecall globally, so Zero launches it from an absolute path
    instead of downloading it with `npx`. A download would also risk Zero's
    8-second MCP connect timeout.
  - A **remote** store additionally needs `"sandbox": {"network": "allow"}` in
    your Zero config. `setup` points this out but never changes it for you.
- **Use Ask mode.** Zero hides tools that need approval in Auto mode, and
  every MCP tool needs approval. Approve the memory tools when Zero asks.
- **Tool names.** Tools appear as `mcp_openrecall_memory_recall` and so on.
  Zero lists MCP tools by name only until the model looks them up with
  `tool_search`. The skill tells the model to do that.

## Sharing memory across machines

Local mode (`url: "local"`, the default) keeps memory on one machine. To share
it between machines, point every machine at the same server and use the same
passphrase:

```bash
openrecall init --url https://memory.twigpine.com --api-key mk_live_…
# copy "passphrase" from the first machine's ~/.openrecall/config.json
```

Switching an existing install from local to remote doesn't move your memory
automatically:

1. Run `openrecall pull ./backup` while still in local mode.
2. Switch to the remote URL with `openrecall init --url …`.
3. Run `openrecall push ./backup`.

## Keeping a memory directory mirrored

Some agents read memory files rather than call MCP tools. `openrecall sync`
mirrors a directory and a namespace in both directions, so edits made in the
file and saves made through the tools converge instead of overwriting each
other:

```bash
openrecall sync ~/memories                 # one round trip
openrecall sync ~/memories --watch         # keep mirroring
openrecall sync ~/memories --prune --watch # also propagate local deletions
```

Per entry the newest write wins, decided by the server's per-entry write times
against the file's mtime; unchanged entries transfer nothing. `--prune` only
deletes an entry when a previous sync of the same directory saw its file, so
another agent's saves are downloaded, never destroyed. See
[README](../README.md#mirror-a-memory-directory) for the full contract.

## Troubleshooting

| Symptom | Fix |
|---|---|
| A tool returns "OpenRecall is not set up" | Run `openrecall init`, then restart the agent. |
| The agent can't start `npx` (GUI apps) | Run `npm i -g @twigpine/openrecall`, then `openrecall setup <agent> --write`. |
| Zero says "MCP server openrecall unavailable, skipped" | Install globally and rerun setup; see [Zero](#zero). |
| The memory tools don't appear in Zero | Switch from Auto mode to Ask mode. |
| You want to check which config is active | `openrecall status`. Environment variables (`OPENRECALL_*`) override the file. |
