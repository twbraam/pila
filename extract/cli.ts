import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { extractTranscript } from './index';

const HELP = `Usage: npm run extract -- <video-url-or-id> [options]

Fetch YouTube captions and output the sentence-level Transcript as JSON.

Options:
  --lang, -l <code>   Exact caption language (default: en)
  --out, -o <file>    Write JSON to a UTF-8 file instead of stdout
  --timeout <ms>     Whole-request timeout in milliseconds (default: 30000)
  --help, -h         Show this help
`;

export async function runExtractCli(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      lang: { type: 'string', short: 'l', default: 'en' },
      out: { type: 'string', short: 'o' },
      timeout: { type: 'string', default: '30000' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (positionals.length !== 1) {
    throw new TypeError('Provide exactly one YouTube video URL or ID. Use --help for usage.');
  }
  if (values.out !== undefined && values.out.trim() === '') {
    throw new TypeError('--out must be a nonempty file path.');
  }
  const transcript = await extractTranscript(positionals[0]!, {
    lang: values.lang,
    timeoutMs: Number(values.timeout),
  });
  const json = `${JSON.stringify(transcript, null, 2)}\n`;
  if (values.out !== undefined) {
    await writeFile(values.out, json, 'utf8');
  } else {
    process.stdout.write(json);
  }
}
