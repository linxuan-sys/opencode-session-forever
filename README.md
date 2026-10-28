# Sessions Forever

Keep your OpenCode conversations in libraries you own, and switch between them
without restarting. **OpenCode v2 only.**

- `/session-save` — write the current conversation into a `.sf` library, or
  export it as a plain `.json` transcript.
- `/session-load` — switch the live database over to a `.sf` library, or import
  a `.json` transcript into the database you are using.
- `/session-main` — switch back to the conversations you had before opening a
  library.

## Why

OpenCode v2 stores every conversation of every project in one global SQLite
database (`~/.local/share/opencode/opencode.db`). That creates three problems:

- Old conversations get buried under newer ones and are hard to find.
- There is no per-conversation artifact you can keep, move, or back up.
- One bad migration or a filled disk takes everything with it.

Sessions Forever lets you split that collection into separate libraries, keep
them anywhere — including inside a project — and jump between them at will.

## Installation

### From npm

```sh
opencode plugin add opencode-sessions-forever
```

### With npm directly

```sh
npm install -g opencode-sessions-forever
```

or, if you prefer it scoped to the current project:

```sh
npm install opencode-sessions-forever
```

OpenCode discovers globally installed packages automatically. If you installed
into a project, add the package name to the `plugins` array in that project's
`opencode.json`:

```json
{
  "plugins": ["opencode-sessions-forever"]
}
```

### Manually

Drop this folder into either location, then restart the service:

```
~/.config/opencode/plugins/sessions-forever/     # global, all projects
<project>/.opencode/plugins/sessions-forever/    # per project
```

### Restart after installing

Configuration and plugins are read when the background service starts, not when
the terminal UI reopens:

```sh
opencode service restart
```

### Files in the package

| File | Role |
| --- | --- |
| `index.ts` | Server-side stub so the server loads the package (the TUI part follows) |
| `tui.ts` | All logic: commands, dialogs, transplant, recovery |
| `README.md` | This document |
| `LICENSE` | MIT |

## What a `.sf` file is

A `.sf` file is a **complete OpenCode database** with the same schema as the
live one — not an export format. It just happens to hold conversations only.

You can open it with any SQLite tool and inspect `session_v2`,
`session_message`, `project`, and the rest. The custom extension keeps libraries
recognizable and stops unrelated `.db`/`.sqlite` files from appearing in the
picker.

Everything that is **not** a conversation — providers, credentials, permissions,
instructions, `kv` — stays in your live database and is never touched by a
switch. Your model setup keeps working inside any library.

## Commands

### `/session-save [name]`

Asks for a format, then writes the current conversation.

**Choose `as a .sf library`:**

1. Asks for a library name (default: the conversation title).
2. If the file already exists, shows how many conversations it holds and asks
   before appending.
3. Regenerates session and message ids, then imports through a disposable
   official instance so the result is a genuine OpenCode database.
4. Appends when the library exists, creates it otherwise.

**Choose `as a .json file`:**

1. Asks for a file name (default: the conversation title).
2. Writes `<name>.json` into the session's directory.
3. The JSON is the official transcript projection: `{ info, messages }`.

```
/session-save                  # ask for everything
/session-save release-plan     # pre-fill the name
```

### `/session-load [file]`

Shows every `.sf` library and `.json` transcript in the working directory.

```
← Switch back to the main conversations     # only while a library is open
some-transcript.json                        JSON transcript · imported into the live database
workspace.sf                                3 conversation(s) · latest: ...
```

**Choosing a `.json` file** imports it into the **currently live database**:

1. Every `ses_`, `msg_`, and `prt_` id is regenerated, so importing the same
   file twice produces two independent conversations instead of a conflict.
2. Missing accounting fields (`cost`, `tokens`, `outcome`, `location`,
   `projectID`) are filled in, because the official importer rejects transcripts
   without them. The file on disk is never modified.
3. Runs `opencode session import` and **opens the new conversation in a tab**.

