// Import a database export file (see db-export.ts) into the local DB.
// Conflict policy: skip existing project / session ids. Re-running an
// import is therefore safe and idempotent. The only way to overwrite
// existing rows is to delete them manually first; that constraint is
// deliberate — we'd rather a careless click leave the local state
// intact than have it silently replaced.

import { getDb } from '../db/connection.js';
import type { DbExportFile } from './db-export.js';

export class DbImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbImportError';
  }
}

export interface DbImportSummary {
  projectsImported: number;
  projectsSkipped: number;
  sessionsImported: number;
  sessionsSkipped: number;
  messagesImported: number;
}

function isDbExport(value: unknown): value is DbExportFile {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj.kind === 'pinloom-db-export' &&
    typeof obj.schemaVersion === 'number' &&
    Array.isArray(obj.projects)
  );
}

export function importDbFile(rawJson: string): DbImportSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new DbImportError('File is not valid JSON');
  }
  if (!isDbExport(parsed)) {
    throw new DbImportError(
      'File is not a pinloom database export (missing kind/schemaVersion/projects)',
    );
  }

  const data = parsed;
  const db = getDb();
  const summary: DbImportSummary = {
    projectsImported: 0,
    projectsSkipped: 0,
    sessionsImported: 0,
    sessionsSkipped: 0,
    messagesImported: 0,
  };

  const existingProject = db.prepare('SELECT 1 FROM projects WHERE id = ?');
  const insertProject = db.prepare(
    `INSERT INTO projects (id, name, cwd, group_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const existingSession = db.prepare('SELECT 1 FROM sessions WHERE id = ?');
  const insertSession = db.prepare(
    `INSERT INTO sessions
       (id, project_id, plan_id, agent, agent_session_id, claude_session_id,
        title, next_image_number, last_synced_message_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO messages
       (id, session_id, plan_item_id, role, content, tool_use,
        pinned, pin_title, pinned_at, source_message_id, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Wrap the entire import in one transaction — a partial failure
  // leaving the DB half-populated is worse than rejecting the whole
  // file. better-sqlite3 rolls back on thrown error inside the closure.
  const tx = db.transaction(() => {
    for (const p of data.projects) {
      if (existingProject.get(p.id) !== undefined) {
        summary.projectsSkipped += 1;
      } else {
        insertProject.run(
          p.id,
          p.name,
          p.cwd,
          p.groupId,
          p.createdAt,
          p.updatedAt,
        );
        summary.projectsImported += 1;
      }

      for (const s of p.sessions) {
        if (existingSession.get(s.id) !== undefined) {
          summary.sessionsSkipped += 1;
          continue;
        }
        insertSession.run(
          s.id,
          s.projectId,
          s.planId,
          s.agent,
          s.agentSessionId,
          // claude_session_id is a deprecated mirror — default to the
          // new field for safety on older schemas.
          s.agentSessionId,
          s.title,
          s.nextImageNumber,
          s.lastSyncedMessageId,
          s.createdAt,
          s.updatedAt,
        );
        summary.sessionsImported += 1;
        for (const m of s.messages) {
          insertMessage.run(
            m.id,
            s.id,
            m.planItemId,
            m.role,
            m.content,
            m.toolUse,
            m.pinned ? 1 : 0,
            m.pinTitle,
            m.pinnedAt,
            m.sourceMessageId,
            m.model,
            m.createdAt,
          );
          summary.messagesImported += 1;
        }
      }
    }
  });
  tx();

  return summary;
}
