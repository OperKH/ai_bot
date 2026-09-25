import fs from 'node:fs';
import path from 'node:path';
import type { BotApi } from './context/context.interface';

/**
 * Downloads a file the bot has access to. The download URL carries the bot
 * token, so it never leaves this function: not in the result, not in an error.
 * A local Bot API server (`--local`) hands out absolute paths instead of URLs,
 * and those are read from disk.
 *
 * `@grammyjs/files` builds the URL, but its own `download()` does not check the
 * HTTP status and would save an error page as the file.
 */
/** Downloads made while handling an update, so its handlers fetch a file once */
const updateDownloads = new WeakMap<object, Map<string, Promise<Buffer>>>();

/**
 * `downloadTelegramFile` shared by the handlers of one update: a photo is needed
 * both to look for its duplicates and to describe it for trends, and is fetched
 * once. The download goes when the update does.
 */
export function downloadUpdateFile(api: BotApi, update: object, fileId: string): Promise<Buffer> {
  let files = updateDownloads.get(update);
  if (!files) updateDownloads.set(update, (files = new Map()));
  let download = files.get(fileId);
  if (!download) files.set(fileId, (download = downloadTelegramFile(api, fileId)));
  return download;
}

export async function downloadTelegramFile(api: BotApi, fileId: string): Promise<Buffer> {
  const url = (await api.getFile(fileId)).getUrl();
  if (path.isAbsolute(url)) return fs.promises.readFile(url);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download file ${fileId}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
