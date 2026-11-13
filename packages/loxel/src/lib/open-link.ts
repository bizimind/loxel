/**
 * Open an http(s) link the way terminals do: Cmd+click in a browser panel, a plain click in the
 * system browser (Electron's window-open handler). Any other scheme is ignored.
 */
export function openWebLink(event: Pick<MouseEvent, "metaKey">, url: string): void {
  try {
    const { protocol } = new URL(url);
    if (protocol !== "https:" && protocol !== "http:") return;
  } catch {
    return;
  }
  if (event.metaKey) {
    window.dispatchEvent(new CustomEvent("loxel-create-browser", { detail: { url } }));
  } else {
    window.open(url);
  }
}
