import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { InputFile } from 'grammy';
import sharp from 'sharp';
import { BROWSER_HEADERS } from './sources/feed';

/** Pictures of stories, kept until the first post has uploaded them to Telegram */
const IMAGE_DIR = './data/crow/images';
const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;
const MAX_WIDTH = 1280;
/** No post uploads a picture this old: a story's first posts go out within a day, or its arcs are called off */
const IMAGE_TTL_MS = 2 * 24 * 3_600_000;

export function storyImagePath(storyId: number): string {
  return `${IMAGE_DIR}/${storyId}.jpg`;
}

/**
 * Downloads a story's picture and stores it as JPEG. Downloaded by the bot
 * rather than handed to Telegram as a URL: Telegram cannot reach every site,
 * and some links expire. WebP and the like become JPEG, and huge pictures are
 * scaled down. SVG and anything that is not a picture are refused.
 */
export async function saveStoryImage(url: string, storyId: number): Promise<boolean> {
  const response = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(20_000) });
  const type = response.headers.get('content-type') ?? '';
  if (!response.ok || !type.startsWith('image/') || type.includes('svg')) return false;
  const image = Buffer.from(await response.arrayBuffer());
  if (image.length > MAX_DOWNLOAD_BYTES) return false;
  const jpeg = await sharp(image).resize({ width: MAX_WIDTH, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  const path = storyImagePath(storyId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, jpeg);
  return true;
}

/** Forgets a story's picture once Telegram has it: the later posts send its file_id */
export async function dropStoryImage(storyId: number): Promise<void> {
  await rm(storyImagePath(storyId), { force: true });
}

/** Forgets the pictures no post will upload any more — of stories whose arcs were called off; how many went */
export async function dropOldImages(now: Date): Promise<number> {
  const files = await readdir(IMAGE_DIR).catch(() => [] as string[]);
  let dropped = 0;
  for (const file of files) {
    const path = `${IMAGE_DIR}/${file}`;
    if (now.getTime() - (await stat(path)).mtimeMs <= IMAGE_TTL_MS) continue;
    await rm(path, { force: true });
    dropped++;
  }
  return dropped;
}

/** The picture of a story's first post: uploaded once, then sent by its file_id */
export function storyPhoto(story: { id: number; imageFileId: string | null }): InputFile | string | null {
  if (story.imageFileId) return story.imageFileId;
  const path = storyImagePath(story.id);
  return existsSync(path) ? new InputFile(path) : null;
}
