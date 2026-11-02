import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Tests must never read or write the developer's real ~/.config/quorum or ~/.local/state/quorum.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "quorum-test-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "quorum-test-state-"));

export default defineConfig({});
