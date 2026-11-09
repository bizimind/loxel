/** Quote an arbitrary value as one POSIX-shell argument. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Like `shellQuote`, but leaves a value the shell would read literally unquoted, for display. */
export function shellArg(value: string): string {
  // A leading `=` is zsh's equals expansion (`=foo` is the path of `foo`), so only later ones pass.
  return /^[\w./:@%+,-][\w./:=@%+,-]*$/.test(value) ? value : shellQuote(value);
}
