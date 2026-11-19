// Preload for the service workers of browser panel pages, registered by main on the browser panels'
// session. Runs in each worker before the worker's own script. Must be CJS, like the other
// preloads.
//
// Chromium's own notification permission is denied for browser panels, so a worker's
// `self.registration.showNotification()` would reject. This replaces it, `getNotifications()`,
// `Notification.permission` and the `notifications` answer of `navigator.permissions.query()` with
// IPC calls to main, which shows the notifications in Loxel's notification center, and dispatches
// `notificationclick` here when the user clicks one. See service-worker-notifications.ts.
const { contextBridge, ipcRenderer } = require("electron");

// Must match the constants in ipc-channels.ts.
const BROWSER_NOTIFICATION_PERMISSION = "browser-notification:permission";
const REGISTRATION_NOTIFICATION_SHOW = "registration-notification:show";
const REGISTRATION_NOTIFICATION_LIST = "registration-notification:list";
const REGISTRATION_NOTIFICATION_CLOSE = "registration-notification:close";
const REGISTRATION_NOTIFICATION_CLICK = "registration-notification:click";
const REGISTRATION_NOTIFICATION_CLICK_DONE = "registration-notification:click-done";
const REGISTRATION_NOTIFICATION_OPEN_WINDOW = "registration-notification:open-window";

/** Delivers main's clicks to the worker's world, once its script below has set it. */
let deliverClick = () => {};
ipcRenderer.on(REGISTRATION_NOTIFICATION_CLICK, (_event, clickId, info) =>
  deliverClick(clickId, info),
);

