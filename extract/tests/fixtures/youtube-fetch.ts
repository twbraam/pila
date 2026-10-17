// Offline provider responses for CLI integration tests. Never imported by production code.
const mode = process.env.PILA_TEST_CAPTION_MODE ?? 'ok';
globalThis.fetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.pathname === '/watch') {
    return new Response('<html>"INNERTUBE_API_KEY":"offline-fixture"</html>');
  }
  if (url.pathname === '/youtubei/v1/player') {
    return Response.json({
      playabilityStatus: { status: 'OK' },
      ...(mode === 'disabled' ? {} : {
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [{ languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext' }],
          },
        },
      }),
    });
  }
  if (url.pathname === '/api/timedtext') {
    if (mode === 'rate-limited') return new Response('', { status: 429 });
    if (mode === 'empty') return new Response('<transcript/>');
    return new Response(`<transcript>
      <text start="0" dur="2">A claim</text>
      <text start="2" dur="3">continues. Another statement.</text>
      <text start="5" dur="2">Last fragment</text>
    </transcript>`);
  }
  throw new Error(`Unexpected URL in offline test: ${url.origin}${url.pathname}`);
};
