const DEV_KEY = Buffer.from("loxel-dev-fixed-encryption-key!!", "utf8");

export async function loadOrCreateKey(): Promise<Buffer> {
  // TODO: temporary — bypassing keychain, revert to restore production key wrapping
  return DEV_KEY;
}
