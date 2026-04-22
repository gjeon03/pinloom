import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { nanoid } from 'nanoid';
import type { Terminal } from '@pinloom/shared';
import { getDb } from '../db/connection.js';

interface TerminalRow {
  id: string;
  project_id: string;
  title: string | null;
  order_index: number;
  created_at: string;
  updated_at: string;
}

function toTerminal(row: TerminalRow): Terminal {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    orderIndex: row.order_index,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const activePtys = new Map<string, IPty>();

export function listTerminals(projectId: string): Terminal[] {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT * FROM terminals WHERE project_id = ? ORDER BY order_index ASC, created_at ASC',
    )
    .all(projectId) as TerminalRow[];
  return rows.map(toTerminal);
}

export function createTerminal(projectId: string, title?: string | null): Terminal {
  const db = getDb();
  const id = nanoid();
  const now = new Date().toISOString();
  const maxRow = db
    .prepare(
      'SELECT COALESCE(MAX(order_index), -1) AS max FROM terminals WHERE project_id = ?',
    )
    .get(projectId) as { max: number };
  const nextOrder = maxRow.max + 1;
  db.prepare(
    `INSERT INTO terminals (id, project_id, title, order_index, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, title ?? null, nextOrder, now, now);
  const row = db.prepare('SELECT * FROM terminals WHERE id = ?').get(id) as TerminalRow;
  return toTerminal(row);
}

export function renameTerminal(id: string, title: string | null): Terminal | null {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare('UPDATE terminals SET title = ?, updated_at = ? WHERE id = ?').run(
    title,
    now,
    id,
  );
  const row = db.prepare('SELECT * FROM terminals WHERE id = ?').get(id) as
    | TerminalRow
    | undefined;
  return row ? toTerminal(row) : null;
}

export function deleteTerminal(id: string): boolean {
  const pty = activePtys.get(id);
  if (pty) {
    try {
      pty.kill();
    } catch {
      // ignore
    }
    activePtys.delete(id);
  }
  const db = getDb();
  const result = db.prepare('DELETE FROM terminals WHERE id = ?').run(id);
  return result.changes > 0;
}

export function reorderTerminals(projectId: string, ids: string[]): Terminal[] {
  const db = getDb();
  const now = new Date().toISOString();
  const update = db.prepare(
    'UPDATE terminals SET order_index = ?, updated_at = ? WHERE id = ? AND project_id = ?',
  );
  const tx = db.transaction((list: string[]) => {
    list.forEach((id, i) => update.run(i, now, id, projectId));
  });
  tx(ids);
  return listTerminals(projectId);
}

interface TerminalContext {
  id: string;
  cwd: string;
}

function loadContext(terminalId: string): TerminalContext | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT t.id, p.cwd
       FROM terminals t
       JOIN projects p ON p.id = t.project_id
       WHERE t.id = ?`,
    )
    .get(terminalId) as { id: string; cwd: string } | undefined;
  return row ?? null;
}

export function attachOrSpawnPty(terminalId: string): IPty | null {
  const existing = activePtys.get(terminalId);
  if (existing) {
    console.log('[pty] reusing existing', terminalId, 'pid=', existing.pid);
    return existing;
  }
  const ctx = loadContext(terminalId);
  if (!ctx) {
    console.log('[pty] context not found for', terminalId);
    return null;
  }

  const shell = process.env.SHELL || '/bin/zsh';
  console.log('[pty] spawning', shell, 'in', ctx.cwd);
  try {
    const child = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: ctx.cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    console.log('[pty] spawned pid=', child.pid);

    activePtys.set(terminalId, child);

    child.onExit(({ exitCode, signal }) => {
      console.log('[pty] exit', terminalId, 'code=', exitCode, 'signal=', signal);
      if (activePtys.get(terminalId) === child) {
        activePtys.delete(terminalId);
      }
    });

    return child;
  } catch (err) {
    console.error('[pty] spawn failed:', err);
    return null;
  }
}

export function resizePty(terminalId: string, cols: number, rows: number) {
  const child = activePtys.get(terminalId);
  if (!child) return;
  try {
    child.resize(cols, rows);
  } catch {
    // ignore if PTY died mid-resize
  }
}
