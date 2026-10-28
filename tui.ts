// Sessions Forever — TUI part.
// Saves the current conversation as a single portable .sf archive (a genuine
// OpenCode database written by official code) and restores archives as native
// sessions. All logic runs through official mechanisms: the session export /
// import transcript APIs, plus disposable `opencode --standalone` instances
// redirected via XDG_DATA_HOME. The main database is never touched directly.
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
const MAX_BUF = 512 * 1024 * 1024 // the official export streams through a stdout pipe; large sessions can reach tens of MB

function opencodeBin(): string {
  // The TUI process itself is the opencode binary
  try {
    if (process.execPath && fs.existsSync(process.execPath)) return process.execPath
  } catch {}
  return "opencode"
}

// Random id with the same prefix and length as official ids (verified to pass format checks and uniqueness constraints)
function rid(old: string): string {
  const i = old.indexOf("_")
  const prefix = i >= 0 ? old.slice(0, i + 1) : ""
  let s = ""
  for (let j = 0; j < old.length - prefix.length; j++) s += B62[Math.floor(Math.random() * B62.length)]
  return prefix + s
}

function sanitize(name: string): string {
  return name.replace(/[\/\\:*?"<>|\s]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "session"
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

// Spawn a disposable official instance (isolated via XDG_DATA_HOME + --standalone)
async function disposable<T>(fn: (env: NodeJS.ProcessEnv, bin: string) => Promise<T>): Promise<T> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "sessions-forever-"))
  try {
    return await fn({ ...process.env, XDG_DATA_HOME: path.join(tmp, "data") }, opencodeBin())
  } finally {
    // Only cleans up scratch directories the plugin itself created under the system temp dir
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

// Read-only quick peek at the session label inside a .sf (id/title/count); falls back to the file name
function peek(file: string): { id?: string; title?: string; count?: number; created?: number } {
  try {
    const db = new Database(file, { readonly: true })
    try {
      const row: any = db.query("select id, title, time_created from session_v2 limit 1").get()
      const cnt: any = db.query("select count(*) as n from session_message").get()
      return { id: row?.id, title: row?.title, count: Number(cnt?.n ?? 0), created: Number(row?.time_created ?? 0) }
    } finally {
      db.close()
    }
  } catch {
    return {}
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

    async function currentSessionDir(): Promise<{ sessionID?: string; dir: string }> {
      const route = context.ui.router.current()
      if (route?.type === "session") {
        try {
          const info = await context.client.session.get({ sessionID: route.sessionID })
          const dir = info?.location?.directory
          if (dir) return { sessionID: route.sessionID, dir }
        } catch {}
      }
      return { dir: context.location?.directory ?? process.cwd() }
    }

    async function save(input?: string) {
      const route = context.ui.router.current()
      if (route?.type !== "session") {
        await context.ui.dialog.alert({ title: "Sessions Forever", message: "Open a session first before saving." })
        return
      }
      const sessionID = route.sessionID
      const info = await context.client.session.get({ sessionID })
      const dir: string = info?.location?.directory ?? context.location?.directory ?? process.cwd()

      // File name: argument wins, default is title-timestamp
      const arg = (input ?? "").trim().replace(/\.sf$/i, "")
      const name = arg ? sanitize(arg) : `${sanitize(info?.title ?? "session")}-${stamp()}`
      const target = path.join(dir, `${name}.sf`)
      if (fs.existsSync(target)) {
        const ok = await context.ui.dialog.confirm({
          title: "Sessions Forever",
          message: `${name}.sf already exists. Overwrite it?`,
        })
        if (!ok) return
      }

      toast("Exporting conversation…")
      const transcript = await context.client.session.export({ sessionID })

      await disposable(async (env, bin) => {
        const tmpRoot = path.dirname(env.XDG_DATA_HOME!) // mkdtemp root (XDG_DATA_HOME=tmp/data)
        const tjson = path.join(tmpRoot, "transcript.json")
        await fsp.writeFile(tjson, JSON.stringify({ info: transcript.info, messages: transcript.messages }))
        // Official disposable instance: builds a fresh database from scratch and writes this conversation into it
        await execFileAsync(bin, ["session", "import", "--standalone", tjson, "--directory", dir], {
          env,
          maxBuffer: MAX_BUF,
          timeout: 180_000,
        })
        const dbPath = path.join(env.XDG_DATA_HOME!, "opencode", "opencode.db")
        if (!fs.existsSync(dbPath)) throw new Error("The disposable instance did not produce a database file")
        // Data-loss guard + zero footprint: merge any leftover WAL back into the main file,
        // then switch to DELETE journal mode so a read-only open of the archive never creates
        // -shm/-wal side files next to it.
        const db = new Database(dbPath)
        try {
          try {
            db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
          } catch {}
          db.exec("PRAGMA journal_mode=DELETE")
        } finally {
          db.close()
        }
        await fsp.copyFile(dbPath, target)
      })

      const size = (fs.statSync(target).size / 1024).toFixed(0)
      toast(`Saved ${transcript.messages.length} messages → ${target} (${size}KB)`)
    }

    async function load(input?: string) {
      const { dir } = await currentSessionDir()
      let files = (await fsp.readdir(dir)).filter((f) => f.toLowerCase().endsWith(".sf")).sort()
      if (!files.length) {
        await context.ui.dialog.alert({ title: "Sessions Forever", message: `No .sf archives in the current directory: ${dir}` })
        return
      }

      const metas = files.map((f) => ({ file: f, ...peek(path.join(dir, f)) }))

      // Direct selection by argument: index or file name
      const arg = (input ?? "").trim()
      let picked: (typeof metas)[number] | undefined
      if (arg) {
        if (/^\d+$/.test(arg)) {
          const n = parseInt(arg, 10)
          if (n < 1 || n > metas.length) {
            await context.ui.dialog.alert({ title: "Sessions Forever", message: `Index out of range (1-${metas.length})` })
            return
          }
          picked = metas[n - 1]
        } else {
          const want = arg.toLowerCase().endsWith(".sf") ? arg.toLowerCase() : arg.toLowerCase() + ".sf"
          picked = metas.find((m) => m.file.toLowerCase() === want)
          if (!picked) {
            await context.ui.dialog.alert({ title: "Sessions Forever", message: `Archive not found: ${arg}` })
            return
          }
        }
      } else {
        const value = await context.ui.dialog.select<string>({
          title: "Choose an archive to load",
          placeholder: "Type to filter…",
          options: metas.map((m) => ({
            value: m.file,
            title: m.title ? `"${m.title}"` : m.file,
            description: [m.count ? `${m.count} messages` : "", m.created ? new Date(m.created).toLocaleString() : "", m.file].filter(Boolean).join(" · "),
            category: "Sessions Forever",
          })),
        })
        if (!value) return
        picked = metas.find((m) => m.file === value)
      }
      if (!picked) return

      toast(`Reading ${picked.file} …`)
      const sfPath = path.join(dir, picked.file)

      // Mount the .sf into a disposable instance; the official export reads the transcript back
      const transcript = await disposable(async (env, bin) => {
        const dbDir = path.join(env.XDG_DATA_HOME!, "opencode")
        await fsp.mkdir(dbDir, { recursive: true })
        await fsp.copyFile(sfPath, path.join(dbDir, "opencode.db"))

        let sid = picked!.id
        if (!sid) {
          // Official fallback when the quick peek fails: session list
          const { stdout } = await execFileAsync(bin, ["session", "list", "--standalone", "--format", "json"], {
            env,
            cwd: dir,
            maxBuffer: MAX_BUF,
            timeout: 120_000,
          })
          const list = JSON.parse(stdout)
          const arr = Array.isArray(list) ? list : list?.data ?? list?.sessions ?? []
          sid = arr[0]?.id ?? arr[0]?.sessionID
          if (!sid) throw new Error("No session found in the archive (session list is empty)")
        }
        const { stdout } = await execFileAsync(bin, ["session", "export", "--standalone", sid!], {
          env,
          cwd: dir,
          maxBuffer: MAX_BUF,
          timeout: 120_000,
        })
        return JSON.parse(stdout)
      })

      if (!transcript?.info || !Array.isArray(transcript?.messages)) throw new Error("The archive does not contain a valid session transcript")

      // Regenerate session and message ids (including cross-references inside the JSON) and drop parent-session links
      let blob = JSON.stringify(transcript.messages)
      for (const m of transcript.messages) {
        if (m?.id) blob = blob.split(`"${m.id}"`).join(`"${rid(m.id)}"`)
      }
      const messages = JSON.parse(blob)
      const info: any = { ...transcript.info, id: rid(transcript.info.id) }
      delete info.parentID
      delete info.fork

      const created = await context.client.session.import({
        info,
        messages,
        location: { directory: dir },
      })

      // Automatically open the new tab, just like opening a conversation via /session
      context.ui.router.navigate({ type: "session", sessionID: created.id })
      toast(`Loaded "${created.title ?? picked.file}"`)
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "sessions-forever.save",
          title: "Save the current conversation as a .sf archive",
          description: "Export the current session into a single .sf database file (official storage format); movable and shareable",
          group: "Sessions Forever",
          palette: true,
          slash: { name: "session-save", arguments: true },
          run: (input?: string) => save(input).catch(fail),
        },
        {
          id: "sessions-forever.load",
          title: "Load a .sf archive",
          description: "List .sf archives in the current directory; the selected one is restored as a new session and opened automatically",
          group: "Sessions Forever",
          palette: true,
          slash: { name: "session-load", arguments: true },
          run: (input?: string) => load(input).catch(fail),
        },
      ],
    }))
  },
})
