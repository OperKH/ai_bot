import fs from 'node:fs';
import ffmpeg from 'fluent-ffmpeg';
import wavefile from 'wavefile';

import { Command } from './command.class';
import { TranscriptionQueue } from './transcriptionQueue';
import type { MessageContext } from '../context/context.interface';
import { downloadTelegramFile } from '../telegramFiles';
import { AIService } from '../../services/ai.service';
import { FileService } from '../../services/file.service';
import { TrendsService } from '../../services/trends.service.js';

export class RecognizeSpeechCommand extends Command {
  public command = null;
  public description = null;
  private aiService = AIService.getInstance();
  private fileService = FileService.getInstance();
  private trendsService!: TrendsService;
  private readonly transcriptions = new TranscriptionQueue();

  handle(): void {
    this.trendsService = TrendsService.getInstance(this.dataSource);
    this.bot.on('message:voice', async (ctx, next) => {
      await this.messageHandler(ctx, ctx.msg.voice.file_id, ctx.msg.voice.duration, 'ogg');
      return next();
    });

    this.bot.on('message:video_note', async (ctx, next) => {
      await this.messageHandler(ctx, ctx.msg.video_note.file_id, ctx.msg.video_note.duration, 'mp4');
      return next();
    });
  }

  /**
   * Answers with 💬 right away and queues the transcription (see
   * `TranscriptionQueue`), so the update slot is free again once the 💬 is out.
   */
  private async messageHandler(ctx: MessageContext, fileId: string, duration: number, fileExt: string) {
    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;
    try {
      await this.transcriptions.accept(
        {
          reply: async (text) => {
            const reply = await ctx.reply(text, {
              reply_parameters: { message_id: messageId },
              disable_notification: true,
            });
            return reply.message_id;
          },
          edit: async (replyId, text) => {
            await ctx.api.editMessageText(chatId, replyId, text);
          },
        },
        async () => {
          const text = await this.extractText(fileId, duration, fileExt);
          if (text.startsWith('📝')) await this.storeForTrends(ctx, text.slice(2).trim());
          return text;
        },
      );
    } catch (e) {
      console.log(e);
    }
  }

  /** Stores a transcription for trends analysis */
  private async storeForTrends(ctx: MessageContext, transcribedText: string) {
    try {
      await this.trendsService.storeMessage({
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
        userId: ctx.from.id,
        userName: ctx.from.username || null,
        userFirstName: ctx.from.first_name || null,
        userLastName: ctx.from.last_name || null,
        textContent: transcribedText,
      });
    } catch (e) {
      console.error('Error storing transcribed message:', e);
    }
  }

  /** Lets the transcription in progress finish; the queued ones are dropped with a notice */
  async dispose() {
    await this.transcriptions.close();
  }

  private async extractText(fileId: string, duration: number, fileExt: string) {
    const srcFileName = `${fileId}.${fileExt}`;
    const wavFileName = `${fileId}.wav`;
    const wavFilePath = this.fileService.getFilePathByFileName(wavFileName);
    try {
      const srcFilePath = await this.fileService.saveFile(
        await downloadTelegramFile(this.bot.api, fileId),
        srcFileName,
      );
      await new Promise((resolve, reject) => {
        ffmpeg(srcFilePath)
          .audioFrequency(16000)
          .audioChannels(1)
          .audioCodec('pcm_f64le')
          .toFormat('wav')
          .on('end', resolve)
          .on('error', reject)
          .save(wavFilePath);
      });
      const wavBuffer = await fs.promises.readFile(wavFilePath);
      const wav = new wavefile.WaveFile(wavBuffer);
      const audioData = wav.getSamples();
      const text = await this.aiService.audio2text(audioData, duration);
      return `📝 ${text.trim()}`;
    } catch (e) {
      console.log(e);
      return '📛 Помилка';
    } finally {
      await Promise.allSettled([
        this.fileService.deleteFileByFileName(srcFileName),
        this.fileService.deleteFileByFileName(wavFileName),
      ]);
    }
  }
}
