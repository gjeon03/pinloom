import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type {
  NotepadNode,
  ProjectNotepad,
  ProjectNotepadSummary,
} from '@pinloom/shared';
import { getDb } from '../db/connection.js';

interface NotepadRow {
  id: string;
  project_id: string;
  name: string;
  root: string;
  position: number;
  created_at: string;
  updated_at: string;
}

function toSummary(row: NotepadRow): ProjectNotepadSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toFull(row: NotepadRow): ProjectNotepad {
  return { ...toSummary(row), root: JSON.parse(row.root) as NotepadNode };
}

// Notes are plain text, so cap the request body well below the global 100MB
// limit, and bound the split tree's depth/size — an untrusted (or buggy)
// client shouldn't be able to force unbounded recursion or a giant row.
const NOTEPAD_BODY_LIMIT = 4 * 1024 * 1024;
const MAX_NODE_DEPTH = 64;
const MAX_NODES = 2000;

function isValidNode(
  value: unknown,
  depth = 0,
  counter = { n: 0 },
): value is NotepadNode {
  if (depth > MAX_NODE_DEPTH) return false;
  if (++counter.n > MAX_NODES) return false;
  if (!value || typeof value !== 'object') return false;
  const node = value as Record<string, unknown>;
  if (typeof node.id !== 'string') return false;
  if (node.kind === 'pane') return typeof node.content === 'string';
  if (node.kind === 'split') {
    if (node.dir !== 'row' && node.dir !== 'column') return false;
    if (!Array.isArray(node.children) || node.children.length < 1) return false;
    if (
      !Array.isArray(node.sizes) ||
      node.sizes.length !== node.children.length ||
      !node.sizes.every((s) => typeof s === 'number')
    ) {
      return false;
    }
    return node.children.every((c) => isValidNode(c, depth + 1, counter));
  }
  return false;
}

function emptyRoot(): NotepadNode {
  return { id: nanoid(), kind: 'pane', content: '' };
}

export async function projectNotepadRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/notepads',
    async (req) => {
      const rows = db
        .prepare(
          `SELECT * FROM project_notepads
           WHERE project_id = ?
           ORDER BY position ASC, created_at ASC`,
        )
        .all(req.params.projectId) as NotepadRow[];
      return rows.map(toSummary);
    },
  );

  app.post<{ Params: { projectId: string }; Body: { name?: string } }>(
    '/api/projects/:projectId/notepads',
    { bodyLimit: NOTEPAD_BODY_LIMIT },
    async (req, reply) => {
      const projectId = req.params.projectId;
      const project = db
        .prepare('SELECT id FROM projects WHERE id = ?')
        .get(projectId);
      if (!project) {
        reply.code(404);
        return { error: 'project not found' };
      }
      const id = nanoid();
      const now = new Date().toISOString();
      const maxRow = db
        .prepare(
          'SELECT COALESCE(MAX(position), -1) AS max FROM project_notepads WHERE project_id = ?',
        )
        .get(projectId) as { max: number };
      const name = req.body?.name?.trim() || 'Notepad';
      db.prepare(
        `INSERT INTO project_notepads (id, project_id, name, root, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, projectId, name, JSON.stringify(emptyRoot()), maxRow.max + 1, now, now);
      const row = db
        .prepare('SELECT * FROM project_notepads WHERE id = ?')
        .get(id) as NotepadRow;
      return toFull(row);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/notepads/:id',
    async (req, reply) => {
      const row = db
        .prepare('SELECT * FROM project_notepads WHERE id = ?')
        .get(req.params.id) as NotepadRow | undefined;
      if (!row) {
        reply.code(404);
        return { error: 'notepad not found' };
      }
      return toFull(row);
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { name?: unknown; root?: unknown };
  }>('/api/notepads/:id', { bodyLimit: NOTEPAD_BODY_LIMIT }, async (req, reply) => {
    const row = db
      .prepare('SELECT * FROM project_notepads WHERE id = ?')
      .get(req.params.id) as NotepadRow | undefined;
    if (!row) {
      reply.code(404);
      return { error: 'notepad not found' };
    }
    const body = req.body ?? {};
    let name = row.name;
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        reply.code(400);
        return { error: 'name must be a non-empty string' };
      }
      name = body.name.trim();
    }
    let root = row.root;
    if (body.root !== undefined) {
      if (!isValidNode(body.root)) {
        reply.code(400);
        return { error: 'root must be a valid notepad node' };
      }
      root = JSON.stringify(body.root);
    }
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE project_notepads SET name = ?, root = ?, updated_at = ? WHERE id = ?`,
    ).run(name, root, now, req.params.id);
    const updated = db
      .prepare('SELECT * FROM project_notepads WHERE id = ?')
      .get(req.params.id) as NotepadRow;
    return toFull(updated);
  });

  app.delete<{ Params: { id: string } }>(
    '/api/notepads/:id',
    async (req) => {
      db.prepare('DELETE FROM project_notepads WHERE id = ?').run(
        req.params.id,
      );
      return { ok: true as const };
    },
  );
}
