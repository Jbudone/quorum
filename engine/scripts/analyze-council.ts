#!/usr/bin/env node
/**
 * Quorum Council Analysis Script
 * 
 * Pulls traces from Langfuse and generates a comprehensive analysis report
 * including model comparison, quality scores, and recommendations.
 * 
 * Usage:
 *   pnpm -C engine exec tsx scripts/analyze-council.ts [--session <id>] [--project <name>]
 * 
 * Environment:
 *   LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

interface LangfuseTrace {
  id: string;
  name: string;
  timestamp: string;
  metadata: Record<string, any>;
  observations: LangfuseObservation[];
  sessionId?: string;
  userId?: string;
  tags: string[];
}

interface LangfuseObservation {
  id: string;
  name: string;
  type: "GENERATION" | "SPAN" | "AGENT" | "TOOL" | "EVENT";
  startTime: string;
  endTime?: string;
  input?: any;
  output?: any;
  metadata?: Record<string, any>;
  usageDetails?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  costDetails?: { totalCost?: number };
  level?: string;
  tags: string[];
  parentObservationId?: string;
}

interface AgentStats {
  agent: string;
  model: string;
  turns: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  avgLatencyMs: number;
  errors: number;
  relevanceScores: number[];
}

interface QualityScores {
  chairSummary: { clarity: number; completeness: number; actionability: number; neutrality: number; reasoning: string };
  planCoherence: { structure: number; specificity: number; consistency: number; feasibility: number; reasoning: string };
  agentRelevance: { average: number; byAgent: Record<string, number>; details: string[] };
}

function parseArgs(): { sessionId?: string; project?: string; outputFormat: "markdown" | "json" } {
  const args = process.argv.slice(2);
  const result: any = { outputFormat: "markdown" };
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--session" && i + 1 < args.length) result.sessionId = args[++i];
    else if (args[i] === "--project" && i + 1 < args.length) result.project = args[++i];
    else if (args[i] === "--json") result.outputFormat = "json";
    else if (args[i] === "--help") {
      console.log(`
Quorum Council Analyzer

Usage:
  pnpm -C engine exec tsx scripts/analyze-council.ts [options]

Options:
  --session <id>    Analyze specific session (default: latest)
  --project <name>  Langfuse project name (optional, for multi-project)
  --json            Output JSON instead of markdown
  --help            Show this help

Environment:
  LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL
      `);
      process.exit(0);
    }
  }
  return result;
}

function checkCredentials(): void {
  const missing = [];
  if (!process.env.LANGFUSE_PUBLIC_KEY) missing.push("LANGFUSE_PUBLIC_KEY");
  if (!process.env.LANGFUSE_SECRET_KEY) missing.push("LANGFUSE_SECRET_KEY");
  
  if (missing.length > 0) {
    console.error(`❌ Missing environment variables: ${missing.join(", ")}`);
    console.error("Export them in your shell.");
    process.exit(1);
  }
}

/**
 * Calls Langfuse's public REST API. No shell is involved, so a session id can't be read as a
 * command, and arguments with spaces or quotes (like JSON filters) arrive intact.
 */
async function langfuse(path: string, query: Record<string, string | string[]> = {}): Promise<any> {
  const base = (process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com").replace(/\/$/, "");
  const url = new URL(`${base}/api/public/${path}`);
  for (const [k, v] of Object.entries(query)) for (const x of [v].flat()) url.searchParams.append(k, x);
  const auth = Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString("base64");
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) {
    console.error(`❌ Langfuse API error: HTTP ${res.status} for ${url.pathname}`);
    process.exit(1);
  }
  return res.json();
}

async function fetchTraces(sessionId?: string): Promise<LangfuseTrace[]> {
  const response = await langfuse("traces", { tags: ["quorum", "council"], limit: "100", orderBy: "timestamp.desc" });
  const traces: LangfuseTrace[] = response.data || [];
  return sessionId ? traces.filter((t) => t.metadata?.sessionId === sessionId || t.sessionId === sessionId) : traces;
}

async function fetchTraceDetails(traceId: string): Promise<LangfuseTrace | null> {
  return (await langfuse(`traces/${encodeURIComponent(traceId)}`)) ?? null;
}

