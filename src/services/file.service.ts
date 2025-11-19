import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

export class FileService {
  private static instance: FileService;
  private constructor() {}
  public static getInstance(): FileService {
    if (!FileService.instance) {
      FileService.instance = new FileService();
    }
    return FileService.instance;
  }

  public mediaPath = path.resolve('data', 'media');

  createMediaFolder() {
    try {
      fs.mkdirSync(this.mediaPath, { recursive: true });
    } catch (e) {
      /* empty */
    }
  }

  getFilePathByFileName(fileName: string) {
    return path.resolve(this.mediaPath, fileName);
  }

  async saveFileByUrl(url: string | URL, fileName: string) {
    this.createMediaFolder();
    const filePath = this.getFilePathByFileName(fileName);
    const file = fs.createWriteStream(filePath);
    await new Promise((resolve, reject) => {
      https.get(url, (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Failed, status code: ${res.statusCode}`));
        }
        res.on('error', reject);
        file.on('error', reject);
        file.on('finish', () => {
          file.close();
          resolve(true);
        });
        res.pipe(file);
      });
    });
    return filePath;
  }

  async deleteFileByFileName(fileName: string) {
    const filePath = this.getFilePathByFileName(fileName);
    await fs.promises.rm(filePath);
  }
}
