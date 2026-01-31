import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpeg from 'fluent-ffmpeg';
import { RawImage } from '@huggingface/transformers';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type VideoFrame = {
  frameIndex: number;
  timestamp: number;
  buffer: Buffer;
};

export class VideoService {
  private static instance: VideoService;
  private readonly FRAME_POSITIONS = [0.1, 0.3, 0.5, 0.7]; // Extract at 10%, 30%, 50%, 70%
  private readonly tempDir = path.join(__dirname, '../../data/temp');

  private constructor() {}

  public static getInstance(): VideoService {
    if (!VideoService.instance) {
      VideoService.instance = new VideoService();
    }
    return VideoService.instance;
  }

  /**
   * Get the frame extraction positions (same for indexing and searching)
   */
  public getFramePositions(): number[] {
    return this.FRAME_POSITIONS;
  }

  /**
   * Get video duration in seconds
   */
  private getVideoDuration(videoPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          reject(err);
        } else {
          const duration = metadata.format.duration;
          if (duration) {
            resolve(duration);
          } else {
            reject(new Error('Could not determine video duration'));
          }
        }
      });
    });
  }

  /**
   * Extract a single frame at a specific timestamp
   */
  private extractFrameAtTimestamp(videoPath: string, timestamp: number, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(timestamp)
        .frames(1)
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run();
    });
  }

  /**
   * Extract multiple frames from a video buffer
   * Returns an array of frames with their index, timestamp, and image buffer
   */
  public async extractFramesFromBuffer(videoBuffer: Buffer): Promise<VideoFrame[]> {
    // Ensure temp directory exists
    await fs.mkdir(this.tempDir, { recursive: true });

    // Save video buffer to temp file
    const tempVideoPath = path.join(this.tempDir, `video_${Date.now()}.mp4`);
    await fs.writeFile(tempVideoPath, videoBuffer);

    try {
      // Get video duration
      const duration = await this.getVideoDuration(tempVideoPath);

      // Extract frames at specified positions
      const frames: VideoFrame[] = [];
      for (let i = 0; i < this.FRAME_POSITIONS.length; i++) {
        const position = this.FRAME_POSITIONS[i];
        const timestamp = duration * position;
        const outputPath = path.join(this.tempDir, `frame_${Date.now()}_${i}.jpg`);

        try {
          await this.extractFrameAtTimestamp(tempVideoPath, timestamp, outputPath);
          const frameBuffer = await fs.readFile(outputPath);
          frames.push({
            frameIndex: i,
            timestamp,
            buffer: frameBuffer,
          });

          // Clean up frame file
          await fs.unlink(outputPath).catch(() => {
            /* ignore */
          });
        } catch (err) {
          console.error(`Failed to extract frame ${i} at ${timestamp}s:`, err);
        }
      }

      return frames;
    } finally {
      // Clean up temp video file
      await fs.unlink(tempVideoPath).catch(() => {
        /* ignore */
      });
    }
  }

  /**
   * Convert frame buffer to RawImage for CLIP processing
   */
  public async frameBufferToRawImage(buffer: Buffer): Promise<RawImage> {
    const img = sharp(buffer);
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    return new RawImage(new Uint8ClampedArray(data), info.width, info.height, info.channels);
  }
}
