import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../db/connection.js';
import {
  clearQueue,
  enqueueMessage,
  InvalidQueueContentError,
  listQueueItems,
  listSessionsWithQueuedItems,
  removeQueueItem,
  SessionNotFoundError,
} from './message-queue.js';

function seedSession(id: string, projectId = 'p1') {
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(
    'INSERT OR IGNORE INTO projects (id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(projectId, 'Test', '/tmp/t', now, now);
  db.prepare(
    'INSERT INTO sessions (id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
  ).run(id, projectId, now, now);
}

beforeEach(() => {
  const db = getDb();
  db.exec(`
    DELETE FROM message_queue;
    DELETE FROM messages;
    DELETE FROM sessions;
    DELETE FROM projects;
  `);
});

describe('enqueueMessage', () => {
  it('throws SessionNotFoundError for unknown session', () => {
    expect(() =>
      enqueueMessage({ sessionId: 'nope', content: 'x' }),
    ).toThrow(SessionNotFoundError);
  });

  it('throws InvalidQueueContentError on empty content', () => {
    seedSession('s1');
    expect(() => enqueueMessage({ sessionId: 's1', content: '   ' })).toThrow(
      InvalidQueueContentError,
    );
  });

  it('throws InvalidQueueContentError when content exceeds 200KB', () => {
    seedSession('s1');
    const oversized = 'x'.repeat(200 * 1024 + 1);
    expect(() =>
      enqueueMessage({ sessionId: 's1', content: oversized }),
    ).toThrow(InvalidQueueContentError);
  });

  it('persists a valid item and returns its row', () => {
    seedSession('s1');
    const item = enqueueMessage({
      sessionId: 's1',
      content: 'hello',
      model: 'claude-sonnet-4-6',
    });
    expect(item.content).toBe('hello');
    expect(item.model).toBe('claude-sonnet-4-6');
    expect(item.id).toBeTruthy();
  });
});

describe('removeQueueItem', () => {
  it('refuses to delete an item belonging to a different session', () => {
    seedSession('s1');
    seedSession('s2');
    const item = enqueueMessage({ sessionId: 's1', content: 'a' });

    // Pass s2 with s1's itemId — must NOT delete.
    const removed = removeQueueItem('s2', item.id);
    expect(removed).toBe(false);
    expect(listQueueItems('s1')).toHaveLength(1);
  });

  it('deletes when sessionId matches', () => {
    seedSession('s1');
    const item = enqueueMessage({ sessionId: 's1', content: 'a' });
    expect(removeQueueItem('s1', item.id)).toBe(true);
    expect(listQueueItems('s1')).toHaveLength(0);
  });
});

describe('clearQueue + listSessionsWithQueuedItems', () => {
  it('clearQueue removes every item for a session, leaves others alone', () => {
    seedSession('s1');
    seedSession('s2');
    enqueueMessage({ sessionId: 's1', content: 'a' });
    enqueueMessage({ sessionId: 's1', content: 'b' });
    enqueueMessage({ sessionId: 's2', content: 'c' });

    clearQueue('s1');
    expect(listQueueItems('s1')).toHaveLength(0);
    expect(listQueueItems('s2')).toHaveLength(1);
  });

  it('listSessionsWithQueuedItems returns each distinct session id', () => {
    seedSession('s1');
    seedSession('s2');
    enqueueMessage({ sessionId: 's1', content: 'a' });
    enqueueMessage({ sessionId: 's1', content: 'b' });
    enqueueMessage({ sessionId: 's2', content: 'c' });

    const ids = listSessionsWithQueuedItems().sort();
    expect(ids).toEqual(['s1', 's2']);
  });
});