**Choosing a `.sf` library** switches the database over to it:

1. Shows the conversations inside the library. Even a single-conversation
   library shows the list.
2. The first entry is `＋ New conversation` — switch to the library and start a
   fresh conversation inside it.
3. Picking an existing conversation switches and opens that conversation.
4. Before switching away from the main conversations the first time, the current
   set is parked into `main.sf` so `/session-main` can bring it back.

```
/session-load                  # pick from the list
/session-load workspace        # .sf extension optional
/session-load notes.json       # import a JSON transcript
```

### `/session-main`

Switches back to the conversations that were live before a library was opened,
then opens a new conversation tab so you can keep working immediately.

While a library is open:

1. The live conversations are written **back into** the library, so nothing you
   typed is lost.
2. The parked main conversations are transplanted back into the live database.
3. `state.json` is removed; a new conversation tab opens.

```
/session-main
```

All three commands are also available in the command palette.

## How it works

`~/.local/share/opencode/opencode.db` holds two unrelated groups of tables:

| Group | Tables | Touched by a switch? |
| --- | --- | --- |
| Configuration | `credential`, `kv`, `permission`, `instruction_*`, `account*`, … | **no** |
| Conversations | `session_message`, `session_inbox`, `session_pending`, `session_v2`, `project`, `project_directory`, `worktree`, `event` | **yes** |
| Write counters | `event_sequence` | rebuilt, never emptied |

A switch is therefore not a file swap — it is one transaction that replaces the
conversation tables inside the live database. The file stays the same, so the
running service keeps its provider connections, credentials, and settings.

### Save as a library

```
current session (router.current)
  → client.session.export                   official transcript projection
  → regenerate ids (the library may already hold this conversation)
  → XDG_DATA_HOME=<tmp> opencode session import --standalone <json> --directory <dir>
      a disposable official instance builds the database from scratch
  → WAL checkpoint + journal_mode=DELETE    one self-contained file
  → the result replaces or extends <name>.sf
```

An existing library is copied into the disposable instance first, so appending
keeps the conversations already inside it.

### Save as JSON

```
current session
  → client.session.export                   { info, messages }
  → write <name>.json
```

No disposable instance, no temporary database — it is the transcript exactly as
OpenCode projects it.

### Load a library

```
scan *.sf and *.json in the working directory
  → read-only SQLite peek for titles, message counts and dates
  → native picker (or direct argument)
  → if no library is open yet: park the live conversations into main.sf
  → transplant(live ← library)
  → state.json remembers which library is open
  → router.navigate → the conversation opens in a tab
```

`transplant()` is the whole trick, and it is deliberately boring:

```
checkpoint(live)                        merge the WAL into the main file
ATTACH '<library>' AS src
BEGIN IMMEDIATE                         take the write lock
DELETE FROM main.<conversation tables>  empty them
INSERT INTO main.<t> (...) SELECT ... FROM src.<t>
rebuild event_sequence                  see below
COMMIT                                  ROLLBACK on any failure
```

`BEGIN IMMEDIATE` plus `busy_timeout=15000` means a concurrent write from the
service makes the switch wait, not corrupt. If anything fails, the transaction
rolls back and the live database is exactly as it was.

Only columns present on both sides are copied, so libraries written by an older
release still load after an OpenCode upgrade adds columns.

### Why the counters matter

`session_message.seq` is not a global autoincrement — it is a per-conversation
write counter, allocated from `event_sequence(aggregate_id, seq)`. The service
reads that table before every insert; it does not keep the number in memory.

That is what makes switching without a restart possible, and it is also the one
thing a switch must get right:

```sql
INSERT INTO event_sequence (aggregate_id, seq)
SELECT session_id, MAX(seq) FROM session_message GROUP BY session_id
ON CONFLICT(aggregate_id) DO UPDATE SET seq = MAX(event_sequence.seq, excluded.seq)
```

