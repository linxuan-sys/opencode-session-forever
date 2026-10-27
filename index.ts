import { Plugin } from "@opencode/plugin"

// Server-side stub: makes the server load this package as a plugin so the
// TUI part (tui.ts) is loaded along with it. All logic lives in tui.ts.
export default Plugin.define({
  id: "sessions-forever",
  setup() {},
})
