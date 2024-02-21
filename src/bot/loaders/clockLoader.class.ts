import { Loader } from './loader.class.js';

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
        this.start();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        const sec = e?.response?.parameters?.retry_after ?? 15;
        console.log(`Temp ban for ${sec} sec`);
        this.start(reply, sec * 1000);
      }
    }, ms);
  }

  stop() {
    clearTimeout(this.timeoutId);
    return this.messageId;
  }
}
