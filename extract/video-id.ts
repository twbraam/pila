import { VIDEO_ID_PATTERN } from '../shared/transcript';

/** Accept IDs and watch, short-link, shorts, embed, and live YouTube URLs. */
export function parseVideoId(input: string): string {
  const value = input.trim();
  if (VIDEO_ID_PATTERN.test(value)) return value;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Expected a YouTube video URL or an 11-character video ID.');
  }

  const host = url.hostname.toLowerCase();
  let id: string | undefined | null;
  if (url.protocol === 'https:' || url.protocol === 'http:') {
    if (host === 'youtu.be') {
      id = url.pathname.split('/')[1];
    } else if (
      host === 'youtube.com' ||
      host.endsWith('.youtube.com') ||
      host === 'youtube-nocookie.com' ||
      host.endsWith('.youtube-nocookie.com')
    ) {
      const [, route, pathId] = url.pathname.split('/');
      if (route === 'watch') id = url.searchParams.get('v');
      else if (route && ['shorts', 'embed', 'live'].includes(route)) id = pathId;
    }
  }

  if (!id || !VIDEO_ID_PATTERN.test(id)) {
    throw new TypeError('Expected a YouTube video URL or an 11-character video ID.');
  }
  return id;
}
