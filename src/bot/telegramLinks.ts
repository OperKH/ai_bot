/**
 * The chat id as it appears in t.me/c/ links. Supergroup and channel ids are
 * negative and prefixed with -100, which the link leaves out. Also names the
 * chat in logs.
 */
export function getLinkChatId(chatId: number): number {
  return Math.abs(chatId) % 10000000000;
}

/** The t.me link to a message of a supergroup or channel */
export function messageLink(chatId: number, messageId: number | string): string {
  return `https://t.me/c/${getLinkChatId(chatId)}/${messageId}`;
}
