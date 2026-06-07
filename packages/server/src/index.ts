import './loadEnv.js';
import { startOtel, shutdownOtel } from './otel/sdk.js';
import { buildServer } from './server.js';
import { installProcessSafetyNet } from './processSafetyNet.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';

// Must run before buildServer() creates the Fastify instance: @fastify/otel
// subscribes to the 'fastify.initialization' diagnostics channel inside
// sdk.start(), and only instances created after that subscription are traced.
startOtel();

const app = buildServer();

// Keep a transient DB/connection rejection from crash-looping the server.
// porsager/postgres can emit an unhandled rejection on a fatal pooler error
// that no call site can await; without this the process dies and Render
// restarts it into the same cold-start failure. See processSafetyNet.
installProcessSafetyNet((msg, ctx) => app.log.error(ctx ?? {}, msg));

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// Graceful shutdown: app.close() runs the onClose hook (flushes dirty rooms to
// the SessionStore) before the process exits. Render sends SIGTERM on redeploy.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app
      .close()
      .then(() => shutdownOtel())
      .then(() => process.exit(0))
      .catch((err) => {
        app.log.error(err);
        process.exit(1);
      });
  });
}
