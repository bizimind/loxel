export const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

export function assertValidSessionId(sessionId: string): void {
  if (isValidSessionId(sessionId)) {
    return;
  }

  throw new Error(
    `Invalid session id: "${sessionId}". Expected 1-128 characters matching [a-zA-Z0-9_-].`,
  );
}
