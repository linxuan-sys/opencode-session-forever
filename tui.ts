// Sessions Forever — TUI part.
//
// A .sf file is a complete OpenCode database (the same schema the app uses), so it
// behaves as a standalone library: one .sf can hold many conversations.
//
//   /session-save  asks for a name, then writes the current conversation into
//                  <cwd>/<name>.sf — creating the library, or appending a new
//                  conversation to it when the file already exists.
//   /session-load  lists the .sf libraries in the working directory, shows how many
//                  conversations each one holds, then swaps the live database's
//                  conversation tables over to the chosen library.
//   /session-main  switches back to the conversations that were live before.
//
// The swap is a single transaction against the live database file, so the service
// never restarts and a failure rolls back cleanly. Configuration tables
// (credentials, kv, permissions, instructions) are never touched.
import { Plugin } from "@opencode/plugin/tui"
import { Database } from "bun:sqlite"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

const execFileAsync = promisify(execFile)
const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
const MAX_BUF = 512 * 1024 * 1024
const EXT = ".sf"
const STATE_DIR = path.join(os.homedir(), ".local", "share", "sessions-forever")
const STATE_FILE = path.join(STATE_DIR, "state.json")
// Where the conversations that were live before opening a library are parked.
const MAIN_PARK = path.join(STATE_DIR, "main.sf")

// Conversations live in these tables. Everything else (credentials, kv, permissions,
// instructions) belongs to the user's own library and survives a swap untouched.
const CONVERSATION_TABLES = [
  "session_message",
  "session_inbox",
  "session_pending",
  "session_v2",
  "project",
  "project_directory",
  "worktree",
] as const

type State = { active?: string; at?: number }
type LibSession = { id: string; title: string; created: number; updated: number; count: number }

function opencodeBin(): string {
  try {
    if (process.execPath && fs.existsSync(process.execPath)) return process.execPath
  } catch {}
  return "opencode"
}

// Official ids carry a prefix and a fixed length; regenerating keeps that shape.
function rid(old: string): string {
  const i = old.indexOf("_")
  const prefix = i >= 0 ? old.slice(0, i + 1) : ""
  let s = ""
  for (let j = 0; j < old.length - prefix.length; j++) s += B62[Math.floor(Math.random() * B62.length)]
  return prefix + s
}

function sanitize(name: string): string {
  const cleaned = name
    .replace(/[\/\\:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .trim()
    .slice(0, 60)
  return cleaned || "session"
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${p(d.getSeconds())}`
}

function dataRoot(): string {
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
}

function mainDb(): string {
  return path.join(dataRoot(), "opencode", "opencode.db")
}

// Every write below opens the live database. A generous busy timeout keeps a swap
// from failing just because the service happened to be writing at that moment.
function openLive(file: string): Database {
  const db = new Database(file)
  db.exec("PRAGMA busy_timeout=15000")
  db.exec("PRAGMA foreign_keys=OFF")
  return db
}

// WAL content lives in <db>-wal until it is checkpointed. Copying the file without
// this step yields an empty shell (observed: 4KB file, 300KB of data in the WAL).
function checkpoint(file: string): void {
  if (!fs.existsSync(file)) return
  const db = new Database(file)
  try {
    db.exec("PRAGMA busy_timeout=15000")
    db.query("PRAGMA wal_checkpoint(TRUNCATE)").get()
  } catch {
  } finally {
    db.close()
  }
}

// Merge WAL and leave the file in DELETE journal mode, so read-only opens of a
// sealed .sf never create -shm/-wal side files next to it.
function seal(file: string): void {
  const db = new Database(file)
  try {
    db.exec("PRAGMA busy_timeout=15000")
    try {
      db.query("PRAGMA wal_checkpoint(TRUNCATE)").get()
    } catch {}
    db.exec("PRAGMA journal_mode=DELETE")
  } finally {
    db.close()
  }
}

// Copy the conversation tables of `source` into `target`, replacing whatever the
// target held. Runs as one transaction: a failure leaves the target untouched.
// Only columns present on both sides are copied, so libraries written by an older
// release still load.
function transplant(target: string, source: string): void {
  checkpoint(target)
  const db = openLive(target)
  try {
    db.exec(`ATTACH DATABASE '${source.replace(/'/g, "''")}' AS src`)
    try {
      db.exec("BEGIN IMMEDIATE")
      for (const t of CONVERSATION_TABLES) db.exec(`DELETE FROM main.${t}`)
      try {
        db.exec("DELETE FROM main.event")
      } catch {}
      for (const t of CONVERSATION_TABLES) {
        const targetCols: string[] = db
          .query("select name from pragma_table_info(?)")
          .all(t)
          .map((r: any) => String(r.name))
        const sourceCols: string[] = db
          .query("select name from src.pragma_table_info(?)")
          .all(t)
          .map((r: any) => String(r.name))
        const shared = targetCols.filter((c) => sourceCols.includes(c))
        if (!shared.length) continue
        const list = shared.map((c) => `"${c}"`).join(", ")
        db.exec(`INSERT INTO main.${t} (${list}) SELECT ${list} FROM src.${t}`)
      }
      // A conversation's write counter must cover the seq values already in the table,
      // otherwise the next insert starts at 1 and hits UNIQUE(session_id, seq).
      db.exec(`INSERT INTO main.event_sequence (aggregate_id, seq)
        SELECT session_id, MAX(seq) FROM main.session_message GROUP BY session_id
        ON CONFLICT(aggregate_id) DO UPDATE SET seq = MAX(event_sequence.seq, excluded.seq)`)
      db.exec("COMMIT")
    } catch (e) {
      try {
        db.exec("ROLLBACK")
      } catch {}
      throw e
    } finally {
      try {
        db.exec("DETACH DATABASE src")
      } catch {}
    }
  } finally {
    db.close()
  }
}

