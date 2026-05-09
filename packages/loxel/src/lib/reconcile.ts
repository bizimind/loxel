/**
 * Structural sharing utility for Zustand store synchronization.
 *
 * Given a `current` value and an `incoming` value, returns a result that uses
 * `current` references wherever subtrees are deeply equal. This preserves
 * object identity for React selectors, avoiding unnecessary re-renders when
 * applying state updates from other tabs via WebSocket.
 *
 * Supports: primitives, arrays, plain objects, Sets, and Maps.
 */
export function reconcile<T>(current: T, incoming: T): T {
  // Fast path: same reference or same primitive value
  if (Object.is(current, incoming)) return current;

  // Primitives, null, or undefined — values differ, return incoming
  if (
    typeof current !== "object" ||
    current === null ||
    typeof incoming !== "object" ||
    incoming === null
  ) {
    return incoming;
  }

  // Set
  if (current instanceof Set && incoming instanceof Set) {
    return reconcileSets(current, incoming) as T;
  }

  // Map
  if (current instanceof Map && incoming instanceof Map) {
    return reconcileMaps(current, incoming) as T;
  }

  // Type mismatch (array vs object, Set vs array, etc.)
  if (current.constructor !== incoming.constructor) return incoming;

  // Array
  if (Array.isArray(current)) {
    return reconcileArrays(current, incoming as unknown[]) as T;
  }

  // Plain object
  return reconcileObjects(
    current as Record<string, unknown>,
    incoming as Record<string, unknown>,
  ) as T;
}

function reconcileArrays(current: unknown[], incoming: unknown[]): unknown[] {
  if (current.length !== incoming.length) return incoming;
  let same = true;
  const result = incoming.map((val, i) => {
    const reconciled = reconcile(current[i], val);
    if (reconciled !== current[i]) same = false;
    return reconciled;
  });
  return same ? current : result;
}

function reconcileObjects(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const incomingKeys = Object.keys(incoming);
  const currentKeys = Object.keys(current);
  if (incomingKeys.length !== currentKeys.length) return incoming;

  let same = true;
  const result: Record<string, unknown> = {};
  for (const key of incomingKeys) {
    if (!(key in current)) return incoming;
    result[key] = reconcile(current[key], incoming[key]);
    if (result[key] !== current[key]) same = false;
  }
  return same ? current : result;
}

function reconcileSets(current: Set<unknown>, incoming: Set<unknown>): Set<unknown> {
  if (current.size !== incoming.size) return incoming;

  const currentArr = [...current];
  const incomingArr = [...incoming];

  let same = true;
  const result: unknown[] = incomingArr.map((val, i) => {
    const reconciled = reconcile(currentArr[i], val);
    if (reconciled !== currentArr[i]) same = false;
    return reconciled;
  });
  return same ? current : new Set(result);
}

function reconcileMaps(
  current: Map<unknown, unknown>,
  incoming: Map<unknown, unknown>,
): Map<unknown, unknown> {
  if (current.size !== incoming.size) return incoming;

  let same = true;
  const result = new Map<unknown, unknown>();
  for (const [key, val] of incoming) {
    if (!current.has(key)) return incoming;
    const reconciled = reconcile(current.get(key), val);
    if (reconciled !== current.get(key)) same = false;
    result.set(key, reconciled);
  }
  return same ? current : result;
}