function extractAgentName(obs: LangfuseObservation): string | null {
  // Try tags first
  const agentTag = obs.tags.find(t => t.startsWith("agent:"));
  if (agentTag) return agentTag.replace("agent:", "");
  
  // Try metadata
  if (obs.metadata?.agent) return obs.metadata.agent;
  
  // Try name pattern
  const match = obs.name.match(/^turn-(.+)$/);
  if (match) return match[1];
  
  return null;
}

function extractModel(obs: LangfuseObservation): string {
  // Try tags
  const modelTag = obs.tags.find(t => t.startsWith("model:"));
  if (modelTag) return modelTag.replace("model:", "");
  
  // Try model field
  if (obs.metadata?.model) return obs.metadata.model;
  
  // Try observation model field (for generations)
  return (obs as any).model || "unknown";
}

function analyzeSession(traces: LangfuseTrace[]): {
  sessionTrace: LangfuseTrace | null;
  agentStats: Map<string, AgentStats>;
  rounds: number;
  converged: boolean;
  totalCost: number;
  totalTokens: number;
} {
  // Find the session trace (type AGENT, name "council-session")
  const sessionTrace = traces.find(t => t.name === "council-session") || traces[0];
  
  const agentStats = new Map<string, AgentStats>();
  let rounds = 0;
  let converged = false;
  let totalCost = 0;
  let totalTokens = 0;
  
  for (const trace of traces) {
    for (const obs of trace.observations) {
      if (obs.type === "GENERATION" && obs.name.startsWith("turn-")) {
        const agent = extractAgentName(obs);
        const model = extractModel(obs);
        
        if (!agent) continue;
        
        const key = `${agent}@${model}`;
        let stats = agentStats.get(key);
        
        if (!stats) {
          stats = {
            agent,
            model,
            turns: 0,
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalCost: 0,
            avgLatencyMs: 0,
            errors: 0,
            relevanceScores: [],
          };
          agentStats.set(key, stats);
        }
        
        stats.turns++;
        
        const usage = obs.usageDetails;
        if (usage) {
          stats.inputTokens += usage.promptTokens || 0;
          stats.outputTokens += usage.completionTokens || 0;
          stats.totalTokens += usage.totalTokens || 0;
        }
        
        const cost = obs.costDetails?.totalCost || 0;
        stats.totalCost += cost;
        totalCost += cost;
        totalTokens += usage?.totalTokens || 0;
        
        // Latency
        if (obs.startTime && obs.endTime) {
          const latency = new Date(obs.endTime).getTime() - new Date(obs.startTime).getTime();
          stats.avgLatencyMs = (stats.avgLatencyMs * (stats.turns - 1) + latency) / stats.turns;
        }
        
        if (obs.level === "ERROR") stats.errors++;
      }
      
      // Count rounds
      if (obs.name.startsWith("round-")) {
        const roundNum = parseInt(obs.name.replace("round-", ""));
        if (!isNaN(roundNum)) rounds = Math.max(rounds, roundNum);
      }
      
      // Check convergence from chair summary
      if (obs.name === "turn-chair" && obs.output?.content) {
        const content = obs.output.content;
        if (content.includes("converged") || content.includes("converge")) {
          converged = true;
        }
      }
    }
  }
  
  return { sessionTrace, agentStats, rounds, converged, totalCost, totalTokens };
}

async function runLLMJudge(prompt: string): Promise<any> {
  const apiKey = process.env.OPENROUTER_API_KEY; // the judge calls OpenRouter only
  if (!apiKey) {
    console.warn("⚠️  No OPENROUTER_API_KEY set, so the LLM judge is skipped");
    return null;
  }
  
  // Use OpenRouter for flexibility
  if (process.env.OPENROUTER_API_KEY) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        },
        body: JSON.stringify({
          model: process.env.JUDGE_MODEL || "anthropic/claude-haiku-5.5",
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          temperature: 0.1,
          max_tokens: 1000,
        }),
      });
      
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      return JSON.parse(data.choices[0].message.content);
    } catch (e: any) {
      console.warn(`⚠️  Judge evaluation failed: ${e.message}`);
      return null;
    }
  }
  
  return null;
}

