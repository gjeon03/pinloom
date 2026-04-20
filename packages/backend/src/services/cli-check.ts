import { spawn } from 'node:child_process';

export async function checkCli(): Promise<{ installed: boolean; version: string | null }> {
  return new Promise((resolve) => {
    const proc = spawn('claude', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.on('error', () => resolve({ installed: false, version: null }));
    proc.on('close', (code) => {
      if (code === 0) resolve({ installed: true, version: out.trim() || null });
      else resolve({ installed: false, version: null });
    });
  });
}