contextBridge.executeInMainWorld({
  // Serialized into the worker's world: it can only use its arguments and the worker's globals.
  func: (bridge) => {
    // How long after a click the worker's focus() is let through, as main lets openWindow() through
    // (USER_ACTIVATION_MS in user-activation.ts).
    const WINDOW_INTERACTION_MS = 5000;
    let windowInteractionUntil = 0;
    const text = (value) => (value === undefined ? "" : `${value}`);
    /** The Notification objects main's notifications get here; nothing else can construct one. */
    const fromMain = Symbol("fromMain");

    class Notification extends EventTarget {
      #ref;
      #info;
      constructor(info, key) {
        if (key !== fromMain) {
          throw new TypeError(
            "Failed to construct 'Notification': Illegal constructor. Use ServiceWorkerRegistration.showNotification() instead.",
          );
        }
        super();
        this.#ref = info.ref;
        this.#info = info;
        this.onclick = null;
        this.onshow = null;
        this.onerror = null;
        this.onclose = null;
      }
      close() {
        bridge.close(this.#ref);
      }
      get title() {
        return this.#info.title;
      }
      get body() {
        return this.#info.body;
      }
      get tag() {
        return this.#info.tag;
      }
      get data() {
        return this.#info.data;
      }
      get timestamp() {
        return this.#info.timestamp;
      }
      // Options Loxel's notification center doesn't show: what browsers report when not given.
      get dir() {
        return "auto";
      }
      get lang() {
        return "";
      }
      get icon() {
        return "";
      }
      get badge() {
        return "";
      }
      get image() {
        return "";
      }
      get silent() {
        return null;
      }
      get requireInteraction() {
        return false;
      }
      get renotify() {
        return false;
      }
      get actions() {
        return [];
      }
      get vibrate() {
        return [];
      }
      static get permission() {
        return bridge.permission();
      }
      static get maxActions() {
        return 0;
      }
    }
    self.Notification = Notification;
    const notificationOf = (info) => new Notification(info, fromMain);

    // Declared apart from their assignment, so they convert their arguments like the DOM does.
    function showNotification(title, options = {}) {
      if (arguments.length === 0) {
        return Promise.reject(
          new TypeError(
            "Failed to execute 'showNotification' on 'ServiceWorkerRegistration': 1 argument required, but only 0 present.",
          ),
        );
      }
      const opts = options ?? {};
      const timestamp = Number(opts.timestamp);
      // A `data` the bridge can't copy throws here, which becomes the rejection.
      return new Promise((resolve) => {
        resolve(
          bridge.show({
            title: `${title}`,
            body: text(opts.body),
            tag: text(opts.tag),
            timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
            data: opts.data ?? null,
          }),
        );
      }).then((result) => {
        if (result === "denied") {
          throw new TypeError("No notification permission has been granted for this origin.");
        }
        if (result === "data-too-large") {
          throw new TypeError("The notification's data is too large.");
        }
      });
    }
    function getNotifications(filter = {}) {
      return Promise.resolve(bridge.list({ tag: text(filter?.tag) })).then((infos) =>
        infos.map(notificationOf),
      );
    }
    const registration = globalThis.ServiceWorkerRegistration?.prototype;
    if (registration) {
      registration.showNotification = showNotification;
      registration.getNotifications = getNotifications;
    }

    // Chromium only lets a worker open or focus a window while it handles a notificationclick of
    // its own, which the event below is not.
    const clients = globalThis.Clients?.prototype;
    if (clients) {
      clients.openWindow = function openWindow(url) {
        let href;
        try {
          href = new URL(`${url}`, self.location.href).href;
        } catch {
          return Promise.reject(
            new TypeError(
              `Failed to execute 'openWindow' on 'Clients': The URL '${url}' is invalid.`,
            ),
          );
        }
        return Promise.resolve(bridge.openWindow(href)).then((opened) => {
          if (!opened)
            throw new DOMException("Not allowed to open a window.", "InvalidAccessError");
          // The tab opens in Loxel, which gives the worker no client for it.
          return null;
        });
      };
    }
    const windowClient = globalThis.WindowClient?.prototype;
    const focus = windowClient && Object.getOwnPropertyDescriptor(windowClient, "focus")?.value;
    if (typeof focus === "function") {
      windowClient.focus = function (...args) {
        // Clicking the notification already showed the site's tab.
        if (Date.now() < windowInteractionUntil) return Promise.resolve(this);
        return Reflect.apply(focus, this, args);
      };
    }

    /** Wait for the handlers' `waitUntil()` promises, including ones added while waiting. */
    const settle = async (pending) => {
      let settled = 0;
      while (settled < pending.length) {
        settled = pending.length;
        await Promise.allSettled(pending);
      }
    };
    bridge.onClick((clickId, info) => {
      const event = new ExtendableEvent("notificationclick");
      const pending = [];
      let finished = false;
      // Chromium refuses waitUntil() on an event a script made; the handlers get a working one,
      // which like Chromium's refuses more promises once the ones it has settled.
      const waitUntil = (promise) => {
        if (finished)
          throw new DOMException("The event handler is already finished.", "InvalidStateError");
        pending.push(Promise.resolve(promise));
      };
      Object.defineProperties(event, {
        notification: { value: notificationOf(info) },
        action: { value: "" },
        reply: { value: null },
        waitUntil: { value: waitUntil },
      });
      windowInteractionUntil = Date.now() + WINDOW_INTERACTION_MS;
      self.dispatchEvent(event);
      void settle(pending).then(() => {
        finished = true;
        bridge.clickDone(clickId);
      });
    });

    // navigator.permissions.query() would ask Chromium, which denies notifications to every
    // worker; report the permission the worker's Notification has.
    const permissions = globalThis.Permissions?.prototype;
    const query = permissions && Object.getOwnPropertyDescriptor(permissions, "query")?.value;
    if (typeof query === "function") {
      const states = { granted: "granted", denied: "denied", default: "prompt" };
      permissions.query = function (descriptor, ...rest) {
        const status = Reflect.apply(query, this, [descriptor, ...rest]);
        if (descriptor?.name !== "notifications") return status;
        return status.then((result) => {
          Object.defineProperty(result, "state", { get: () => states[bridge.permission()] });
          return result;
        });
      };
    }
  },
  args: [
    {
      permission: () => ipcRenderer.sendSync(BROWSER_NOTIFICATION_PERMISSION),
      show: (notification) => ipcRenderer.invoke(REGISTRATION_NOTIFICATION_SHOW, notification),
      list: (query) => ipcRenderer.invoke(REGISTRATION_NOTIFICATION_LIST, query),
      close: (ref) => ipcRenderer.send(REGISTRATION_NOTIFICATION_CLOSE, { ref }),
      openWindow: (url) => ipcRenderer.invoke(REGISTRATION_NOTIFICATION_OPEN_WINDOW, url),
      clickDone: (clickId) => ipcRenderer.send(REGISTRATION_NOTIFICATION_CLICK_DONE, clickId),
      onClick: (listener) => {
        deliverClick = listener;
      },
    },
  ],
});