async function evaluateQuality(sessionTrace: LangfuseTrace, traces: LangfuseTrace[]): Promise<QualityScores> {
  // Find chair summary observations
  const chairTurns = traces.flatMap(t => t.observations.filter(o => o.name === "turn-chair" && o.type === "GENERATION"));
  const planTurns = traces.flatMap(t => t.observations.filter(o => o.name.startsWith("turn-") && o.output?.content?.includes("# Plan")));
  const agentTurns = traces.flatMap(t => t.observations.filter(o => o.type === "GENERATION" && o.name.startsWith("turn-") && !o.name.includes("chair")));
  
  const scores: QualityScores = {
    chairSummary: { clarity: 0, completeness: 0, actionability: 0, neutrality: 0, reasoning: "Not evaluated" },
    planCoherence: { structure: 0, specificity: 0, consistency: 0, feasibility: 0, reasoning: "Not evaluated" },
    agentRelevance: { average: 0, byAgent: {}, details: [] },
  };
  
  // Evaluate chair summary (latest)
  if (chairTurns.length > 0) {
    const latestChair = chairTurns[chairTurns.length - 1];
    const result = await runLLMJudge(`
Evaluate this Chair summary from a multi-agent council.

Topic: ${sessionTrace.metadata?.topic || "Unknown"}
Round: ${latestChair.metadata?.round || "Unknown"}

Chair Summary:
${latestChair.output?.content || "No content"}

Rate 1-5 on:
1. CLARITY - Is the summary clear and actionable?
2. COMPLETENESS - Does it capture key agreements/disagreements?
3. ACTIONABILITY - Does it give clear next steps?
4. NEUTRALITY - Does it fairly represent all agents?

Output JSON: {"clarity": N, "completeness": N, "actionability": N, "neutrality": N, "reasoning": "..."}
    `);
    
    if (result) scores.chairSummary = result;
  }
  
  // Evaluate plan coherence (latest plan)
  if (planTurns.length > 0) {
    const latestPlan = planTurns[planTurns.length - 1];
    const result = await runLLMJudge(`
Evaluate this council plan for coherence and quality.

Topic: ${sessionTrace.metadata?.topic || "Unknown"}
Round: ${latestPlan.metadata?.round || "Unknown"}

Plan:
${latestPlan.output?.content || "No content"}

Rate 1-5:
1. STRUCTURE - Logical organization?
2. SPECIFICITY - Concrete, actionable items?
3. CONSISTENCY - Aligns with previous rounds?
3. FEASIBILITY - Realistic scope?

Output JSON: {"structure": N, "specificity": N, "consistency": N, "feasibility": N, "reasoning": "..."}
    `);
    
    if (result) scores.planCoherence = result;
  }
  
  // Evaluate agent relevance (sample a few turns per agent)
  const agentGroups = new Map<string, LangfuseObservation[]>();
  for (const turn of agentTurns) {
    const agent = extractAgentName(turn);
    if (!agent) continue;
    if (!agentGroups.has(agent)) agentGroups.set(agent, []);
    agentGroups.get(agent)!.push(turn);
  }
  
  let totalRelevance = 0;
  let relevanceCount = 0;
  
  for (const [agent, turns] of agentGroups) {
    // Sample up to 2 turns per agent
    const samples = turns.slice(-2);
    let agentTotal = 0;
    let agentCount = 0;
    
    for (const turn of samples) {
      const result = await runLLMJudge(`
Evaluate this agent response in a council discussion.

Topic: ${sessionTrace.metadata?.topic || "Unknown"}
Agent Role: ${agent}
Round: ${turn.metadata?.round || "Unknown"}

Prompt: ${JSON.stringify(turn.input).slice(0, 2000)}
Response: ${turn.output?.content?.slice(0, 3000) || "No content"}

Rate 1-5: Does this response meaningfully advance the discussion for this agent's role?
Output JSON: {"score": N, "reasoning": "..."}
      `);
      
      if (result?.score) {
        agentTotal += result.score;
        agentCount++;
        scores.agentRelevance.details.push(`${agent} (R${turn.metadata?.round}): ${result.score}/5 - ${result.reasoning}`);
      }
    }
    
    if (agentCount > 0) {
      const avg = agentTotal / agentCount;
      scores.agentRelevance.byAgent[agent] = Math.round(avg * 10) / 10;
      totalRelevance += agentTotal;
      relevanceCount += agentCount;
    }
  }
  
  if (relevanceCount > 0) {
    scores.agentRelevance.average = Math.round((totalRelevance / relevanceCount) * 10) / 10;
  }
  
  return scores;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCost(cost: number): string {
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(3)}`;
}

function generateReport(data: {
  sessionTrace: LangfuseTrace | null;
  agentStats: Map<string, AgentStats>;
  rounds: number;
  converged: boolean;
  totalCost: number;
  totalTokens: number;
  quality: QualityScores;
  traces: LangfuseTrace[];
}): string {
  const { sessionTrace, agentStats, rounds, converged, totalCost, totalTokens, quality, traces } = data;
  
  const sessionId = sessionTrace?.id?.slice(0, 8) || "unknown";
  const topic = sessionTrace?.metadata?.topic || "Unknown";
  const date = sessionTrace?.timestamp ? new Date(sessionTrace.timestamp).toLocaleDateString() : "Unknown";
  
  // Sort agents by total cost descending
  const sortedAgents = Array.from(agentStats.values()).sort((a, b) => b.totalCost - a.totalCost);
  
  let md = "";
  
  md += `╔═══════════════════════════════════════════════════════════════╗\n`;
  md += `║  COUNCIL ANALYSIS REPORT                                       ║\n`;
  md += `╠═══════════════════════════════════════════════════════════════╣\n`;
  md += `║  Session: ${sessionId.padEnd(52)} ║\n`;
  md += `║  Topic: ${topic.padEnd(55)} ║\n`;
  md += `║  Date: ${date.padEnd(56)} ║\n`;
  md += `║  Rounds: ${rounds} | Converged: ${converged ? "Yes" : "No"} | Traces: ${traces.length} | Total Cost: ${formatCost(totalCost)} | Tokens: ${totalTokens.toLocaleString()}\n`;
  md += `╠═══════════════════════════════════════════════════════════════╣\n`;
  md += `║  MODEL PERFORMANCE                                              ║\n`;
  md += `║  ──────────────────────────────────────────────────────────     ║\n`;
  md += `║  Agent            Model                    Tokens   Cost     Lat  ║\n`;
  md += `║  ──────────────────────────────────────────────────────────     ║\n`;
  
  for (const stats of sortedAgents) {
    const agentName = stats.agent.padEnd(12);
    const modelName = stats.model.padEnd(22);
    const tokens = stats.totalTokens.toLocaleString().padStart(7);
    const cost = formatCost(stats.totalCost).padStart(8);
    const lat = formatDuration(stats.avgLatencyMs).padStart(5);
    const warning = stats.avgLatencyMs > 5000 ? " ⚠ SLOW" : stats.errors > 0 ? " ⚠ ERR" : "";
    md += `║  ${agentName} ${modelName} ${tokens} ${cost} ${lat}${warning}\n`;
  }
  
  md += `╠═══════════════════════════════════════════════════════════════╣\n`;
  md += `║  QUALITY SCORES (LLM Judge)                                     ║\n`;
  md += `║  ──────────────────────────────────────────────────────────     ║\n`;
  
  const cs = quality.chairSummary;
  md += `║  Chair Summary:  Clarity ${cs.clarity} | Complete ${cs.completeness} | Action ${cs.actionability} | Neutral ${cs.neutrality}\n`;
  md += `║    └─ ${cs.reasoning.slice(0, 60)}\n`;
  
  const pc = quality.planCoherence;
  md += `║  Plan Coherence: Struct ${pc.structure} | Spec ${pc.specificity} | Consist ${pc.consistency} | Feas ${pc.feasibility}\n`;
  md += `║    └─ ${pc.reasoning.slice(0, 60)}\n`;
  
  const ar = quality.agentRelevance;
  md += `║  Agent Relevance: Avg ${ar.average}/5`;
  if (Object.keys(ar.byAgent).length > 0) {
    md += ` (${Object.entries(ar.byAgent).map(([a, s]) => `${a}:${s}`).join(", ")})`;
  }
  md += `\n`;
  
  md += `╠═══════════════════════════════════════════════════════════════╣\n`;
  md += `║  RECOMMENDATIONS                                                ║\n`;
  md += `║  ──────────────────────────────────────────────────────────     ║\n`;
  
  const recommendations: string[] = [];
  
  // Slow agents
  for (const stats of sortedAgents) {
    if (stats.avgLatencyMs > 5000) {
      recommendations.push(`⚠ ${stats.agent} (${stats.model}): ${formatDuration(stats.avgLatencyMs)} avg latency — consider faster model`);
    }
    if (stats.errors > 0) {
      recommendations.push(`⚠ ${stats.agent}: ${stats.errors} error(s) — check reliability`);
    }
  }
  
  // Low relevance
  for (const [agent, score] of Object.entries(ar.byAgent)) {
    if (score < 3.0) {
      recommendations.push(`⚠ ${agent} relevance low (${score}/5) — review persona/prompt`);
    }
  }
  
  // Cost outliers
  const maxCost = Math.max(...sortedAgents.map(s => s.totalCost));
  for (const stats of sortedAgents) {
    if (stats.totalCost > maxCost * 0.5 && sortedAgents.length > 1) {
      recommendations.push(`💰 ${stats.agent} (${stats.model}) costs ${formatCost(stats.totalCost)} (${((stats.totalCost/totalCost)*100).toFixed(0)}% of total) — evaluate if value matches cost`);
    }
  }
  
  // Chair quality
  if (cs.clarity < 3.5 || cs.completeness < 3.5) {
    recommendations.push(`📝 Chair summary quality could improve (Clarity: ${cs.clarity}, Complete: ${cs.completeness})`);
  }
  
  // Plan quality
  if (pc.specificity < 3.5) {
    recommendations.push(`📋 Plan specificity low (${pc.specificity}/5) — Chair may need guidance on concrete outputs`);
  }
  
  if (recommendations.length === 0) {
    recommendations.push("✅ All metrics look good!");
  }
  
  for (const rec of recommendations) {
    md += `║  ${rec.padEnd(60)} ║\n`;
  }
  
  md += `╚═══════════════════════════════════════════════════════════════╝\n`;
  
  // Add detail section
  md += `\n## Detailed Agent Relevance\n\n`;
  for (const detail of ar.details) {
    md += `- ${detail}\n`;
  }
  
  md += `\n## Chair Summary Reasoning\n${cs.reasoning}\n`;
  md += `\n## Plan Coherence Reasoning\n${pc.reasoning}\n`;
  
  return md;
}

