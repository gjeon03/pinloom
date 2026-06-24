// On-disk home for built-in bots: ~/.pinloom/bots/<kind>/. Each bot keeps its
// machine config (e.g. schedule's config.json pointing at the journal vault)
// here — user-inspectable files, the same "memory on disk the user controls"
// convention as the wiki. The `home` arg is injectable so unit tests never
// touch the real ~/.pinloom.

import os from 'node:os';
import path from 'node:path';
import type { BotKind } from '@pinloom/shared';

export function getBotsRoot(home: string = os.homedir()): string {
  return path.join(home, '.pinloom', 'bots');
}

export function botHomeDir(kind: BotKind, home: string = os.homedir()): string {
  return path.join(getBotsRoot(home), kind);
}
