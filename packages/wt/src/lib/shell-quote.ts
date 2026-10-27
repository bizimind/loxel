/** Quote an arbitrary value as one POSIX-shell argument. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Like `shellQuote`, but leaves a value the shell would read literally unquoted, for display. */
export function shellArg(value: string): string {
  return /^[\w./:=@%+,-]+$/.test(value) ? value : shellQuote(value);
}
