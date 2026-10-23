import { Agent } from "@mastra/core/agent";
import { CliModel } from "../climodel/index.js";
import type { Persona } from "../config.js";
import type { AgentEvent, AgentTransport, SendOptions } from "../transports/types.js";

export interface CouncilAgent {
  agent: Agent;
  model: CliModel;
}

/**
 * Builds a Mastra Agent whose model is a subscription CLI.
 * The cast is deliberate: Mastra's MastraLanguageModelV4 type declares doGenerate as returning a
 * stream result, which contradicts the AI SDK V4 spec that CliModel implements (and that Mastra
 * calls correctly at runtime; see climodel.test.ts).
 */
export function createCouncilAgent(
  id: string,
  persona: Persona,
  transport: AgentTransport,
  defaults: SendOptions = {},
  onEvent?: (e: AgentEvent) => void,
): CouncilAgent {
  const model = new CliModel(transport, { ...defaults, systemPrompt: undefined }, onEvent);
  const agent = new Agent({
    id,
    name: persona.name,
    instructions: persona.body,
    model: model as never,
  });
  return { agent, model };
}
