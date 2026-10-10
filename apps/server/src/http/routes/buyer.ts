import {
  type BuyerApiDeps,
  chatBodySchema,
  chatResponseSchema,
  handleChatCompletion,
} from '../../buyer-api/chat-completions.js';
import type { Router } from '../router.js';

export function registerBuyerRoutes(router: Router, deps: BuyerApiDeps): void {
  router.add({
    action: 'buyer.chat_completions',
    summary: 'OpenAI-compatible chat completion (non-streaming). Supports Idempotency-Key.',
    tags: ['buyer-api'],
    apiKeyScope: 'chat',
    body: chatBodySchema,
    response: chatResponseSchema,
    errors: [400, 402, 404, 409, 410, 413, 429, 500, 502, 503, 504],
    handler: ({ req, reply, principal, body }) => {
      if (principal.via !== 'api_key') throw new Error('unreachable: API key route');
      return handleChatCompletion(deps, {
        req,
        reply,
        buyerId: principal.userId,
        apiKeyId: principal.apiKey.apiKeyId,
        body,
      });
    },
  });
}
