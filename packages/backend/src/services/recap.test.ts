import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb } from '../db/connection.js';
import { getProjectWikiSlugByProjectId } from './wiki-sync.js';
import { writeEntry } from './timeline/store.js';
import { answerOverCorpus, generateRecap, type RunRecap } from './recap.js';

const db = getDb();
const realHome = process.env.HOME;
let tmpHome: string;

beforeAll(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'pinloom-recap-'));
  process.env.HOME = tmpHome; // isolate timeline store reads
});
afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(tmpHome, { recursive: true, force: true });
});
beforeEach(() => {
  db.exec('DELETE FROM messages; DELETE FROM sessions; DELETE FROM projects;');
});

function captureRun(): { seen: () => string; run: RunRecap } {
  let s = '';
  return { seen: () => s, run: async (prompt) => ((s = prompt), '생성된 결과 [1]') };
}

describe('answerOverCorpus', () => {
  it('handles an empty question', async () => {
    expect((await answerOverCorpus(db, '   ')).answer).toContain('비어');
  });

  it('says nothing found when the corpus has no hits', async () => {
    const r = await answerOverCorpus(db, 'nonexistentkeyword', { runRecap: async () => 'x' });
    expect(r.sources).toEqual([]);
    expect(r.answer).toContain('찾지 못');
  });

  it('hydrates FULL message content (not the 160-char excerpt) into the prompt', async () => {
    db.prepare("INSERT INTO projects (id,name,cwd,created_at,updated_at) VALUES ('p','P','/tmp/p','t','t')").run();
    db.prepare("INSERT INTO sessions (id,project_id,title,created_at,updated_at) VALUES ('s','p','Sess','t','t')").run();
    const longContent =
      'billing 마이그레이션 라우팅을 분리한 이유는 결제 경로를 독립적으로 배포하기 위해서였다. ' +
      '대안으로 단일 모듈도 고려했지만 결합도가 높아 폐기했다. '.repeat(6);
    db.prepare(
      "INSERT INTO messages (id,session_id,role,content,created_at) VALUES ('m1','s','user',?,'2026-06-24T01:00:00Z')",
    ).run(longContent);
    const cap = captureRun();
    const r = await answerOverCorpus(db, 'billing', { runRecap: cap.run });
    // full content (well beyond 160 chars) reached the model
    expect(cap.seen()).toContain('대안으로 단일 모듈도 고려했지만');
    expect(cap.seen()).toContain('[1]');
    expect(r.sources[0]).toMatchObject({ n: 1, messageId: 'm1', sessionId: 's', projectName: 'P' });
    expect(r.answer).toContain('생성된 결과');
  });
});

describe('generateRecap', () => {
  it('returns empty for a range with no timeline entries', async () => {
    db.prepare("INSERT INTO projects (id,name,cwd,created_at,updated_at) VALUES ('p','P','/tmp/p','t','t')").run();
    const r = await generateRecap(db, {
      kind: 'portfolio',
      dateFrom: '2026-06-01',
      dateTo: '2026-06-30',
      runRecap: async () => 'should not be called',
    });
    expect(r).toEqual({ markdown: '', empty: true });
  });

  it('gathers timeline entries in range and feeds them to the model', async () => {
    db.prepare("INSERT INTO projects (id,name,cwd,created_at,updated_at) VALUES ('p','Demo','/tmp/demo','t','t')").run();
    const slug = getProjectWikiSlugByProjectId('p');
    writeEntry(slug, '2026-06-24', '# 6/24\n- 시맨틱 검색 작업');
    writeEntry(slug, '2026-05-01', '# 5/01\n- 범위 밖 작업'); // out of range
    const cap = captureRun();
    const r = await generateRecap(db, {
      kind: 'resume',
      dateFrom: '2026-06-01',
      dateTo: '2026-06-30',
      runRecap: cap.run,
    });
    expect(r.empty).toBe(false);
    expect(r.markdown).toContain('생성된 결과');
    expect(cap.seen()).toContain('시맨틱 검색 작업');
    expect(cap.seen()).not.toContain('범위 밖');
  });

  it('scopes to a single project when projectId is given', async () => {
    db.prepare("INSERT INTO projects (id,name,cwd,created_at,updated_at) VALUES ('a','A','/tmp/a','t','t')").run();
    db.prepare("INSERT INTO projects (id,name,cwd,created_at,updated_at) VALUES ('b','B','/tmp/b','t','t')").run();
    writeEntry(getProjectWikiSlugByProjectId('a'), '2026-06-24', 'alpha 작업');
    writeEntry(getProjectWikiSlugByProjectId('b'), '2026-06-24', 'beta 작업');
    const cap = captureRun();
    await generateRecap(db, {
      kind: 'portfolio',
      dateFrom: '2026-06-01',
      dateTo: '2026-06-30',
      projectId: 'a',
      runRecap: cap.run,
    });
    expect(cap.seen()).toContain('alpha 작업');
    expect(cap.seen()).not.toContain('beta 작업');
  });
});
