import { Loader } from './loader.class';

export class ClockLoader extends Loader {
  // prettier-ignore
  private emojiList = ['🕛','🕐','🕑','🕒','🕓','🕔','🕕','🕧','🕜','🕝','🕞','🕟','🕠','🕡','🕢','🕣','🕤','🕥','🕦','🕕','🕖','🕗','🕘','🕙','🕚'];
  private emojiIndex = 0;
  private messageId?: number;
  private timeoutId: NodeJS.Timeout | number = 0;

  get currentEmoji() {
    return this.emojiList[this.emojiIndex];
  }

  async start(reply = false, ms = 1000) {
    if (this.messageId === undefined) {
      const message = await this.ctx.reply(this.currentEmoji, {
        reply_parameters: reply ? { message_id: this.ctx.message.message_id } : undefined,
      });
      this.messageId = message.message_id;
    }

    clearTimeout(this.timeoutId);
    this.timeoutId = setTimeout(async () => {
      this.emojiIndex = this.emojiIndex < this.emojiList.length - 1 ? this.emojiIndex + 1 : 0;
      try {
        await this.ctx.telegram.editMessageText(this.ctx.chat.id, this.messageId, '', this.currentEmoji);
        // Allow run in background and release message queue
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this.start();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        const sec = e?.response?.parameters?.retry_after ?? 15;
        console.log(`Temp ban for ${sec} sec`);
        // Allow run in background and release message queue
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this.start(reply, sec * 1000);
      }
    }, ms);
  }

  stop() {
    clearTimeout(this.timeoutId);
    return this.messageId;
  }
}
