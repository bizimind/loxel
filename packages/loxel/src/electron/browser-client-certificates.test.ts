import { describe, expect, mock, test } from "bun:test";

import type { BrowserWindow, Certificate, MessageBoxOptions, Session, WebContents } from "electron";

type Listener = (...args: unknown[]) => void;

const appListeners = new Map<string, Listener>();
const windows = new Map<WebContents, BrowserWindow>();
const shownBoxes: { win: BrowserWindow | undefined; options: MessageBoxOptions }[] = [];
let boxResponse = 0;
void mock.module("electron", () => ({
  app: { on: (event: string, listener: Listener) => appListeners.set(event, listener) },
  BrowserWindow: { fromWebContents: (contents: WebContents) => windows.get(contents) ?? null },
  dialog: {
    showMessageBox: (...args: [BrowserWindow, MessageBoxOptions] | [MessageBoxOptions]) => {
      const [win, options] = args.length === 2 ? args : [undefined, args[0]];
      shownBoxes.push({ win, options });
      return Promise.resolve({ response: boxResponse, checkboxChecked: false });
    },
  },
}));

const {
  certificateLabel,
  certificateQuestion,
  createClientCertificatePicker,
  installClientCertificatePicker,
  MAX_DECLINES_PER_PAGE,
  serverLabel,
  serverOf,
} = await import("./browser-client-certificates");

function certificate(name: string): Certificate {
  return {
    data: `-----BEGIN CERTIFICATE-----\n${name}\n-----END CERTIFICATE-----\n`,
    fingerprint: `sha256/${name}`,
    subjectName: name,
    issuerName: "Example CA",
    validExpiry: Date.UTC(2027, 0, 31) / 1000,
  } as Certificate;
}

const ALICE = certificate("Alice");
const BOB = certificate("Bob");

interface FakePage {
  contents: WebContents;
  destroy: () => void;
  emit: (event: string, ...args: unknown[]) => void;
}

