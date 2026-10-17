import { runExtractCli } from './cli';

runExtractCli().catch((error: unknown) => {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`Extract failed: ${detail}`);
  process.exitCode = 1;
});
