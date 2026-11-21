// Preload for browser panel <webview> pages, set by main in will-attach-webview. Sandboxed, runs in
// every frame. Must be CJS (sandboxed Electron renderers cannot use ESM imports).
//
// Replaces the page's alert() / confirm() / prompt() — Electron throws on prompt() and shows the
// other two as sheets over the whole window — with ones that ask main synchronously, so the page
// blocks until the user answers the dialog Loxel shows in that panel. See javascript-dialogs.ts.
const { contextBridge, ipcRenderer } = require("electron");

// Must match JAVASCRIPT_DIALOG_RUN in ipc-channels.ts.
const JAVASCRIPT_DIALOG_RUN = "javascript-dialog:run";

contextBridge.executeInMainWorld({
  // Serialized into the page's world: it can only use its arguments and the page's globals.
  func: (runDialog) => {
    // Like browsers, ignore dialogs while the page is being left (beforeunload, pagehide).
    let leaving = false;
    let beforeUnload = false;
    addEventListener("beforeunload", () => {
      beforeUnload = true;
      setTimeout(() => {
        beforeUnload = false;
      }, 0);
    });
    addEventListener("pagehide", () => {
      leaving = true;
    });
    addEventListener("pageshow", () => {
      leaving = false;
    });

    // `${value}` converts like a DOMString argument (throws for symbols); an optional argument
    // omitted or undefined takes its default, "".
    const text = (value) => (value === undefined ? "" : `${value}`);
    const run = (type, message, defaultValue) => {
      const call = { type, message: text(message), defaultValue: text(defaultValue) };
      return leaving || beforeUnload ? null : runDialog(call);
    };

    window.alert = function alert(...args) {
      // Two overloads, not an optional argument: alert() shows "" but alert(undefined) shows
      // "undefined". confirm() and prompt() take optional arguments, where undefined means "".
      run("alert", args.length === 0 ? "" : `${args[0]}`, undefined);
    };
    window.confirm = function confirm(...args) {
      return run("confirm", args[0], undefined) === true;
    };
    window.prompt = function prompt(...args) {
      const result = run("prompt", args[0], args[1]);
      return typeof result === "string" ? result : null;
    };
  },
  args: [(call) => ipcRenderer.sendSync(JAVASCRIPT_DIALOG_RUN, call)],
});

// Replaces the page's Notification with one that shows in Loxel's notification center. Chromium's
// own notification permission is denied for browser panels, so this is the pages' only way to
// notify. Permission and showing are IPC calls to main, which decides by the page's real origin.
// See browser-notifications.ts.

// Must match the BROWSER_NOTIFICATION_* and REGISTRATION_NOTIFICATION_* constants in ipc-channels.ts.
const BROWSER_NOTIFICATION_PERMISSION = "browser-notification:permission";
const BROWSER_NOTIFICATION_REQUEST_PERMISSION = "browser-notification:request-permission";
const BROWSER_NOTIFICATION_SHOW = "browser-notification:show";
const BROWSER_NOTIFICATION_CLOSE = "browser-notification:close";
const BROWSER_NOTIFICATION_EVENT = "browser-notification:event";
const REGISTRATION_NOTIFICATION_SHOW = "registration-notification:show";
const REGISTRATION_NOTIFICATION_LIST = "registration-notification:list";
const REGISTRATION_NOTIFICATION_CLOSE = "registration-notification:close";

