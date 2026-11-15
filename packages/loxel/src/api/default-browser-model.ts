/** Whether Loxel is the default web browser, as Settings shows it. */
export interface DefaultBrowserStatus {
  /** macOS opens http and https links with Loxel. */
  isDefault: boolean;
  /**
   * Whether this build can become the default: only an installed (packaged) app on macOS declares
   * the web URL schemes, so a dev or source run would register Electron instead.
   */
  canSet: boolean;
}
