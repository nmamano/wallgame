const RATE_LIMIT_MS = 1000; // 1 message per second

// In-memory map tracking socketId -> last message timestamp
const lastMessageTime = new Map<string, number>();

/**
 * Check if a socket can send a message (rate limit: 1 msg/sec).
 * Returns true if allowed, false if rate limited.
 * Automatically updates the timestamp if allowed.
 */
export function canSendMessage(socketId: string): boolean {
  const now = Date.now();
  const lastTime = lastMessageTime.get(socketId) ?? 0;

  if (now - lastTime < RATE_LIMIT_MS) {
    return false;
  }

  lastMessageTime.set(socketId, now);
  return true;
}

/**
 * Clean up rate limit entry when a socket disconnects.
 */
export function clearRateLimitEntry(socketId: string): void {
  lastMessageTime.delete(socketId);
}
