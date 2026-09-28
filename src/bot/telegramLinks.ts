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

/** The link to a message, if it has one: a basic group's messages have none */
export function supergroupMessageLink(chatId: string, messageId: number | string | null): string | null {
  return messageId !== null && chatId.startsWith('-100') ? messageLink(Number(chatId), messageId) : null;
}
