import './loadEnv.js';
import { buildServer } from './server.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';

const app = buildServer();
app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