// Snapshot the conversations currently in the live database into `file`, writing
// through an official disposable instance so the archive is a genuine library.
async function parkLiveConversations(file: string): Promise<boolean> {
  const live = mainDb()
  if (!fs.existsSync(live)) return false
  checkpoint(live)
  const hasRows = (() => {
    const db = new Database(live, { readonly: true })
    try {
      return Number((db.query("select count(*) as n from session_v2").get() as any)?.n ?? 0) > 0
    } catch {
      return false
    } finally {
      db.close()
    }
  })()
  if (!hasRows) return false

  await fsp.copyFile(live, file)
  seal(file)
  return true
}

async function readState(): Promise<State | undefined> {
  try {
    return JSON.parse(await fsp.readFile(STATE_FILE, "utf8"))
  } catch {
    return undefined
  }
}

async function writeState(state: State): Promise<void> {
  await fsp.mkdir(STATE_DIR, { recursive: true })
  await fsp.writeFile(STATE_FILE, JSON.stringify(state, null, 2))
}

async function clearState(): Promise<void> {
  await fsp.rm(STATE_FILE, { force: true }).catch(() => {})
}

// Spawns a throwaway official instance so all writes go through OpenCode itself.
async function disposable<T>(fn: (env: NodeJS.ProcessEnv, bin: string, root: string) => Promise<T>): Promise<T> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "sessions-forever-"))
  try {
    return await fn({ ...process.env, XDG_DATA_HOME: path.join(tmp, "data") }, opencodeBin(), tmp)
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

// Every conversation stored inside a .sf library, newest first.
function librarySessions(file: string): LibSession[] {
  try {
    const db = new Database(file, { readonly: true })
    try {
      const rows: any[] = db
        .query("select id, title, time_created, time_updated from session_v2 order by time_updated desc")
        .all()
      return rows.map((r) => {
        const n: any = db.query("select count(*) as n from session_message where session_id = ?").get(r.id)
        return {
          id: String(r.id),
          title: String(r.title ?? "(untitled)"),
          created: Number(r.time_created ?? 0),
          updated: Number(r.time_updated ?? 0),
          count: Number(n?.n ?? 0),
        }
      })
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}

export default Plugin.define({
  id: "sessions-forever-tui",
  setup(context: any) {
    const toast = (message: string) => context.ui.toast.show({ title: "Sessions Forever", message })
    const fail = async (e: any) => {
      const msg = String(e?.message ?? e)
      try {
        await context.ui.dialog.alert({ title: "Sessions Forever error", message: msg })
      } catch {
        toast(msg)
      }
    }

    async function currentSessionDir(): Promise<string> {
      const route = context.ui.router.current()
      if (route?.type === "session") {
        try {
          const dir = (await context.client.session.get({ sessionID: route.sessionID }))?.location?.directory
          if (dir) return dir
        } catch {}
      }
      return context.location?.directory ?? process.cwd()
    }

    // Point the live database at another library. One transaction, no restart: the
    // service picks the new conversations up on its next read.
    async function openLibrary(archive: string): Promise<void> {
      const state = await readState()
      // Park the conversations that are live right now, so /session-main can bring
      // them back. Skipped when the live conversations already are a library's.
      if (!state?.active) await parkLiveConversations(MAIN_PARK)
      transplant(mainDb(), archive)
      await writeState({ active: archive, at: Date.now() })
    }

    async function restoreMain(): Promise<void> {
      if (!fs.existsSync(MAIN_PARK)) throw new Error("No parked conversations were found — nothing to switch back to")
      const state = await readState()
      // Keep whatever was typed inside the library by writing it back to the archive.
      if (state?.active && fs.existsSync(state.active)) {
        const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "sessions-forever-wb-"))
        try {
          const copy = path.join(tmp, "live.db")
          checkpoint(mainDb())
          await fsp.copyFile(mainDb(), copy)
          seal(copy)
          // Replace the archive's conversations with the live ones, keeping the archive
          // a valid standalone library.
          const db = openLive(copy)
          try {
            db.exec(`ATTACH DATABASE '${state.active.replace(/'/g, "''")}' AS lib`)
            try {
              db.exec("BEGIN IMMEDIATE")
              for (const t of CONVERSATION_TABLES) db.exec(`DELETE FROM lib.${t}`)
              for (const t of CONVERSATION_TABLES) {
                const libCols: string[] = db
                  .query("select name from lib.pragma_table_info(?)")
                  .all(t)
                  .map((r: any) => String(r.name))
                const liveCols: string[] = db
                  .query("select name from pragma_table_info(?)")
                  .all(t)
                  .map((r: any) => String(r.name))
                const shared = libCols.filter((c) => liveCols.includes(c))
                if (!shared.length) continue
                const list = shared.map((c) => `"${c}"`).join(", ")
                db.exec(`INSERT INTO lib.${t} (${list}) SELECT ${list} FROM main.${t}`)
              }
              db.exec(`INSERT INTO lib.event_sequence (aggregate_id, seq)
                SELECT session_id, MAX(seq) FROM lib.session_message GROUP BY session_id
                ON CONFLICT(aggregate_id) DO UPDATE SET seq = MAX(lib.event_sequence.seq, excluded.seq)`)
              db.exec("COMMIT")
            } catch (e) {
              try {
                db.exec("ROLLBACK")
              } catch {}
              throw e
            } finally {
              try {
                db.exec("DETACH DATABASE lib")
              } catch {}
            }
          } finally {
            db.close()
          }
        } finally {
          await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
        }
      }
      transplant(mainDb(), MAIN_PARK)
      await clearState()
    }

    // The official importer rejects transcripts that lack these accounting fields,
    // so fill them in before handing the file over. The file on disk is never edited.
    // Every id is regenerated: importing the same file twice must yield two separate
    // conversations, and the original session may still exist in this database.
    async function normalizeTranscript(raw: any, dir: string): Promise<any> {
      const info = raw?.info
      if (!info?.id || !Array.isArray(raw?.messages)) throw new Error("Not an OpenCode transcript (expected {info, messages})")
      info.cost ??= 0
      info.tokens ??= { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      info.outcome ??= "succeeded"
      info.location ??= { directory: dir }
      if (!info.projectID) {
        try {
          info.projectID = (await context.client.project.current({ directory: dir }))?.id
        } catch {}
      }
      delete info.parentID
      delete info.fork
      const ids = new Map<string, string>()
      return JSON.parse(
        JSON.stringify(raw).replace(/"((?:msg|ses|prt)_[A-Za-z0-9]+)"/g, (_whole: string, id: string) => {
          if (!ids.has(id)) ids.set(id, rid(id))
          return `"${ids.get(id)}"`
        }),
      )
    }

    async function importJson(file: string, dir: string): Promise<{ sessionID: string; message: string }> {
      const raw = await normalizeTranscript(JSON.parse(await fsp.readFile(file, "utf8")), dir)
      const tmp = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), "sessions-forever-json-")), "transcript.json")
      try {
        await fsp.writeFile(tmp, JSON.stringify(raw))
        const { stdout } = await execFileAsync(opencodeBin(), ["session", "import", tmp, "--directory", dir], {
          maxBuffer: MAX_BUF,
          timeout: 300_000,
        })
        const out = String(stdout).trim()
        return { sessionID: out.match(/(ses_[A-Za-z0-9]+)/)?.[1] ?? raw.info.id, message: out || "Imported" }
      } finally {
        await fsp.rm(path.dirname(tmp), { recursive: true, force: true }).catch(() => {})
      }
    }

    async function save(input?: string) {
      const route = context.ui.router.current()
      if (route?.type !== "session") {
        await context.ui.dialog.alert({ title: "Sessions Forever", message: "Open a conversation first." })
        return
      }
      const sessionID = route.sessionID
      const info = await context.client.session.get({ sessionID })
      const dir: string = info?.location?.directory ?? context.location?.directory ?? process.cwd()

      const format = await context.ui.dialog.select<string>({
        title: "Save conversation",
        options: [
          { value: "sf", title: "as a .sf library", description: "Appends to a library; load it later with /session-load" },
          { value: "json", title: "as a .json file", description: "Plain transcript; import it into the live database" },
        ],
      })
      if (!format) return

      if (format === "json") {
        const typed = await context.ui.dialog.prompt({
          title: "Export conversation as JSON",
          message: "File name (the .json extension is added automatically)",
          placeholder: sanitize(info?.title ?? "session"),
          value: input?.trim() || "",
        } as any)
        if (typed === undefined) return
        const name = sanitize(typed.trim() || info?.title || "session")
        const file = path.join(dir, `${name}.json`)
        const transcript = await context.client.session.export({ sessionID })
        await fsp.writeFile(file, JSON.stringify(transcript, null, 2))
        toast(`Exported ${path.basename(file)} (${(fs.statSync(file).size / 1024).toFixed(0)}KB)`)
        return
      }

      const typed = await context.ui.dialog.prompt({
        title: "Save conversation as a library",
        message: "Name for the .sf library (the .sf extension is added automatically)",
        placeholder: sanitize(info?.title ?? "session"),
        value: input?.trim() || "",
      } as any)
      if (typed === undefined) return
      const name = sanitize(typed.trim() || info?.title || "session")
      const target = path.join(dir, `${name}${EXT}`)
      const exists = fs.existsSync(target)

      if (exists) {
        const before = librarySessions(target).length
        const ok = await context.ui.dialog.confirm({
          title: "Sessions Forever",
          message: `"${name}${EXT}" already holds ${before} conversation(s). Add this one to it?`,
        })
        if (!ok) return
      }

      toast(exists ? "Adding to library…" : "Creating library…")
      const transcript = await context.client.session.export({ sessionID })

      await disposable(async (env, bin, root) => {
        const dbDir = path.join(env.XDG_DATA_HOME!, "opencode")
        await fsp.mkdir(dbDir, { recursive: true })
        const working = path.join(dbDir, "opencode.db")
        // Appending: start from the existing library so its conversations survive.
        if (exists) {
          checkpoint(target)
          await fsp.copyFile(target, working)
        }

        // Always allocate fresh ids: the same conversation may already be inside.
        const ids = new Map<string, string>()
        for (const m of transcript.messages as any[]) if (m?.id) ids.set(m.id, rid(m.id))
        const blob = JSON.stringify(transcript.messages).replace(
          /"((?:msg|ses|prt)_[A-Za-z0-9]+)"/g,
          (whole: string, id: string) => (ids.has(id) ? `"${ids.get(id)}"` : whole),
        )
        const messages = JSON.parse(blob)
        const archivedInfo: any = {
          ...transcript.info,
          id: rid(transcript.info.id),
          title: `${info?.title ?? transcript.info.title ?? "session"} (${stamp()})`,
        }
        delete archivedInfo.parentID
        delete archivedInfo.fork
        delete archivedInfo.agent

        const tjson = path.join(root, "transcript.json")
        await fsp.writeFile(tjson, JSON.stringify({ info: archivedInfo, messages }))
        await execFileAsync(bin, ["session", "import", "--standalone", tjson, "--directory", dir], {
          env,
          maxBuffer: MAX_BUF,
          timeout: 300_000,
        })

        const built = path.join(dbDir, "opencode.db")
        if (!fs.existsSync(built)) throw new Error("The library could not be written")
        seal(built)
        await fsp.copyFile(built, target)
      })

      const total = librarySessions(target).length
      const size = (fs.statSync(target).size / 1024 / 1024).toFixed(1)
      toast(`Saved to ${name}${EXT} — now ${total} conversation(s), ${size}MB`)
    }

    async function load(input?: string) {
      const dir = await currentSessionDir()
      const state = await readState()

      const files = (await fsp.readdir(dir)).filter((f) => f.toLowerCase().endsWith(EXT)).sort()
      const jsons = (await fsp.readdir(dir)).filter((f) => f.toLowerCase().endsWith(".json")).sort()
      const options = [
        // Escape hatch: while a library is open, offer the way back.
        ...(state?.active
          ? [
              {
                value: "__restore__",
                title: "← Switch back to the main conversations",
                description: path.basename(state.active),
              },
            ]
          : []),
        ...jsons.map((f) => ({
          value: `json:${f}`,
          title: f,
          description: "JSON transcript · imported into the live database",
        })),
        ...files.map((f) => {
          const list = librarySessions(path.join(dir, f))
          return {
            value: f,
            title: f,
            description: `${list.length} conversation(s)${list[0] ? ` · latest: ${list[0].title}` : ""}`,
          }
        }),
      ]

      if (!options.length) {
        await context.ui.dialog.alert({
          title: "Sessions Forever",
          message: `No .sf libraries or .json transcripts in ${dir}`,
        })
        return
      }

      let picked = ""
      const arg = (input ?? "").trim()
      if (arg) {
        const want = arg.toLowerCase().replace(/\.(sf|json)$/, "")
        const found = options.find(
          (o) => o.value === arg || o.value.toLowerCase() === arg.toLowerCase() || o.title.toLowerCase() === want,
        )
        if (!found) {
          await context.ui.dialog.alert({ title: "Sessions Forever", message: `Not found: ${arg}` })
          return
        }
        picked = found.value
      } else {
        const value = await context.ui.dialog.select<string>({
          title: "Open a library",
          placeholder: "Type to filter…",
          options,
        })
        if (!value) return
        picked = value
      }

      if (picked.startsWith("json:")) {
        const file = path.join(dir, picked.slice(5))
        toast(`Importing ${path.basename(file)}…`)
        const { sessionID, message } = await importJson(file, dir)
        context.ui.router.navigate({ type: "session", sessionID })
        toast(message)
        return
      }

      if (picked === "__restore__") {
        toast("Switching back…")
        await restoreMain()
        toast("Main conversations restored")
        return
      }

      const archive = path.join(dir, picked)
      const list = librarySessions(archive)
      if (!list.length) {
        await context.ui.dialog.alert({ title: "Sessions Forever", message: `${picked} contains no conversations` })
        return
      }

      // Land on a chosen conversation, or start a new one inside the library.
      const value = await context.ui.dialog.select<string>({
        title: `${picked} — ${list.length} conversation${list.length > 1 ? "s" : ""}`,
        options: [
          {
            value: "__new__",
            title: "＋ New conversation",
            description: "Open this library and start a fresh conversation inside it",
          },
          ...list.map((s) => ({
            value: s.id,
            title: s.title,
            description: `${s.count} messages · ${new Date(s.updated).toLocaleString()}`,
          })),
        ],
      })
      if (!value) return

      toast(`Opening ${picked}…`)
      await openLibrary(archive)

      if (value === "__new__") {
        const created = await context.client.session.create({ directory: dir })
        context.ui.router.navigate({ type: "session", sessionID: created.id })
        toast(`Opened ${picked} — new conversation`)
        return
      }

      context.ui.router.navigate({ type: "session", sessionID: value })
      toast(`Opened ${picked} — /session now shows only this library`)
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "sessions-forever.save",
          title: "Save conversation into a .sf library",
          description: "Ask for a name, then write the current conversation into <name>.sf in the working directory (appends when the library exists)",
          group: "Sessions Forever",
          palette: true,
          slash: { name: "session-save", arguments: true },
          run: (input?: string) => save(input).catch(fail),
        },
        {
          id: "sessions-forever.load",
          title: "Open a .sf library",
          description: "List the .sf libraries in the working directory, then switch the live database over to the chosen one",
          group: "Sessions Forever",
          palette: true,
          slash: { name: "session-load", arguments: true },
          run: (input?: string) => load(input).catch(fail),
        },
        {
          id: "sessions-forever.main",
          title: "Switch back to the main conversations",
          description: "Restore the conversations that were live before a library was opened",
          group: "Sessions Forever",
          palette: true,
          slash: { name: "session-main" },
          run: async () => {
            const state = await readState()
            if (!state?.active && !fs.existsSync(MAIN_PARK)) {
              await context.ui.dialog.alert({
                title: "Sessions Forever",
                message: "The main conversations are already active (nothing parked).",
              })
              return
            }
            const ok = await context.ui.dialog.confirm({
              title: "Switch back",
              message: "Restore the conversations that were live before a library was opened?",
            })
            if (!ok) return
            toast("Switching back…")
            try {
              await restoreMain()
            } catch (e) {
              await fail(e)
              return
            }
            const created = await context.client.session.create({ directory: await currentSessionDir() })
            context.ui.router.navigate({ type: "session", sessionID: created.id })
            toast("Main conversations restored")
          },
        },
      ],
    }))
  },
})