function fakePage(options: { host?: WebContents; session?: Session; url?: string } = {}): FakePage {
  let destroyed = false;
  const listeners = new Map<string, Listener[]>();
  const contents = {
    isDestroyed: () => destroyed,
    hostWebContents: options.host,
    session: options.session ?? {},
    getURL: () => options.url ?? "https://page.test/",
    on: (event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
  } as unknown as WebContents;
  return {
    contents,
    destroy: () => {
      destroyed = true;
    },
    emit: (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
}

interface AskedQuestion {
  server: string;
  labels: string[];
  answer: (index: number | null) => void;
}

/** A picker whose prompt the test answers, recording each question. */
function controlledPicker() {
  const asked: AskedQuestion[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  const picker = createClientCertificatePicker(
    (_contents, question, labels) =>
      new Promise<number | null>((resolve) => {
        asked.push({ server: question.server, labels, answer: resolve });
        for (const waiter of waiters.filter((w) => asked.length >= w.count)) waiter.resolve();
      }),
  );
  /** Resolves with the questions once `count` have been asked. */
  const askedCount = (count: number): Promise<AskedQuestion[]> =>
    asked.length >= count
      ? Promise.resolve(asked)
      : new Promise((resolve) => {
          waiters.push({ count, resolve: () => resolve(asked) });
        });
  const request = (contents: WebContents, server: string, certificates: Certificate[]) =>
    picker.pick({ contents, question: { server, page: null }, certificates });
  return { asked, askedCount, request, picker };
}

describe("serverOf", () => {
  test("names the host and port, the scheme's default port included", () => {
    expect(serverOf("https://example.com/a")).toBe("example.com:443");
    expect(serverOf("http://example.com:8080/")).toBe("example.com:8080");
    expect(serverOf("https://[::1]:8443/")).toBe("[::1]:8443");
  });

  test("is null for URLs without a host", () => {
    expect(serverOf("about:blank")).toBeNull();
    expect(serverOf("not a url")).toBeNull();
  });
});

describe("serverLabel", () => {
  test("drops only the default https port", () => {
    expect(serverLabel("example.com:443")).toBe("example.com");
    expect(serverLabel("example.com:8443")).toBe("example.com:8443");
  });
});

describe("certificateLabel", () => {
  test("names the subject, issuer and expiry", () => {
    expect(certificateLabel(ALICE)).toBe("Alice (issued by Example CA, valid until 2027-01-31)");
  });
});

describe("certificateQuestion", () => {
  test("names only the server for the page's own server", () => {
    expect(certificateQuestion("page.test:443", "https://page.test/x", null)).toEqual({
      server: "page.test:443",
      page: null,
    });
  });

  test("names only the server for the document the main frame is loading", () => {
    expect(
      certificateQuestion("intranet.test:443", "https://page.test/", "https://intranet.test/"),
    ).toEqual({ server: "intranet.test:443", page: null });
  });

  test("names the page for a request to another server", () => {
    expect(certificateQuestion("intranet.test:443", "https://page.test/", null)).toEqual({
      server: "intranet.test:443",
      page: "page.test",
    });
    expect(
      certificateQuestion("intranet.test:443", "https://page.test/", "https://other.test/"),
    ).toEqual({ server: "intranet.test:443", page: "page.test" });
  });

  test("names only the server when the page has no host", () => {
    expect(certificateQuestion("intranet.test:443", "about:blank", null).page).toBeNull();
  });
});

describe("createClientCertificatePicker", () => {
  test("asks with the server and gives the certificate chosen", async () => {
    const { askedCount, request } = controlledPicker();
    const answer = request(fakePage().contents, "a.test:443", [ALICE, BOB]);
    const [question] = await askedCount(1);
    expect(question!.server).toBe("a.test:443");
    expect(question!.labels).toEqual([certificateLabel(ALICE), certificateLabel(BOB)]);
    question!.answer(1);
    expect(await answer).toBe(BOB);
  });

  test("remembers the certificate per server", async () => {
    const { asked, askedCount, request } = controlledPicker();
    const page = fakePage().contents;
    const first = request(page, "a.test:443", [ALICE, BOB]);
    (await askedCount(1))[0]!.answer(1);
    await first;
    expect(await request(page, "a.test:443", [ALICE, BOB])).toBe(BOB);
    expect(asked).toHaveLength(1);

    void request(page, "a.test:8443", [ALICE, BOB]);
    expect((await askedCount(2)).map((q) => q.server)).toEqual(["a.test:443", "a.test:8443"]);
  });

  test("remembers none per server", async () => {
    const { asked, askedCount, request } = controlledPicker();
    const page = fakePage().contents;
    const first = request(page, "a.test:443", [ALICE]);
    (await askedCount(1))[0]!.answer(null);
    expect(await first).toBeUndefined();
    expect(await request(page, "a.test:443", [ALICE])).toBeUndefined();
    expect(asked).toHaveLength(1);
  });

  test("asks again when the certificate chosen is not offered", async () => {
    const { askedCount, request } = controlledPicker();
    const page = fakePage().contents;
    const first = request(page, "a.test:443", [ALICE]);
    (await askedCount(1))[0]!.answer(0);
    await first;
    const second = request(page, "a.test:443", [BOB]);
    const again = (await askedCount(2))[1]!;
    expect(again.labels).toEqual([certificateLabel(BOB)]);
    again.answer(0);
    expect(await second).toBe(BOB);
  });

  test("requests for a server whose question is open share its answer", async () => {
    const { asked, askedCount, request } = controlledPicker();
    const first = request(fakePage().contents, "a.test:443", [ALICE, BOB]);
    const second = request(fakePage().contents, "a.test:443", [ALICE, BOB]);
    (await askedCount(1))[0]!.answer(0);
    expect(await Promise.all([first, second])).toEqual([ALICE, ALICE]);
    expect(asked).toHaveLength(1);
  });

  test("a request sharing a question asks again when the answer isn't in its list", async () => {
    const { askedCount, request } = controlledPicker();
    const page = fakePage().contents;
    const first = request(page, "a.test:443", [ALICE, BOB]);
    const second = request(page, "a.test:443", [BOB]);
    (await askedCount(1))[0]!.answer(0);
    expect(await first).toBe(ALICE);
    const again = (await askedCount(2))[1]!;
    expect(again.labels).toEqual([certificateLabel(BOB)]);
    again.answer(0);
    expect(await second).toBe(BOB);
  });

  test("a page asks one question at a time; other pages don't wait", async () => {
    const { asked, askedCount, request } = controlledPicker();
    const page = fakePage().contents;
    const first = request(page, "a.test:443", [ALICE]);
    const second = request(page, "b.test:443", [BOB]);
    const other = request(fakePage().contents, "c.test:443", [ALICE]);
    expect((await askedCount(2)).map((q) => q.server)).toEqual(["a.test:443", "c.test:443"]);
    asked[1]!.answer(null);
    expect(await other).toBeUndefined();
    expect(asked).toHaveLength(2);
    asked[0]!.answer(0);
    expect(await first).toBe(ALICE);
    const next = (await askedCount(3))[2]!;
    expect(next.server).toBe("b.test:443");
    next.answer(0);
    expect(await second).toBe(BOB);
  });

  test("refuses a page without asking once it was declined enough, until it navigates", async () => {
    const { asked, askedCount, request, picker } = controlledPicker();
    const page = fakePage().contents;
    for (let i = 0; i < MAX_DECLINES_PER_PAGE; i++) {
      const declined = request(page, `d${i}.test:443`, [ALICE]);
      (await askedCount(i + 1))[i]!.answer(null);
      await declined;
    }
    expect(await request(page, "next.test:443", [ALICE])).toBeUndefined();
    expect(asked).toHaveLength(MAX_DECLINES_PER_PAGE);

    picker.pageNavigated(page);
    void request(page, "next.test:443", [ALICE]);
    expect(await askedCount(MAX_DECLINES_PER_PAGE + 1)).toHaveLength(MAX_DECLINES_PER_PAGE + 1);
  });

  test("a request waiting its turn gets none if the page is declined enough meanwhile", async () => {
    const { asked, askedCount, request } = controlledPicker();
    const page = fakePage().contents;
    const first = request(page, "a.test:443", [ALICE]);
    (await askedCount(1))[0]!.answer(null);
    await first;
    const second = request(page, "b.test:443", [ALICE]);
    const waiting = request(page, "c.test:443", [ALICE]);
    (await askedCount(2))[1]!.answer(null);
    expect(await Promise.all([second, waiting])).toEqual([undefined, undefined]);
    expect(asked).toHaveLength(2);
  });

  test("a page closed while waiting its turn is not asked about", async () => {
    const { asked, askedCount, request } = controlledPicker();
    const page = fakePage();
    const first = request(page.contents, "a.test:443", [ALICE]);
    const waiting = request(page.contents, "b.test:443", [ALICE]);
    const [question] = await askedCount(1);
    page.destroy();
    question!.answer(0);
    expect(await Promise.all([first, waiting])).toEqual([ALICE, undefined]);
    expect(asked).toHaveLength(1);
  });
});

describe("installClientCertificatePicker", () => {
  const browserSession = {} as Session;
  installClientCertificatePicker((candidate) => candidate === browserSession);
  const select = appListeners.get("select-client-certificate")!;
  const created = appListeners.get("web-contents-created")!;

  /** Emit a request and resolve with what the callback got. */
  function emit(contents: WebContents | null, server: string, certificates: Certificate[]) {
    const preventDefault = mock(() => {});
    const answer = new Promise<Certificate | undefined>((resolve) => {
      select({ preventDefault }, contents, server, certificates, resolve);
    });
    return { preventDefault, answer };
  }

  test("refuses Loxel's own pages and main-process requests without a dialog", async () => {
    const fromOwn = emit(fakePage().contents, "own.test:443", [ALICE]);
    const fromMain = emit(null, "main.test:443", [ALICE]);
    expect(fromOwn.preventDefault).toHaveBeenCalledTimes(1);
    expect(fromMain.preventDefault).toHaveBeenCalledTimes(1);
    expect(await fromOwn.answer).toBeUndefined();
    expect(await fromMain.answer).toBeUndefined();
    expect(shownBoxes).toHaveLength(0);
  });

  test("asks over the window hosting a browser panel's webview", async () => {
    const host = fakePage().contents;
    const win = {} as BrowserWindow;
    windows.set(host, win);
    const guest = fakePage({ host, session: browserSession, url: "https://site.test/" });
    created({}, guest.contents);
    boxResponse = 1;
    const { preventDefault, answer } = emit(guest.contents, "site.test:443", [ALICE, BOB]);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(await answer).toBe(BOB);
    const shown = shownBoxes.at(-1)!;
    expect(shown.win).toBe(win);
    expect(shown.options.message).toBe(
      "site.test asks for a certificate to identify you. Which one do you want to use?",
    );
    expect(shown.options.buttons).toEqual([
      certificateLabel(ALICE),
      certificateLabel(BOB),
      "Don't Use a Certificate",
    ]);
    expect(shown.options.defaultId).toBe(2);
    expect(shown.options.cancelId).toBe(2);
  });

  test("names the page for another server, but not for the document it navigates to", async () => {
    const popup = fakePage({ session: browserSession, url: "https://page.test/" });
    created({}, popup.contents);
    boxResponse = 0;
    await emit(popup.contents, "intranet.test:8443", [ALICE, BOB]).answer;
    expect(shownBoxes.at(-1)!.options.message).toBe(
      "A page on page.test connects to intranet.test:8443, which asks for a certificate to identify you. Which one do you want to use?",
    );

    popup.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
      url: "https://next.test/",
    });
    await emit(popup.contents, "next.test:443", [ALICE]).answer;
    expect(shownBoxes.at(-1)!.options.message).toStartWith("next.test asks");
  });

  test("names the page again once a navigation stops without committing", async () => {
    const page = fakePage({ session: browserSession, url: "https://page.test/" });
    created({}, page.contents);
    page.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
      url: "https://stopped.test/",
    });
    page.emit("did-stop-loading");
    boxResponse = 1;
    await emit(page.contents, "stopped.test:443", [ALICE]).answer;
    expect(shownBoxes.at(-1)!.options.message).toStartWith(
      "A page on page.test connects to stopped.test,",
    );
  });

  test("sends none when the user declines", async () => {
    const popup = fakePage({ session: browserSession });
    created({}, popup.contents);
    boxResponse = 1;
    expect(await emit(popup.contents, "declined.test:443", [ALICE]).answer).toBeUndefined();
  });
});
