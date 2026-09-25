import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { BotApi } from './context/context.interface';
import { downloadTelegramFile, downloadUpdateFile } from './telegramFiles';

const TOKEN = '123:secret-token';

/** A Bot API whose `getFile` results point at `url`, the way `hydrateFiles` builds the link */
const fakeApi = (url: string) =>
  ({ getFile: async (fileId: string) => ({ file_id: fileId, getUrl: () => url }) }) as unknown as BotApi;

describe('downloadTelegramFile', () => {
  let server: http.Server;
  let fileRoot: string;

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url?.endsWith('/photo.jpg')) {
        res.end('image bytes');
      } else {
        res.statusCode = 404;
        res.end('{"ok":false,"error_code":404,"description":"Not Found"}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    fileRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}/file/bot${TOKEN}`;
  });

  after(() => server.close());

  it('downloads the file behind the link', async () => {
    const data = await downloadTelegramFile(fakeApi(`${fileRoot}/photo.jpg`), 'photo-id');
    assert.equal(data.toString(), 'image bytes');
  });

  it('fails on an error response rather than returning the error page, and keeps the token out of the error', async () => {
    await assert.rejects(downloadTelegramFile(fakeApi(`${fileRoot}/gone.jpg`), 'gone-id'), (e: Error) => {
      assert.match(e.message, /HTTP 404/);
      assert.doesNotMatch(e.message, /secret-token/);
      return true;
    });
  });

  it('reads the absolute path that a local Bot API server hands out', async (t) => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tg-file-'));
    t.after(() => fs.promises.rm(dir, { recursive: true }));
    const filePath = path.join(dir, 'voice.ogg');
    await fs.promises.writeFile(filePath, 'voice bytes');

    const data = await downloadTelegramFile(fakeApi(filePath), 'voice-id');
    assert.equal(data.toString(), 'voice bytes');
  });

  it('fetches a file once for all the handlers of an update, and again for another update', async () => {
    let getFileCalls = 0;
    const api = {
      getFile: async (fileId: string) => {
        getFileCalls++;
        return { file_id: fileId, getUrl: () => `${fileRoot}/photo.jpg` };
      },
    } as unknown as BotApi;
    const update = { update_id: 1 };

    const [first, second] = await Promise.all([
      downloadUpdateFile(api, update, 'photo-id'),
      downloadUpdateFile(api, update, 'photo-id'),
    ]);
    assert.equal(first.toString(), 'image bytes');
    assert.equal(second, first);
    assert.equal(getFileCalls, 1);

    await downloadUpdateFile(api, { update_id: 2 }, 'photo-id');
    assert.equal(getFileCalls, 2);
  });
});
