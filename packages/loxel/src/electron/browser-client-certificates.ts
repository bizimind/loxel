/**
 * TLS client certificates for browser panels. When a site asks for one, Electron emits
 * `select-client-certificate` and, unless a listener calls `preventDefault()`, silently gives the
 * site the first matching identity in the keychain, with the name, email and organization it
 * carries. Loxel asks instead, as Chrome does: browser panel pages (webviews and their popups) get a
 * dialog listing the certificates, or none, and every other request is refused without one.
 */

import {
  BrowserWindow,
  type Certificate,
  type Session,
  type WebContents,
  app,
  dialog,
} from "electron";

import { whileHoldingExclusiveAccess } from "./exclusive-access-holds";

/** After this many "Don't Use a Certificate" answers, a page is refused without asking until it navigates. */
export const MAX_DECLINES_PER_PAGE = 2;

/** What the dialog asks about: the server, and the top-level page when that isn't the server. */
export interface CertificateQuestion {
  /** The server asking, as `host:port`. */
  server: string;
  /** The host of the page's top-level document when it isn't `server`'s, else null. */
  page: string | null;
}

/** Asks the user which of `labels` the server gets: resolves with its index, or null for none. */
export type CertificatePrompt = (
  contents: WebContents,
  question: CertificateQuestion,
  labels: string[],
) => Promise<number | null>;

/** One request from a browser panel page, as the picker decides it. */
export interface ClientCertificateRequest {
  contents: WebContents;
  question: CertificateQuestion;
  certificates: Certificate[];
}

/** The `host:port` a URL connects to, as Chromium names a server, or null if it has no host. */
export function serverOf(url: string): string | null {
  try {
    const { protocol, hostname, port } = new URL(url);
    if (!hostname) return null;
    const defaultPort = protocol === "https:" || protocol === "wss:" ? "443" : "80";
    return `${hostname}:${port || defaultPort}`;
  } catch {
    return null;
  }
}

/** A server as the dialog names it: without the port when it is the default `https` one. */
export function serverLabel(server: string): string {
  return server.endsWith(":443") ? server.slice(0, -":443".length) : server;
}

/**
 * The question for a request to `server` from a page whose top-level document is at `pageUrl`, while
 * its main frame may be navigating to `navigatingTo`. A request for the document being loaded, or
 * for the page's own server, names only the server; any other names the page too, so a page can't
 * pass off a request to another site (an intranet, say) as its own.
 */
export function certificateQuestion(
  server: string,
  pageUrl: string,
  navigatingTo: string | null,
): CertificateQuestion {
  if (navigatingTo !== null && serverOf(navigatingTo) === server) return { server, page: null };
  const pageServer = serverOf(pageUrl);
  if (pageServer === null || pageServer === server) return { server, page: null };
  return { server, page: new URL(pageUrl).hostname };
}

/** A certificate as the dialog lists it: subject, issuer and expiry tell identities apart. */
export function certificateLabel(certificate: Certificate): string {
  const expiry = new Date(certificate.validExpiry * 1000).toISOString().slice(0, 10);
  return `${certificate.subjectName} (issued by ${certificate.issuerName}, valid until ${expiry})`;
}

/** What the picker keeps about one page. */
interface PageState {
  /** Settles when the page's current question, if any, is answered: a page asks one at a time. */
  turn: Promise<void>;
  declines: number;
}

/**
 * The picker's decisions: which certificate, if any, a browser panel page's request gets. Each
 * server (`host:port`) is asked about once per app run, and the answer, a certificate or none, is
 * kept in memory only. Requests for a server whose question is open share its answer, and a kept
 * certificate the request doesn't list is asked about again. A page shows one question at a time,
 * the rest waiting their turn, and once the user has declined `MAX_DECLINES_PER_PAGE` of its
 * questions, its further requests get none without asking until `pageNavigated`.
 */