function generateJSON(data: any): string {
  return JSON.stringify(data, null, 2);
}

async function main() {
  console.log("🔍 Quorum Council Analyzer\n");
  
  checkCredentials();
  
  const { sessionId, outputFormat } = parseArgs();
  
  console.log(`Fetching traces${sessionId ? ` for session ${sessionId}` : " (latest)"}...`);
  const traces = await fetchTraces(sessionId);
  
  if (traces.length === 0) {
    console.log("No council traces found.");
    if (sessionId) {
      console.log(`Try without --session to see all sessions, or check session ID.`);
    }
    process.exit(0);
  }
  
  console.log(`Found ${traces.length} trace(s). Analyzing...`);
  
  // If no session specified, use the most recent session trace
  let targetTraces = traces;
  if (!sessionId) {
    const sessionTraces = traces.filter(t => t.name === "council-session");
    if (sessionTraces.length > 0) {
      const latestSession = sessionTraces[0];
      const sessionId = latestSession.metadata?.sessionId || latestSession.id;
      console.log(`Using latest session: ${sessionId}`);
      targetTraces = await fetchTraces(sessionId);
    }
  }
  
  // Fetch full details for each trace
  const detailedTraces: LangfuseTrace[] = [];
  for (const trace of targetTraces) {
    const details = await fetchTraceDetails(trace.id);
    if (details) detailedTraces.push(details);
  }
  
  console.log(`Fetched details for ${detailedTraces.length} traces. Computing stats...`);
  
  const analysis = analyzeSession(detailedTraces);
  
  console.log("Running LLM judge evaluations...");
  const quality = await evaluateQuality(analysis.sessionTrace!, detailedTraces);
  
  const reportData = { ...analysis, quality, traces: detailedTraces };
  
  const report = outputFormat === "json" 
    ? generateJSON(reportData)
    : generateReport(reportData);
  
  console.log("\n" + "=".repeat(64));
  console.log(report);
  console.log("=".repeat(64));
  
  // Save to file
  const outputDir = join(__dirname, "..", "analysis");
  if (!existsSync(outputDir)) {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(outputDir, { recursive: true });
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const sessionTag = sessionId || "latest";
  const ext = outputFormat === "json" ? "json" : "md";
  const filename = `council-analysis-${sessionTag}-${timestamp}.${ext}`;
  const filepath = join(outputDir, filename);
  
  writeFileSync(filepath, report);
  console.log(`\n📄 Report saved to: ${filepath}`);
}

main().catch(e => {
  console.error("❌ Fatal error:", e);
  process.exit(1);
});