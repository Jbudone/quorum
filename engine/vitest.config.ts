import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Tests must never read or write the developer's real ~/.config/quorum.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "quorum-test-config-"));

export default defineConfig({});
