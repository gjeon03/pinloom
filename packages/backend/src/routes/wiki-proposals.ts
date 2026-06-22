import type { FastifyInstance, FastifyReply } from 'fastify';
import type { WikiProposalStatus } from '@pinloom/shared';
import {
  ProposalError,
  acceptProposal,
  getProposalDiff,
  listProposals,
  rejectProposal,
} from '../services/wiki-proposals.js';
import { CurationError } from '../services/wiki-curation.js';
import { GardenerError, runGardener } from '../services/wiki-gardener.js';

// Map a thrown error to an HTTP reply. ProposalError carries its own status;
// a CurationError (e.g. malformed markers) is a 400; anything else re-throws.
function fail(reply: FastifyReply, err: unknown): { error: string } {
  if (err instanceof ProposalError) {
    reply.code(err.status);
    return { error: err.message };
  }
  if (err instanceof CurationError) {
    reply.code(400);
    return { error: err.message };
  }
  throw err;
}

// Wiki gardener proposal review API (knowledge-system v2 Phase 2a). Read the
// inbox, inspect a proposal's diff, accept (applies via the curation
// primitives) or reject. Proposals are authored by the gardener (Phase 2b).
export async function wikiProposalRoutes(app: FastifyInstance) {
  const STATUSES: WikiProposalStatus[] = ['pending', 'applied', 'rejected'];
  app.get<{ Querystring: { status?: string } }>(
    '/api/wiki/proposals',
    async (req, reply) => {
      const { status } = req.query;
      if (status !== undefined && !STATUSES.includes(status as WikiProposalStatus)) {
        reply.code(400);
        return { error: `invalid status: ${status}` };
      }
      return listProposals(status as WikiProposalStatus | undefined);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/wiki/proposals/:id',
    async (req, reply) => {
      try {
        return await getProposalDiff(req.params.id);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/wiki/proposals/:id/accept',
    async (req, reply) => {
      try {
        return await acceptProposal(req.params.id);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/wiki/proposals/:id/reject',
    async (req, reply) => {
      try {
        return await rejectProposal(req.params.id);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // Run a gardening pass: the agent reads the wiki and stages proposals (it
  // never writes pages). Returns how many were staged / skipped. A single
  // in-flight run at a time — a concurrent request gets 409 (avoids duplicate
  // inbox entries + double LLM cost).
  let gardening = false;
  app.post('/api/wiki/garden', async (_req, reply) => {
    if (gardening) {
      reply.code(409);
      return { error: 'a gardening pass is already running' };
    }
    gardening = true;
    try {
      const { created, skipped, truncated } = await runGardener();
      return { created: created.length, skipped, truncated };
    } catch (err) {
      if (err instanceof GardenerError) {
        reply.code(502);
        return { error: err.message };
      }
      return fail(reply, err);
    } finally {
      gardening = false;
    }
  });
}
