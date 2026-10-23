// Tiny fixture repo so read-only grounding has something real to read.
const sessions = new Map<string, { userId: string; expires: number }>();

export function login(userId: string): string {
  const id = Math.random().toString(36).slice(2);
  sessions.set(id, { userId, expires: Date.now() + 3600_000 });
  return id;
}

export function whoami(cookie: string): string | null {
  const s = sessions.get(cookie);
  return s && s.expires > Date.now() ? s.userId : null;
}
