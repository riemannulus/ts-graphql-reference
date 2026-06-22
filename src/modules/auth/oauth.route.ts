import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { isDomainError } from '../../errors.js';
import type { OAuthService } from './oauth.service.js';
import { parseOAuthCallback, type OAuthCallbackQuery } from './oauth.value.js';

/**
 * Registers the Google OAuth routes — the example of a non-GraphQL HTTP surface.
 *
 * The handlers close over exactly one dependency, the `OAuthService`, handed in
 * at registration time. They never receive the `PrismaClient` or the GraphQL
 * per-request `Context`: GraphQL and REST share the same `services` container
 * (built once in the composition root, app.ts) but neither leaks its
 * request-scoped context into the other. The route reads only what Fastify
 * gives it — `req.query` — and delegates everything else to the service.
 */
export function registerGoogleOAuth(app: FastifyInstance, oauth: OAuthService): void {
  // Step 1 — begin the flow: redirect the browser to Google's consent screen.
  // With the provider left unimplemented (the stub), `startUrl` throws here and
  // Fastify maps the synchronous throw to a 500 — the same masked outcome the
  // callback's catch produces for an unexpected failure.
  app.get('/google/oauth', (_req, reply) => {
    // A real app persists this `state` (signed cookie / session) and checks it
    // on the callback to defend against CSRF; omitted here for brevity.
    const state = randomUUID();
    return reply.redirect(oauth.startUrl(state));
  });

  // Step 2 — the redirect_uri Google sends the browser back to after consent.
  // Typing the Querystring generic gives `req.query` the right shape, so it can
  // be handed straight to the (total) parser without an assertion.
  app.get<{ Querystring: OAuthCallbackQuery }>('/google/oauth/callback', async (req, reply) => {
    try {
      const callback = parseOAuthCallback(req.query);
      const user = await oauth.completeLogin(callback);
      // A real app would establish a session here (e.g. set a signed cookie);
      // we return the provisioned user so the wiring — request in, user created
      // via the user module, response out — is directly observable.
      return reply.send({ userId: user.id, email: user.email, status: user.status });
    } catch (error) {
      // The HTTP mirror of Yoga's maskError split (app.ts): expected domain
      // errors surface as 400s carrying their code; anything else is masked.
      if (isDomainError(error)) {
        return reply.status(400).send({ code: error.code, message: error.message });
      }
      req.log.error(error);
      return reply.status(500).send({ code: 'INTERNAL', message: 'Internal Server Error' });
    }
  });
}
