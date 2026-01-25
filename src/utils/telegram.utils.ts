/**
 * Converts a Telegram chat ID to the format used in t.me/c/ message links.
 * Telegram supergroup/channel IDs are negative and prefixed with -100,
 * so we need to extract the link-compatible ID.
 *
 * @param chatId - The Telegram chat ID (can be negative for groups/channels)
 * @returns The chat ID suitable for t.me/c/{chatId}/{messageId} links
 */
export function getLinkChatId(chatId: number): number {
  return Math.abs(chatId) % 10000000000;
}
