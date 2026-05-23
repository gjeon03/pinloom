// Database export — dumps every project + session + message into a
// single self-describing JSON blob the operator downloads to their
// laptop. The format is the same shape backup-export.ts used to write
// per-session, just bundled into one document so the download surface
// can be a single file picker on either end.

import { getDb } from '../db/connection.js';

const SCHEMA_VERSION = 2;

interface ProjectRow {
  id: string;
  name: string;
  cwd: string;
  group_id: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  id: string;
  project_id: string;
  plan_id: string | null;
  agent: string;
  agent_session_id: string | null;
  title: string | null;
  next_image_number: number;
  last_synced_message_id: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  plan_item_id: string | null;
  role: string;
  content: string;
  tool_use: string | null;
  pinned: number;
  pin_title: string | null;
  pinned_at: string | null;
  source_message_id: string | null;
  model: string | null;
  created_at: string;
}

export interface DbExportProject {
  id: string;
  name: string;
  cwd: string;
  groupId: string | null;
  createdAt: string;
  updatedAt: string;
  sessions: DbExportSession[];
}

export interface DbExportSession {
  id: string;
  projectId: string;
  planId: string | null;
  agent: string;
  agentSessionId: string | null;
  title: string | null;
  nextImageNumber: number;
  lastSyncedMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  messages: DbExportMessage[];
}

export interface DbExportMessage {
  id: string;
  planItemId: string | null;
  role: string;
  content: string;
  toolUse: string | null;
  pinned: boolean;
  pinTitle: string | null;
  pinnedAt: string | null;
  sourceMessageId: string | null;
  model: string | null;
  createdAt: string;
}

export interface DbExportFile {
  schemaVersion: number;
  kind: 'pinloom-db-export';
  exportedAt: string;
  counts: {
    projects: number;
    sessions: number;
    messages: number;
  };
  projects: DbExportProject[];
}

export function buildDbExport(): DbExportFile {
  const db = getDb();
  const projectRows = db
    .prepare('SELECT * FROM projects ORDER BY id')
    .all() as ProjectRow[];

  const projects: DbExportProject[] = [];
  let sessionCount = 0;
  let messageCount = 0;

  for (const p of projectRows) {
    const sessionRows = db
      .prepare(
        'SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at ASC',
      )
      .all(p.id) as SessionRow[];

    const sessions: DbExportSession[] = sessionRows.map((s) => {
      const messages = db
        .prepare(
          'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC',
        )
        .all(s.id) as MessageRow[];
      messageCount += messages.length;
      return {
        id: s.id,
        projectId: s.project_id,
        planId: s.plan_id,
        agent: s.agent,
        agentSessionId: s.agent_session_id,
        title: s.title,
        nextImageNumber: s.next_image_number,
        lastSyncedMessageId: s.last_synced_message_id,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        messages: messages.map((m) => ({
          id: m.id,
          planItemId: m.plan_item_id,
          role: m.role,
          content: m.content,
          toolUse: m.tool_use,
          pinned: m.pinned === 1,
          pinTitle: m.pin_title,
          pinnedAt: m.pinned_at,
          sourceMessageId: m.source_message_id,
          model: m.model,
          createdAt: m.created_at,
        })),
      };
    });

    sessionCount += sessions.length;
    projects.push({
      id: p.id,
      name: p.name,
      cwd: p.cwd,
      groupId: p.group_id,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      sessions,
    });
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'pinloom-db-export',
    exportedAt: new Date().toISOString(),
    counts: {
      projects: projectRows.length,
      sessions: sessionCount,
      messages: messageCount,
    },
    projects,
  };
}
