// Preload for the frames of incognito browser sessions, registered on each one by main
// (incognito-session.ts). Sandboxed; must be CJS (sandboxed Electron renderers cannot use ESM).
//
// Refuses to create passkeys, as a NotAllowedError, the error a site gets when the user cancels.
// The Touch ID authenticator keeps what it needs to find a passkey again in the session, which an
// incognito session drops, so a passkey made there would be left in the keychain unusable
// (electron/electron#52302). Signing in with an existing passkey still works, and so does a
// registration that asks for a cross-platform authenticator (a security key or a phone, which keeps
// its own); one that leaves the authenticator open, as most sites do, is refused.
const { contextBridge } = require("electron");

contextBridge.executeInMainWorld({
  // Serialized into the page's world: it can only use the page's globals.
  func: () => {
    const container = globalThis.CredentialsContainer?.prototype;
    const create = container && Object.getOwnPropertyDescriptor(container, "create")?.value;
    if (typeof create !== "function") return;
    container.create = function (options, ...rest) {
      const publicKey = options?.publicKey;
      const attachment = publicKey?.authenticatorSelection?.authenticatorAttachment;
      if (publicKey !== undefined && attachment !== "cross-platform") {
        return Promise.reject(
          new DOMException("Passkeys can't be saved in incognito tabs.", "NotAllowedError"),
        );
      }
      return Reflect.apply(create, this, [options, ...rest]);
    };
  },
});
