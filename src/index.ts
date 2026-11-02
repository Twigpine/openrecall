/**
 * openrecall server entrypoint — crypto-blind agent memory backend.
 *
 * The server never decrypts anything. Clients encrypt entries before upload
 * (see client/crypto.ts); the data at rest here is ciphertext. The request
 * logic lives in handler.ts so it can be tested without a socket.
 */

import { config } from './config.ts'
import { handleRequest } from './handler.ts'
import { getStore } from './store/index.ts'

const server = Bun.serve({
  port: config.port,
  idleTimeout: 60,
  // Hard cap on request body size, enforced by the runtime even when a client
  // omits or lies about content-length (the handler's content-length check is
  // just a faster, friendlier early-out).
  maxRequestBodySize: config.limits.maxBodyBytes,
  fetch: handleRequest,
})

console.log(
  `[openrecall] listening on :${server.port} • store=${getStore().describe()} • ` +
    `auth=${config.auth.allowUnauthenticated ? 'OPEN(self-host)' : 'required'}`,
)
