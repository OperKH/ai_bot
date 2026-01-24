import fs from 'node:fs';
import ffmpeg from 'fluent-ffmpeg';
import wavefile from 'wavefile';
import { NarrowedContext } from 'telegraf';
import { Message, Update } from 'telegraf/types';
import { message } from 'telegraf/filters';

import { Command } from './command.class';
import { IBotContext } from '../context/context.interface';
import { AIService } from '../../services/ai.service';
import { FileService } from '../../services/file.service';
import { TrendsService } from '../../services/trends.service.js';

export class RecognizeSpeechCommand extends Command {
  public command = null;
  public description = null;
  private aiService = AIService.getInstance();
  private fileService = FileService.getInstance();
  private trendsService!: TrendsService;

  handle(): void {
    this.trendsService = TrendsService.getInstance(this.dataSource);
    this.bot.on(message('voice'), async (ctx, next) => {
      await this.messageHandler(ctx, ctx.message.voice.file_id, ctx.message.voice.duration, 'ogg');
      return next();
    });

    this.bot.on(message('video_note'), async (ctx, next) => {
      await this.messageHandler(ctx, ctx.message.video_note.file_id, ctx.message.video_note.duration, 'mp4');
      return next();
    });
  }

  private async messageHandler(
    ctx: NarrowedContext<IBotContext, Update.MessageUpdate<Message>>,
    fileId: string,
    duration: number,
    fileExt: string,
  ) {
    try {
      const replyMessage = await ctx.reply('💬', {
        reply_parameters: { message_id: ctx.message.message_id },
        disable_notification: true,
      });
      const text = await this.extractText(fileId, duration, fileExt);
      await ctx.telegram.editMessageText(ctx.chat.id, replyMessage.message_id, undefined, text);

      // Store transcribed text for trends analysis
      if (text.startsWith('📝')) {
        const transcribedText = text.slice(2).trim();
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
    } catch (e) {
      console.log(e);
    }
  }

  private async extractText(fileId: string, duration: number, fileExt: string) {
    const srcFileName = `${fileId}.${fileExt}`;
    const wavFileName = `${fileId}.wav`;
    const wavFilePath = this.fileService.getFilePathByFileName(wavFileName);
    let resultText = '';
    try {
      const link = await this.bot.telegram.getFileLink(fileId);
      const srcFilePath = await this.fileService.saveFileByUrl(link, srcFileName);
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
      resultText = `📝 ${text.trim()}`;
    } catch (e) {
      console.log(e);
      resultText = '📛 Помилка';
    } finally {
      await Promise.allSettled([
        this.fileService.deleteFileByFileName(srcFileName),
        this.fileService.deleteFileByFileName(wavFileName),
      ]);
    }
    return resultText.trim();
  }

  async dispose() {
    await this.aiService.dispose();
  }
}
