import type { FastifyInstance } from 'fastify';
import type { RawData } from 'ws';

export async function wsRoute(app: FastifyInstance) {
  app.get('/ws', { websocket: true }, (socket) => {
    app.log.info('ws client connected');
    socket.send(JSON.stringify({ type: 'hello' }));
    socket.on('message', (raw: RawData) => {
      app.log.info({ raw: raw.toString() }, 'ws message');
    });
    socket.on('close', () => app.log.info('ws client disconnected'));
  });
}
