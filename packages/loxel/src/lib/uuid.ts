const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` is a UUID in its canonical text form. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