export function createClientCertificatePicker(prompt: CertificatePrompt): {
  pick: (request: ClientCertificateRequest) => Promise<Certificate | undefined>;
  pageNavigated: (contents: WebContents) => void;
} {
  // Server → fingerprint of the certificate chosen, or null for none.
  const answers = new Map<string, string | null>();
  const questions = new Map<string, Promise<void>>();
  const pages = new WeakMap<WebContents, PageState>();

  const pageState = (contents: WebContents): PageState => {
    let state = pages.get(contents);
    if (!state) {
      state = { turn: Promise.resolve(), declines: 0 };
      pages.set(contents, state);
    }
    return state;
  };
  const blocked = (contents: WebContents) =>
    contents.isDestroyed() || pageState(contents).declines >= MAX_DECLINES_PER_PAGE;

  /** Ask once it is the page's turn, unless the page was blocked or closed meanwhile. */
  const ask = ({ contents, question, certificates }: ClientCertificateRequest): Promise<void> => {
    const state = pageState(contents);
    const asked = state.turn.then(async () => {
      if (blocked(contents)) return;
      const index = await prompt(contents, question, certificates.map(certificateLabel));
      const fingerprint = index === null ? null : (certificates[index]?.fingerprint ?? null);
      answers.set(question.server, fingerprint);
      if (fingerprint === null) state.declines += 1;
    });
    state.turn = asked.catch(() => {});
    return asked;
  };

  const pick = async (request: ClientCertificateRequest): Promise<Certificate | undefined> => {
    const { contents, question, certificates } = request;
    for (;;) {
      const answer = answers.get(question.server);
      if (answer === null) return undefined;
      const kept = certificates.find((c) => c.fingerprint === answer);
      if (kept) return kept;
      const open = questions.get(question.server);
      if (open) {
        await open;
        continue;
      }
      if (blocked(contents)) return undefined;
      const asked = ask(request).finally(() => questions.delete(question.server));
      questions.set(question.server, asked);
      await asked;
    }
  };

  const pageNavigated = (contents: WebContents) => {
    pageState(contents).declines = 0;
  };

  return { pick, pageNavigated };
}

/**
 * The dialog, attached to the window showing the page: a webview's host window, or the popup. The
 * page holds neither fullscreen nor the pointer lock while it is open.
 */
const promptForCertificate: CertificatePrompt = async (contents, question, labels) => {
  const shown = contents.hostWebContents ?? contents;
  const win = shown.isDestroyed() ? null : BrowserWindow.fromWebContents(shown);
  const server = serverLabel(question.server);
  const asking =
    question.page === null
      ? `${server} asks for a certificate to identify you.`
      : `A page on ${question.page} connects to ${server}, which asks for a certificate to identify you.`;
  const options: Electron.MessageBoxOptions = {
    type: "question",
    title: "Select a certificate",
    message: `${asking} Which one do you want to use?`,
    detail: `${server} sees the name, email address and organization in the certificate you choose. Loxel remembers your choice for ${server} until it quits.`,
    buttons: [...labels, "Don't Use a Certificate"],
    // Return and Esc both send none, so a stray key press never hands over an identity.
    defaultId: labels.length,
    cancelId: labels.length,
  };
  const { response } = await whileHoldingExclusiveAccess(contents.id, () =>
    win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options),
  );
  return response < labels.length ? response : null;
};

/** Follow a browser panel page's main-frame navigations: the one in progress, and each commit. */
function trackNavigations(
  contents: WebContents,
  navigating: WeakMap<WebContents, string>,
  onCommit: () => void,
): void {
  const start = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (details.isMainFrame && !details.isSameDocument) navigating.set(contents, details.url);
  };
  contents.on("did-start-navigation", start);
  contents.on("did-redirect-navigation", start);
  contents.on("did-navigate", () => {
    navigating.delete(contents);
    onCommit();
  });
  contents.on("did-fail-load", (_event, _code, _description, _url, isMainFrame) => {
    if (isMainFrame) navigating.delete(contents);
  });
  // Navigations that don't commit (stopped, downloads, 204) emit neither event above. The page
  // counts as loading until a pending navigation is decided, so this never ends one early.
  contents.on("did-stop-loading", () => navigating.delete(contents));
}

/** Decide every client certificate request: ask for browser panel pages, refuse the rest. */
export function installClientCertificatePicker(browserSession: Session): void {
  const { pick, pageNavigated } = createClientCertificatePicker(promptForCertificate);
  const navigating = new WeakMap<WebContents, string>();
  app.on("web-contents-created", (_event, contents) => {
    if (contents.session !== browserSession) return;
    trackNavigations(contents, navigating, () => pageNavigated(contents));
  });

  app.on("select-client-certificate", (event, contents, server, certificates, callback) => {
    // Synchronously, or Electron gives the site the first certificate.
    event.preventDefault();
    // Electron's types say `url`, but it passes the server's `host:port`. Calling back with no
    // certificate sends none, which Chromium then keeps for that server as it keeps a chosen
    // certificate. Requests without a webContents (main-process `net`, and a browser panel's
    // service workers, which Chrome gives none either) and Loxel's own pages get none.
    if (!contents || contents.isDestroyed() || contents.session !== browserSession) {
      callback();
      return;
    }
    const question = certificateQuestion(
      server,
      contents.getURL(),
      navigating.get(contents) ?? null,
    );
    pick({ contents, question, certificates })
      .catch((err: unknown) => {
        console.error("[electron] Client certificate selection failed:", err);
        return undefined;
      })
      .then((certificate) => callback(certificate));
  });
}
