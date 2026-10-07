/**
 * The HTTP layer on its own (http.ts), against a listening server: a request line that is no path.
 *
 * `GET //` is a request any program can send, and any web page too (an image whose address ends in `//`). It is not a
 * URL, and the layer used to find that out where nothing caught the error: the whole process ended, rounds and all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';

const { HttpApp } = await import('./http.ts');

/** Bytes as written: `node:http` and `fetch` both tidy a path before they send it. */
function raw(port: number, text: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(text));
    let got = '';
    socket.on('data', (c) => { got += c; });
    socket.on('close', () => resolvePromise(got));
    socket.on('error', reject);
  });
}

test('a request line that is no path is answered as that, and the workbench goes on answering', async () => {
  const http = new HttpApp();
  http.route('GET', '/api/tides', () => ({ tide: 'ebb' }));
  const server = await http.listen(0);
  try {
    const here = `127.0.0.1:${server.port}`;
    for (const line of ['//', '//a:b:c/', 'http://']) {
      const got = await raw(server.port, `GET ${line} HTTP/1.1\r\nHost: ${here}\r\nConnection: close\r\n\r\n`);
      assert.match(got, /^HTTP\/1\.1 400 /, `${line}: ${got}`);
      assert.ok(got.includes('The request names no path.'), got);
    }
    assert.deepEqual(await (await fetch(`http://${here}/api/tides`)).json(), { tide: 'ebb' }, 'still answering');
  } finally { await server.close(); }
});
