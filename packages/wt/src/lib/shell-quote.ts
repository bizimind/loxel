/** Quote an arbitrary value as one POSIX-shell argument. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