contextBridge.executeInMainWorld({
  // Serialized into the page's world: it can only use its arguments and the page's globals.
  func: (bridge) => {
    // The page's live notifications by id, for the events main delivers. Bounded: a page that
    // never closes its notifications must not grow this forever.
    const MAX_TRACKED = 100;
    const live = new Map();
    // A random start per document: main keys notifications by frame, and a frame's next document
    // must not reuse the ids of the one before.
    let nextId = Math.floor(Math.random() * 2 ** 30) + 1;
    const text = (value) => (value === undefined ? "" : `${value}`);
    /** Fires an event main delivered on a live notification; `click` is the only one it sends. */
    let deliver;
    /** Makes the Notification object for a registration's notification main lists. */
    let adopt;
    /** Set while `adopt` constructs one, which shows nothing. */
    let adopting = null;

    class Notification extends EventTarget {
      static {
        deliver = (id, type) => {
          const notification = live.get(id);
          if (notification && type === "click") notification.#fire("click");
        };
        adopt = (scope, info) => {
          adopting = { scope, ref: info.ref };
          try {
            const { title, ...options } = info;
            return new Notification(title, options);
          } finally {
            adopting = null;
          }
        };
      }
      #id;
      #fields;
      /** For a registration's notification: its scope and main's ref, which close() sends. */
      #registration = null;
      constructor(title, options = {}) {
        if (arguments.length === 0) {
          throw new TypeError(
            "Failed to construct 'Notification': 1 argument required, but only 0 present.",
          );
        }
        super();
        const opts = options ?? {};
        this.#id = nextId++;
        this.#fields = {
          title: `${title}`,
          body: text(opts.body),
          tag: text(opts.tag),
          data: opts.data ?? null,
          dir: opts.dir ?? "auto",
          lang: text(opts.lang),
          icon: text(opts.icon),
          badge: text(opts.badge),
          image: text(opts.image),
          silent: opts.silent ?? null,
          requireInteraction: Boolean(opts.requireInteraction),
          renotify: Boolean(opts.renotify),
          timestamp: opts.timestamp ?? Date.now(),
        };
        this.onclick = null;
        this.onshow = null;
        this.onerror = null;
        this.onclose = null;
        if (adopting) {
          this.#registration = adopting;
          return;
        }

        const granted = bridge.permission() === "granted";
        if (granted) {
          live.set(this.#id, this);
          if (live.size > MAX_TRACKED) live.delete(live.keys().next().value);
          const { title: t, body, tag } = this.#fields;
          bridge.show({ pageId: this.#id, title: t, body, tag });
        }
        // Like browsers, the outcome is an event after construction returns.
        setTimeout(() => this.#fire(granted ? "show" : "error"), 0);
      }
      #fire(type) {
        const event = new Event(type, { cancelable: type === "click" });
        this.dispatchEvent(event);
        const handler = this[`on${type}`];
        if (typeof handler === "function") handler.call(this, event);
      }
      close() {
        if (this.#registration) {
          bridge.closeForRegistration(this.#registration);
          return;
        }
        if (!live.delete(this.#id)) return;
        bridge.close(this.#id);
        setTimeout(() => this.#fire("close"), 0);
      }
      get title() {
        return this.#fields.title;
      }
      get body() {
        return this.#fields.body;
      }
      get tag() {
        return this.#fields.tag;
      }
      get data() {
        return this.#fields.data;
      }
      get dir() {
        return this.#fields.dir;
      }
      get lang() {
        return this.#fields.lang;
      }
      get icon() {
        return this.#fields.icon;
      }
      get badge() {
        return this.#fields.badge;
      }
      get image() {
        return this.#fields.image;
      }
      get silent() {
        return this.#fields.silent;
      }
      get requireInteraction() {
        return this.#fields.requireInteraction;
      }
      get renotify() {
        return this.#fields.renotify;
      }
      get timestamp() {
        return this.#fields.timestamp;
      }
      get actions() {
        return [];
      }
      static get permission() {
        return bridge.permission();
      }
      static get maxActions() {
        return 0;
      }
      static requestPermission(callback) {
        const result = bridge.requestPermission();
        if (typeof callback === "function") result.then(callback);
        return result;
      }
    }
    bridge.onEvent((id, type) => deliver(id, type));
    window.Notification = Notification;

    // A page showing a notification through its service worker's registration gets it in the
    // notification center too, kept by main for the registration like the ones the worker shows
    // itself (service-worker-preload.cjs): clicking it dispatches the worker's notificationclick.
    // Declared apart from their assignment, so they convert their arguments like the DOM does
    // whatever the typings say they are.
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
          bridge.showForRegistration({
            scope: this.scope,
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
      const { scope } = this;
      return Promise.resolve(bridge.listForRegistration({ scope, tag: text(filter?.tag) })).then(
        (infos) => infos.map((info) => adopt(scope, info)),
      );
    }
    const registration = globalThis.ServiceWorkerRegistration?.prototype;
    if (registration) {
      registration.showNotification = showNotification;
      registration.getNotifications = getNotifications;
    }

    // navigator.permissions.query() would ask Chromium, which denies notifications to every
    // page; report the permission the page's Notification has.
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
      requestPermission: () => ipcRenderer.invoke(BROWSER_NOTIFICATION_REQUEST_PERMISSION),
      show: (notification) => ipcRenderer.send(BROWSER_NOTIFICATION_SHOW, notification),
      close: (id) => ipcRenderer.send(BROWSER_NOTIFICATION_CLOSE, id),
      showForRegistration: (notification) =>
        ipcRenderer.invoke(REGISTRATION_NOTIFICATION_SHOW, notification),
      listForRegistration: (query) => ipcRenderer.invoke(REGISTRATION_NOTIFICATION_LIST, query),
      closeForRegistration: (notification) =>
        ipcRenderer.send(REGISTRATION_NOTIFICATION_CLOSE, notification),
      onEvent: (listener) => {
        ipcRenderer.on(BROWSER_NOTIFICATION_EVENT, (_event, id, type) => listener(id, type));
      },
    },
  ],
});

// Reports the page's camera and microphone permission to navigator.permissions.query(). Chromium
// asks main's check, which can only answer granted or denied, so a site the user hasn't decided
// for would read "denied" and video calls would show the devices as blocked instead of asking.
// Main answers "prompt" for those, and null for frames it leaves to Chromium. See browser-media.ts.

// Must match BROWSER_MEDIA_PERMISSION in ipc-channels.ts.
const BROWSER_MEDIA_PERMISSION = "browser-media:permission";

contextBridge.executeInMainWorld({
  func: (pageStates) => {
    const permissions = globalThis.Permissions?.prototype;
    const query = permissions && Object.getOwnPropertyDescriptor(permissions, "query")?.value;
    if (typeof query !== "function") return;
    permissions.query = function (descriptor, ...rest) {
      const status = Reflect.apply(query, this, [descriptor, ...rest]);
      const name = descriptor?.name;
      if (name !== "camera" && name !== "microphone") return status;
      return status.then((result) => {
        const chromium = Object.getPrototypeOf(result);
        Object.defineProperty(result, "state", {
          get() {
            const states = pageStates();
            return states ? states[name] : Reflect.get(chromium, "state", this);
          },
        });
        return result;
      });
    };
  },
  args: [() => ipcRenderer.sendSync(BROWSER_MEDIA_PERMISSION)],
});

// Reports each pointer lock change of this frame to main, which shows the pointer lock notice
// again when the user comes back after being away while the page still holds the lock. Main gets
// no signal of its own when the lock ends. Listens in the preload's isolated world, ahead of any
// listener the page adds, and reads the frame's own state there: a pointerlockchange the page
// dispatches itself is not trusted and reports nothing. See exclusive-access.ts.

// Must match POINTER_LOCK_CHANGE in ipc-channels.ts.
const POINTER_LOCK_CHANGE = "exclusive-access:pointer-lock-change";

window.addEventListener(
  "pointerlockchange",
  (event) => {
    if (!event.isTrusted) return;
    ipcRenderer.send(POINTER_LOCK_CHANGE, document.pointerLockElement !== null);
  },
  { capture: true },
);