Every counter ends up at least as large as the highest `seq` already in the
table. Emptying that table instead (as 1.0.2 and earlier did) leaves the service
allocating from 1 again, so the very next message hits
`UNIQUE constraint failed: session_message.session_id, session_message.seq` —
HTTP 500 on every send, and switching models fails the same way.

`event` is dropped because it is an incremental-sync log that points at
conversation ids which no longer exist; the TUI re-lists sessions instead.

### Load JSON

```
read <name>.json
  → validate { info, messages }
  → regenerate ses_/msg_/prt_ ids (a Map keeps cross-references intact)
  → fill cost, tokens, outcome, location, projectID when missing
  → drop parentID and fork links
  → opencode session import <tmp> --directory <dir>
  → read the new session id from stdout, navigate to it
```

Because ids are regenerated, the same transcript can be imported any number of
times — one library, many instances.

### Switch back

`/session-main` does two transplants in reverse order:

```
write the live conversations back into the open library   (nothing you typed is lost)
transplant(live ← main.sf)                                restore the main conversations
delete state.json                                          forget the library
open a fresh conversation tab
```

The write-back keeps the library current, so you can leave and return as many
times as you like.

## Where state lives

```
~/.local/share/sessions-forever/
├── main.sf          the conversations that were live before a library was opened
└── state.json       which library is currently open (absent = main conversations)
```

`main.sf` is written once, the first time you leave the main conversations. It is
**the only copy** of them while a library is open, so treat it like a backup.

Files the plugin creates elsewhere:

| Path | Contents |
| --- | --- |
| `<session dir>/<name>.sf` | A library |
| `<session dir>/<name>.json` | An exported transcript |
| `/tmp/sessions-forever-*` | Scratch directories, removed after each operation |

## Recovering if you delete the plugin while a library is open

Deleting the plugin removes the commands, not the data. You end up with:

- the live database holding the **library's** conversations,
- `main.sf` still holding your **original** conversations,
- `state.json` left behind, now meaningless.

`main.sf` is a valid OpenCode database, so restoring it is a plain file swap.
**Stop the service first** — replacing a database file under a running service
is the one thing this plugin avoids.

```sh
opencode service stop

# keep the current state, whatever it is
cp ~/.local/share/opencode/opencode.db ~/.local/share/opencode/opencode.db.library

# stale WAL/SHM must go, or they get replayed over the restored file
rm -f ~/.local/share/opencode/opencode.db-wal ~/.local/share/opencode/opencode.db-shm

cp ~/.local/share/sessions-forever/main.sf ~/.local/share/opencode/opencode.db

opencode service start
```

To go the other way — keep the library and discard the old conversations — do
nothing: the live database already holds them. Copy `opencode.db` somewhere
first if you want to keep that state for later.

Either direction, the SQLite files are self-contained: any `.sf`, `main.sf`, or
`opencode.db` can be opened directly with `sqlite3` and inspected.

## Limitations

These are properties of the design, not bugs:

- **Tabs from another library stop resolving.** A tab remembers a `sessionID`,
  and that id is not in the database while a different library is open. The tab
  works again after switching back. There is no tab API to close or retarget it.
- **Don't switch while a conversation is generating.** `session_inbox` and
  `session_pending` are part of the swap, so an in-flight run loses its queue.
- **Only one library is live at a time.** That is what "swap" means; there is no
  merge.
- Switch operations write to the live database, so keep a backup of
  `opencode.db` if your data matters. This is not an official OpenCode API.
- **Privacy:** a `.sf` or `.json` contains the entire transcript including
  reasoning blocks and tool output (file contents, command results). Review one
  before sharing it.
- `.json` files in the working directory are all listed. A JSON file that is not
  a transcript (no `info` and `messages`) is rejected when chosen.

## Requirements

- OpenCode **v2** with the terminal UI (developed against **2.1.3**).
- `bun:sqlite` — bundled with OpenCode, nothing to install.
- The `opencode` executable — the plugin reuses the running binary through
  `process.execPath`.

## License

MIT — see [LICENSE](./LICENSE).
