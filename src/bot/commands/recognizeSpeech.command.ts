import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import ffmpeg from 'fluent-ffmpeg';
import wavefile from 'wavefile';
import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';

import { Command } from './command.class.js';
import { IBotContext } from '../context/context.interface.js';
import { AIService } from '../../services/ai.service.js';

export class RecognizeSpeechCommand extends Command {
  private aiService = AIService.getInstance();

  constructor(bot: Telegraf<IBotContext>) {
    super(bot);
  }

  handle(): void {
    this.bot.on(message('voice'), async (ctx) => {
      const text = await this.extractText(ctx.message.voice.file_id, 'ogg');
      ctx.reply(text, { reply_parameters: { message_id: ctx.message.message_id } });
    });

    this.bot.on(message('video_note'), async (ctx) => {
      const text = await this.extractText(ctx.message.video_note.file_id, 'mp4');
      ctx.reply(text, { reply_parameters: { message_id: ctx.message.message_id } });
    });
  }

  private async extractText(fileId: string, fileExt: string) {
    const mediaPath = path.resolve('data', 'media');
    const srcFilePath = path.resolve(mediaPath, `${fileId}.${fileExt}`);
    const wavFilePath = path.resolve(mediaPath, `${fileId}.wav`);
    let resultText = '';
    try {
      fs.mkdirSync(mediaPath, { recursive: true });
    } catch (e) {
      /* empty */
    }

    try {
      const link = await this.bot.telegram.getFileLink(fileId);
      await new Promise((resolve, reject) => {
        https.get(link, (res) => {
          res.on('end', resolve);
          res.on('error', reject);
          res.pipe(fs.createWriteStream(srcFilePath));
        });
      });
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
      resultText = await this.aiService.audio2text(audioData);
    } catch (e) {
      console.log(e);
      resultText = 'Помилка';
    } finally {
      await Promise.allSettled([fs.promises.rm(srcFilePath), fs.promises.rm(wavFilePath)]);
    }
    return resultText.trim();
  }

  async dispose() {
    await this.aiService.dispose();
  }
}
