import type { FastifyInstance } from 'fastify';
import {
  USER_PROFILE_MAX,
  UserProfileError,
  getUserProfile,
  setUserProfile,
} from '../services/user-profile.js';

// User profile (~/.pinloom/wiki/USER.md) — inlined into every system prompt.
// GET returns the current text + the cap; PUT replaces it.
export async function userProfileRoutes(app: FastifyInstance) {
  app.get('/api/user-profile', async () => ({
    profile: getUserProfile(),
    maxChars: USER_PROFILE_MAX,
  }));

  app.put<{ Body: { profile?: unknown } }>(
    '/api/user-profile',
    async (req, reply) => {
      try {
        const profile = await setUserProfile(req.body.profile);
        return { profile, maxChars: USER_PROFILE_MAX };
      } catch (err) {
        if (err instanceof UserProfileError) {
          reply.code(err.status);
          return { error: err.message };
        }
        throw err;
      }
    },
  );
}
