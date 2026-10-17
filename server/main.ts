import { resolve } from 'node:path';
import { createPilaServer } from './index';

const port = Number(process.env.PORT ?? '3000');
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new TypeError('PORT must be an integer between 0 and 65535.');
}
const outputDirectory = resolve(process.env.TRANSCRIPT_DIR ?? 'examples/transcripts');
const server = createPilaServer({ outputDirectory });
server.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') {
    console.log(`Pila server listening at http://127.0.0.1:${address.port}`);
    console.log(`JSON output directory: ${outputDirectory}`);
  }
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close());
}
