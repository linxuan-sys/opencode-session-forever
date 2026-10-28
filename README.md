# Sessions Forever

> Have you ever been frustrated because a conversation context could not be
> passed between friends?
> Have you ever cried because you could not find an important context again?
> Have you ever suffered because a context could only ever exist as a single
> instance?

**Today, this plugin is here — built specifically to solve this problem.**

Sessions Forever exports a single conversation into one file that you can pass
around freely. One archive can be opened as multiple instances, it can live
right inside your project, and it never pollutes the main database.
**OpenCode v2 only.**

Concretely: save any [OpenCode](https://opencode.ai) conversation as a single
portable `.sf` file — and restore it later, or on another machine, as a real
native session that opens in its own tab with the complete history intact.

## Why

OpenCode v2 stores **every** conversation of **every** project in one global
SQLite database (`~/.local/share/opencode/opencode.db`). Over time this creates
three problems:

- Old conversations get buried under newer ones and are hard to find.
- There is no per-conversation artifact you can keep, move, or back up.
- Sharing the full context of a conversation with someone else is practically
  impossible.

Sessions Forever gives every conversation you care about a **single
self-contained file** with the `.sf` extension. Copy it anywhere, send it to
anyone, and load it back as a first-class OpenCode session whenever you want.

## What is a `.sf` file?

A `.sf` file is a **genuine OpenCode database** — a standard SQLite file
containing exactly one session, written by OpenCode's own storage engine (not
by third-party code). You can open it with any SQLite tool and inspect the
`session_v2`, `session_message`, and `project` tables.

The custom `.sf` extension keeps archives instantly recognizable and prevents
unrelated `.db`/`.sqlite` files from interfering.

The archive contains the **complete projected transcript**: every user and
assistant message, code blocks, tool calls and their outputs, reasoning blocks,
token/cost statistics, and timestamps — byte-identical to what OpenCode itself
stores.

## Features

- **`/session-save [name]`** — archive the current conversation into
  `<session directory>/<name>.sf` (default name: `<title>-<YYYYMMDD-HHMM>.sf`).
- **`/session-load [index | filename]`** — scan the current directory for
  `*.sf` archives and show a native picker dialog (title, message count, date).
  An argument skips the dialog.
- **Native restore** — the selected archive is rebuilt as a real session in
  your live OpenCode and **opens automatically in a new tab**, exactly like
  picking a conversation from `/session`. You can keep chatting in it.
- **Portable** — archives work on any machine with OpenCode v2 and this
  plugin. Re-importing the same archive twice (or on the original machine)
  never conflicts: ids are regenerated on every load.
- **Full fidelity** — restore round-trips have been verified byte-identical.
- **Zero dependencies** — uses only OpenCode built-ins (`bun:sqlite`,
  `node:child_process`) and official OpenCode mechanisms. Nothing to install.
- **Safe** — the live database is never touched directly; every write goes
  through OpenCode's own import path (foreign keys, uniqueness constraints,
  and cross-version migrations are all handled by official code). No model
  calls are made, so saving/loading costs no tokens.

## How it works

Everything is built from official mechanisms — the plugin never writes SQL to
your live database.

### Save

```
current session (router.current)
  → client.session.export                    official transcript projection {info, messages}
  → temp JSON file
  → XDG_DATA_HOME=<tmp> opencode session import --standalone <json> --directory <dir>
      (a disposable official instance builds a fresh database from scratch
       and writes only this conversation into it)
  → WAL checkpoint guard (data-loss protection on abnormal exit)
  → the resulting opencode.db is moved to <name>.sf
```

Key details:

- `XDG_DATA_HOME` redirection + `--standalone` = "the official automatic save,
  triggered manually, at a path you choose". The disposable instance never
  connects to your running service.
- The CLI reads/writes transcripts through **files and pipes**, so there is no
  argument-size limit — archives of any size work.

### Load

```
scan *.sf in the current directory
  → fast read-only SQLite peek for labels (id/title/count), file name as fallback
  → native select dialog (or direct argument: index / file name)
  → copy the .sf into a disposable instance's data dir
  → opencode session export --standalone <id>   (official projection reads it back;
      old archives are auto-migrated by the disposable instance on startup)
  → regenerate session + message ids (UNIQUE constraints are global) and
      replace cross-references; drop parentID/fork links
  → client.session.import into the live service   (official code does the writing)
  → router.navigate → the restored session opens in a new tab
```

## Installation

From npm (recommended):

```
opencode plugin add opencode-sessions-forever
```

Or drop this folder into either location manually, then restart OpenCode
(or run `opencode service restart`):

```
~/.config/opencode/plugins/sessions-forever/     # global (all projects)
<project>/.opencode/plugins/sessions-forever/    # per-project
```

The package contains:

| File       | Role                                                              |
| ---------- | ----------------------------------------------------------------- |
| `index.ts` | Server-side stub so the server loads the package (TUI part follows) |
| `tui.ts`   | All logic: slash commands, dialogs, archives, restore              |

## Usage

```
/session-save                  # archive as <title>-<timestamp>.sf in the session directory
/session-save release-plan     # archive as release-plan.sf

/session-load                  # picker dialog listing all *.sf in the current directory
/session-load 2                # load the 2nd archive from the list
/session-load release-plan     # load release-plan.sf (extension optional)
```

Both commands are also available in the command palette.

## Requirements

- OpenCode **v2** with the terminal UI (developed and tested against **2.1.3**).
- The `opencode` executable (the plugin reuses the running binary via
  `process.execPath`).

## Notes & limitations

- Each save/load spawns a disposable OpenCode instance: expect **1–3 seconds**
  per operation. This is the price of 100% official writes.
- The quick label peek reads `session_v2`/`session_message` directly. If a
  future OpenCode version renames those tables, the plugin degrades gracefully
  (file-name labels + official `session list` fallback for the id).
- Archives are written to the **session's project directory**.
- Scratch directories are created under the system temp dir
  (`sessions-forever-*`) and removed automatically after each operation.
- **Privacy:** a `.sf` contains the entire transcript, including reasoning
  blocks and tool outputs (file contents, command results). Review an archive
  before sharing it.

## License

MIT — see [LICENSE](./LICENSE).
