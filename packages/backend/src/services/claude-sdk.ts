import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

// Use the same installed CLI as terminal sessions. The SDK's bundled CLI can
// lag behind the user's installation and resolve "default" to an older model.
export function query(input: Parameters<typeof sdkQuery>[0]): ReturnType<typeof sdkQuery> {
  return sdkQuery({
    ...input,
    options: {
      pathToClaudeCodeExecutable: process.env.PINLOOM_CLAUDE_BIN ?? 'claude',
      model: 'default',
      settingSources: ['user', 'project', 'local'],
      ...input.options,
    },
  });
}
