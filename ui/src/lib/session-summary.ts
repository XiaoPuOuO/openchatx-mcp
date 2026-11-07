export function sessionSummary<T extends { lastSeenAt: number }>(sessions: readonly T[], now: number) {
  return {
    active: sessions.filter((session) => now - session.lastSeenAt < 30_000).length,
    total: sessions.length,
  }
}
