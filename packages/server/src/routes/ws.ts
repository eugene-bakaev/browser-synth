import type { FastifyInstance } from 'fastify';

export async function wsRoute(app: FastifyInstance) {
  app.get('/ws', { websocket: true }, (socket) => {
    app.log.info('ws client connected');
    socket.send(JSON.stringify({ type: 'hello' }));
    socket.on('message', (raw: Buffer) => {
      app.log.info({ raw: raw.toString() }, 'ws message');
    });
    socket.on('close', () => app.log.info('ws client disconnected'));
  });
}
