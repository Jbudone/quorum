import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPreset } from "../src/config.js";
import { Engine } from "../src/engine.js";
import { MockTransport } from "../src/transports/mock.js";
import { councilWorkflow } from "../src/workflows/council.js";

function make(rounds: number) {
  const engine = new Engine({
    config: { ...loadPreset("solo"), protocol: "round-robin", pause: "round", rounds },
    topic: "t",
    repo: mkdtempSync(join(tmpdir(), "quorum-wf-")),
    transportFor: (id) => new MockTransport(id, { rules: [], fallback: `${id} reply` }),
  });
  return { engine, wf: councilWorkflow(engine) };
}

describe("council workflow", () => {
  it("suspends after each round and completes when the human resumes past the end", async () => {
    const { engine, wf } = make(2);
    const run = await wf.createRun();

    let res: any = await run.start({ inputData: { done: false } });
    expect(res.status).toBe("suspended");
    expect(engine.currentRound).toBe(1);

    res = await run.resume({ step: "round", resumeData: {} });
    expect(res.status).toBe("suspended");
    expect(engine.currentRound).toBe(2);
    expect(engine.finished).toBe(true);

    res = await run.resume({ step: "round", resumeData: {} });
    expect(res.status).toBe("success");
    expect(engine.session.transcript().filter((e) => e.speaker === "architect")).toHaveLength(2);
  });

  it("lets the human stop early", async () => {
    const { engine, wf } = make(5);
    const run = await wf.createRun();
    await run.start({ inputData: { done: false } });
    const res: any = await run.resume({ step: "round", resumeData: { stop: true } });
    expect(res.status).toBe("success");
    expect(engine.currentRound).toBe(1);
  });
});
