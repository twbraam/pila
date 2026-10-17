import { access, mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { listLanguages } from 'youtube-transcript-plus';
import { assertTranscript, extractTranscript, parseVideoId } from '../extract';

interface ServerOptions {
  outputDirectory: string;
  extract?: typeof extractTranscript;
  languages?: typeof listLanguages;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined;
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(body)}\n`);
}

async function readRequest(request: IncomingMessage): Promise<{ url: string; lang?: string }> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'invalid_content_type', 'Send Content-Type: application/json.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size <= 16_384) chunks.push(buffer);
  }
  if (size > 16_384) throw new HttpError(413, 'request_too_large', 'Request body exceeds 16 KiB.');

  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON.');
  }
  if (
    typeof value !== 'object' || value === null || Array.isArray(value) ||
    !('url' in value) || typeof value.url !== 'string' ||
    Object.keys(value).some((key) => !['url', 'lang'].includes(key)) ||
    ('lang' in value && (typeof value.lang !== 'string' || value.lang.trim() === ''))
  ) {
    throw new HttpError(400, 'invalid_request', 'Expected { "url": "YouTube URL", "lang"?: "caption language" }.');
  }
  try {
    parseVideoId(value.url);
    if ('lang' in value && typeof value.lang === 'string') Intl.getCanonicalLocales(value.lang);
  } catch (error) {
    throw new HttpError(400, 'invalid_request', error instanceof Error ? error.message : String(error));
  }
  return 'lang' in value && typeof value.lang === 'string'
    ? { url: value.url, lang: value.lang } : { url: value.url };
}

/** Shared local server. Only the server chooses output paths; files are create-only. */
export function createPilaServer(options: ServerOptions) {
  const outputDirectory = resolve(options.outputDirectory);
  const extract = options.extract ?? extractTranscript;
  const languages = options.languages ?? listLanguages;

  return createServer(async (request, response) => {
    try {
      if (request.url === '/health' && request.method === 'GET') {
        respond(response, 200, { status: 'ok' });
        return;
      }
      if (request.url !== '/extract') throw new HttpError(404, 'not_found', 'Use POST /extract.');
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        throw new HttpError(405, 'method_not_allowed', 'Use POST /extract.');
      }
      const input = await readRequest(request);
      const videoId = parseVideoId(input.url);
      const destination = join(outputDirectory, `${videoId}.json`);
      try {
        await access(destination);
        throw new HttpError(409, 'transcript_exists', `${videoId}.json already exists; nothing was overwritten.`);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }

      const signal = AbortSignal.timeout(30_000);
      const lang = input.lang ?? (await languages(videoId, { signal }))[0]?.languageCode;
      if (!lang) throw new HttpError(422, 'captions_unavailable', 'No caption track is available.');
      const transcript = await extract(input.url, { lang, signal });
      assertTranscript(transcript);
      if (transcript.videoId !== videoId || transcript.sentences.length === 0) {
        throw new HttpError(502, 'invalid_transcript', 'Caption provider returned an invalid transcript.');
      }
      await mkdir(outputDirectory, { recursive: true });
      // Exclusive creation also prevents replacement if concurrent requests race.
      await writeFile(destination, `${JSON.stringify(transcript, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      respond(response, 201, {
        videoId, language: lang, file: destination, sentenceCount: transcript.sentences.length,
      });
    } catch (error) {
      if (error instanceof HttpError) {
        respond(response, error.status, { error: { code: error.code, message: error.message } });
      } else if (errorCode(error) === 'EEXIST') {
        respond(response, 409, { error: { code: 'transcript_exists', message: 'Transcript already exists; nothing was overwritten.' } });
      } else {
        const name = error instanceof Error ? error.name : 'Error';
        const message = error instanceof Error ? error.message : String(error);
        const status = name === 'TimeoutError' ? 504 : errorCode(error) ? 500 : 502;
        respond(response, status, { error: { code: name, message } });
      }
    }
  });
}
