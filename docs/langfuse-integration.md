# Langfuse Integration for Quorum

This document describes the Langfuse observability integration for the Quorum engine.

## Overview

Quorum can trace channels and council sessions to [Langfuse](https://langfuse.com). It's off unless you set Langfuse keys. This provides visibility into:

- **Channels** - every member turn and support-role call (floor, scribe, Chair, assistant), grouped by channel
- **Council sessions** - Full conversation flow with session grouping
- **Rounds** - Each council round as a traced span
- **Agent turns** - Individual LLM calls with token usage, costs, and responses
- **Tool calls** - CLI tool invocations during agent turns
- **Errors** - Failed turns and transport errors
- **Usage metrics** - Token counts and cost tracking

## Architecture

The integration has two layers:

### 1. Mastra Workflow Tracing (Automatic)

The council workflow uses Mastra's `@mastra/langfuse` integration which automatically traces:
- Workflow execution
- Step (round) execution
- Agent runs within the workflow
- Suspend/resume cycles

### 2. Engine-Level Tracing (Custom)

The `QuorumTracing` class provides detailed tracing for:
- Session lifecycle (start/end)
- Round planning and execution
- Individual agent turns with prompts and responses
- Tool calls within turns
- Token usage and costs from CLI transports
- Human interjections

## What gets sent

When tracing is on, Quorum sends this to your Langfuse project (Langfuse Cloud, unless `LANGFUSE_BASE_URL` points at your own server):

- the first 2,000 characters of each prompt, which can include your project's code, channel transcripts and private messages between members
- the first 4,000 characters of each reply
- token counts and costs, agent and model names, and the channel or session id and topic
- for council sessions, your login name (`$USER`) as the user id

Point it at a self-hosted Langfuse if your project or transcripts are private. With no keys set, nothing is sent and no exporter is created.

## Setup

### 1. Create a Langfuse Project

1. Sign up at [cloud.langfuse.com](https://cloud.langfuse.com) or deploy self-hosted
2. Create a new project
3. Go to Settings → API Keys and create a new key pair

### 2. Configure Environment Variables

Export these in the shell that starts Quorum (Quorum doesn't read `.env` files):

```bash
# Required for tracing
LANGFUSE_PUBLIC_KEY=pk-lf-xxxxxxxxxxxx
LANGFUSE_SECRET_KEY=sk-lf-xxxxxxxxxxxx
LANGFUSE_BASE_URL=https://cloud.langfuse.com  # Or your self-hosted URL

# Optional: for release tracking
GIT_COMMIT=abc123def456
```

### 3. Run Quorum

The tracing is automatically enabled when the environment variables are set:

```bash
# Headless council run
pnpm -C engine run --topic "Design a new feature"

# Or via the TUI
pnpm tui
```

## Trace Structure

### Channels

Each CLI call in a channel is its own trace, named `channel:<channel name>`, with the channel id as its Langfuse session. So the **Sessions** view shows one channel's calls together, and a channel that runs for weeks never holds one span open. Each trace is one generation named `member-<id>` or `support-<role>`, tagged `quorum`, `channel`, the role and the agent. Aborted and failed turns are marked `ERROR`.

### Council sessions

Council sessions are organized as follows:

```
council-session (agent)
├── round-1 (span)
│   ├── turn-agent-1 (generation)
│   │   ├── tool-search (tool)
│   │   └── tool-read (tool)
│   ├── turn-agent-2 (generation)
│   └── turn-chair (generation)
├── round-2 (span)
│   └── ...
└── interjection-human→agent (generation)
```

### Observation Types

| Operation | Observation Type | Description |
|-----------|------------------|-------------|
| Council Session | `agent` | Root trace for entire session |
| Round | `span` | Each council round |
| Agent Turn | `generation` | LLM call with prompt/response |
| Tool Call | `tool` | CLI tool invocation |
| Human Interjection | `generation` | Human-to-agent message |

### Key Attributes

Each trace includes:

- **sessionId** - Quorum session ID for grouping
- **userId** - System user (from `$USER` or `$USERNAME`)
- **tags** - `["quorum", "council"]` plus operation-specific tags
- **metadata** - Round number, agent ID, topic, config
- **usageDetails** - Token counts (prompt, completion, total)
- **costDetails** - Cost in USD (when reported by CLI)

## Viewing Traces

1. Open your Langfuse dashboard
2. Go to **Traces** to see individual sessions
3. Use **Sessions** view to see grouped conversations
4. Filter by tags: `quorum`, `council`, `round`, `turn`, `agent`, `tool`
5. Use **Dashboard** for cost/usage analytics

## Configuration Options

### Realtime vs Batch Mode

The Mastra workflow exporter supports two modes:

```typescript
// In workflows/council.ts
new LangfuseExporter({
  realtime: process.env.NODE_ENV === "development",  // Immediate flush in dev
  // realtime: false  // Batch mode for production (default)
})
```

### Custom Trace Metadata

Add custom metadata to traces via the engine options:

```typescript
const engine = new Engine({
  // ... other options
  // Custom tracing instance with additional config
  tracing: new QuorumTracing({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
    environment: "production",
    release: "v1.2.3",
  }),
});
```

## Best Practices

Following [Langfuse best practices](https://langfuse.com/docs/observability/best-practices):

1. **Meaningful trace names** - Uses descriptive names like `council-session`, `round-1`, `turn-agent-1`
2. **Proper nesting** - Turns nest under rounds, tools nest under turns
3. **Model tracking** - Records CLI transport as model name
4. **Token/cost tracking** - Captures usage from transport responses
5. **Session grouping** - Uses Quorum session ID as Langfuse session ID
6. **Error recording** - Failed turns show as ERROR level with stack traces
7. **Input/output** - Prompts and responses captured (truncated for readability)
8. **Metadata over names** - Dynamic values in metadata, not trace names

## Troubleshooting

### No traces appearing

1. Verify environment variables are set correctly
2. Check Langfuse project settings for correct API keys
3. Ensure `LANGFUSE_BASE_URL` matches your deployment (cloud vs self-hosted)
4. Spans are sent in batches; a session's last ones go out when it ends or the TUI closes

### Traces missing data

- **No token usage**: Some CLI transports don't report tokens; check transport implementation
- **No costs**: Costs only appear when CLI reports them or Langfuse calculates from model pricing
- **Truncated prompts/responses**: Large inputs/outputs are truncated to 2000/4000 chars

### Performance

- **Development**: Uses `realtime: true` for immediate visibility
- **Production**: Uses batch mode for better throughput
- **Flush on exit**: a session's trace ends and is flushed when the session ends or the TUI closes (after the channel is saved)

## Testing

Run the tracing tests:

```bash
cd engine && pnpm test -- test/tracing.test.ts
```

## Disabling Tracing

Tracing is automatically disabled when `LANGFUSE_PUBLIC_KEY` or `LANGFUSE_SECRET_KEY` are not set. No code changes needed.

To explicitly disable in tests or specific environments:

```typescript
const engine = new Engine({
  // ... other options
  tracing: new QuorumTracing({ publicKey: undefined, secretKey: undefined }),
});
```

## Related Files

- `engine/src/tracing.ts` - Core tracing implementation
- `engine/src/engine.ts` - Council engine integration
- `engine/src/room/room.ts` - Channel integration (`trace()`)
- `engine/src/workflows/council.ts` - Mastra workflow integration
- `engine/src/rpc/server.ts` - RPC server flush/shutdown
- `engine/src/cli.ts` - CLI flush on completion
- `engine/test/tracing.test.ts` - Unit tests