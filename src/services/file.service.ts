import fs from 'node:fs';
import path from 'node:path';

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

  async saveFile(data: Buffer, fileName: string) {
    this.createMediaFolder();
    const filePath = this.getFilePathByFileName(fileName);
    await fs.promises.writeFile(filePath, data);
    return filePath;
  }

  async deleteFileByFileName(fileName: string) {
    const filePath = this.getFilePathByFileName(fileName);
    await fs.promises.rm(filePath);
  }
}
