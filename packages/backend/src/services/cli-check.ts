import { spawn } from 'node:child_process';

export interface CliStatus {
  installed: boolean;
  version: string | null;
}

function probe(bin: string, arg = '--version'): Promise<CliStatus> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(bin, [arg], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ installed: false, version: null });
      return;
    }
    let out = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.on('error', () => resolve({ installed: false, version: null }));
    proc.on('close', (code) => {
      if (code === 0) resolve({ installed: true, version: out.trim() || null });
      else resolve({ installed: false, version: null });
    });
  });
}

export async function checkAgentClis(): Promise<{
  claude: CliStatus;
  codex: CliStatus;
}> {
  const [claude, codex] = await Promise.all([probe('claude'), probe('codex')]);
  return { claude, codex };
}
