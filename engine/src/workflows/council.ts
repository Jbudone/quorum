import { Mastra } from "@mastra/core";
import { InMemoryStore } from "@mastra/core/storage";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import type { Engine } from "../engine.js";

const loopState = z.object({ done: z.boolean() });

/**
 * The council loop as a Mastra workflow: each iteration runs the engine until its next pause point,
 * then suspends until the human resumes it (optionally with `stop: true` to end early).
 * Steering and Chair/agent chat happen on the Engine while the workflow is suspended.
 *
 * Suspend/resume needs a Mastra instance with storage for run snapshots. In-memory is enough
 * because the session files in .quorum/ are the durable record.
 */
export function councilWorkflow(engine: Engine) {
  const round = createStep({
    id: "round",
    inputSchema: loopState,
    outputSchema: loopState,
    suspendSchema: z.object({ round: z.number(), finished: z.boolean() }),
    resumeSchema: z.object({ stop: z.boolean().optional() }),
    execute: async ({ resumeData, suspend }) => {
      if (resumeData) return { done: Boolean(resumeData.stop) || engine.finished };
      await engine.continue();
      return suspend({ round: engine.currentRound, finished: engine.finished });
    },
  });

  const workflow = createWorkflow({ id: "council", inputSchema: loopState, outputSchema: loopState })
    .dountil(round, async ({ inputData }) => inputData.done)
    .commit();

  const mastra = new Mastra({
    workflows: { council: workflow },
    storage: new InMemoryStore(),
    logger: false,
  });
  return mastra.getWorkflow("council");
}
