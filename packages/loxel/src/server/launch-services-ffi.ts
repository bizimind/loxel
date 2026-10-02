/**
 * macOS LaunchServices / AppKit access via bun:ffi and the Objective-C runtime.
 *
 * Only the LaunchServices helper process loads this module (see launch-services-helper.ts):
 * a bad pointer here is a segfault, and that must never take down the shared server.
 * All calls are synchronous; frameworks are loaded on first use.
 */
import { CString, dlopen, FFIType, linkSymbols, toArrayBuffer } from "bun:ffi";
import type { Pointer } from "bun:ffi";

import type { RawAppList } from "./launch-services-protocol";

/** `RTLD_DEFAULT` on macOS: search every image loaded in the process. */
const RTLD_DEFAULT = -2;
/** `NSBitmapImageFileTypePNG` */
const PNG_FILE_TYPE = 4;
/** Icons are rendered at 32pt, which is 64px on Retina screens: crisp for 16px CSS icons. */
const ICON_POINTS = 32;

const P = FFIType.ptr;

/** An Objective-C object/class/selector pointer as returned by bun:ffi. */
type ObjcPtr = Pointer | bigint;

function load() {
  const objc = dlopen("/usr/lib/libobjc.A.dylib", {
    objc_getClass: { args: [FFIType.cstring], returns: P },
    sel_registerName: { args: [FFIType.cstring], returns: P },
    objc_autoreleasePoolPush: { args: [], returns: P },
    objc_autoreleasePoolPop: { args: [P], returns: FFIType.void },
  }).symbols;
  // Loading AppKit registers NSWorkspace/NSImage/NSBitmapImageRep with the ObjC runtime.
  // The symbol is never called; dlopen just needs at least one.
  dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", {
    NSApplicationLoad: { args: [], returns: FFIType.bool },
  });
  const libSystem = dlopen("/usr/lib/libSystem.B.dylib", {
    dlsym: { args: [FFIType.i64, FFIType.cstring], returns: P },
  }).symbols;
  const msgSend = libSystem.dlsym(RTLD_DEFAULT, cstr("objc_msgSend"));
  if (!msgSend) throw new Error("objc_msgSend not found");

  // objc_msgSend must be called through a correctly typed signature per selector shape.
  const send = linkSymbols({
    id: { ptr: msgSend, args: [P, P], returns: P },
    idArg: { ptr: msgSend, args: [P, P, P], returns: P },
    idU64: { ptr: msgSend, args: [P, P, FFIType.u64], returns: P },
    u64: { ptr: msgSend, args: [P, P], returns: FFIType.u64 },
    // -[NSImage setSize:] takes an NSSize {double, double}. Both arm64 and x86_64 pass a
    // two-double struct in two floating-point registers, i.e. like two f64 arguments.
    setSize: { ptr: msgSend, args: [P, P, FFIType.f64, FFIType.f64], returns: FFIType.void },
    cgImage: { ptr: msgSend, args: [P, P, P, P, P], returns: P },
    pngData: { ptr: msgSend, args: [P, P, FFIType.u64, P], returns: P },
  }).symbols;

  const classCache = new Map<string, ObjcPtr>();
  const selectorCache = new Map<string, ObjcPtr>();
  const cls = (name: string) => cached(classCache, name, () => objc.objc_getClass(cstr(name)));
  const sel = (name: string) =>
    cached(selectorCache, name, () => objc.sel_registerName(cstr(name)));

  return { objc, send, cls, sel };
}

type Runtime = ReturnType<typeof load>;
let runtime: Runtime | undefined;

function getRuntime(): Runtime {
  runtime ??= load();
  return runtime;
}

function cstr(value: string): Buffer {
  return Buffer.from(`${value}\0`);
}

function cached(cache: Map<string, ObjcPtr>, key: string, lookup: () => ObjcPtr | null): ObjcPtr {
  const hit = cache.get(key);
  if (hit) return hit;
  const value = lookup();
  if (!value) throw new Error(`Objective-C lookup failed: ${key}`);
  cache.set(key, value);
  return value;
}

/** Run `fn` inside an autorelease pool so autoreleased objects are freed per call. */
function withPool<T>(rt: Runtime, fn: () => T): T {
  const pool = rt.objc.objc_autoreleasePoolPush();
  try {
    return fn();
  } finally {
    rt.objc.objc_autoreleasePoolPop(pool);
  }
}

function nsString(rt: Runtime, value: string): ObjcPtr {
  const str = rt.send.idArg(rt.cls("NSString"), rt.sel("stringWithUTF8String:"), cstr(value));
  if (!str) throw new Error("Failed to create NSString");
  return str;
}

function fileUrlPath(rt: Runtime, url: ObjcPtr): string {
  const path = rt.send.id(url, rt.sel("path"));
  const utf8 = path ? rt.send.id(path, rt.sel("UTF8String")) : null;
  if (!utf8) throw new Error("Failed to read URL path");
  return new CString(utf8);
}

/** Paths of the file URLs in an `NSArray<NSURL *>`. */
function fileUrlPaths(rt: Runtime, urls: ObjcPtr): string[] {
  const paths: string[] = [];
  const count = Number(rt.send.u64(urls, rt.sel("count")));
  for (let i = 0; i < count; i++) {
    const url = rt.send.idU64(urls, rt.sel("objectAtIndex:"), i);
    if (url) paths.push(fileUrlPath(rt, url));
  }
  return paths;
}

function sharedWorkspace(rt: Runtime): ObjcPtr {
  const ws = rt.send.id(rt.cls("NSWorkspace"), rt.sel("sharedWorkspace"));
  if (!ws) throw new Error("NSWorkspace unavailable");
  return ws;
}

/** Default app and all apps macOS offers for opening `path` (the Finder "Open With" list). */
export function listAppsForFile(path: string): RawAppList {
  const rt = getRuntime();
  return withPool(rt, () => {
    const ws = sharedWorkspace(rt);
    const url = rt.send.idArg(rt.cls("NSURL"), rt.sel("fileURLWithPath:"), nsString(rt, path));
    if (!url) throw new Error(`Invalid file path: ${path}`);

    const defaultUrl = rt.send.idArg(ws, rt.sel("URLForApplicationToOpenURL:"), url);
    const urls = rt.send.idArg(ws, rt.sel("URLsForApplicationsToOpenURL:"), url);
    const apps = urls ? fileUrlPaths(rt, urls) : [];
    return { defaultApp: defaultUrl ? fileUrlPath(rt, defaultUrl) : null, apps };
  });
}

/** The Finder icon of `appPath`, as PNG bytes. */
export function renderAppIcon(appPath: string): Uint8Array {
  const rt = getRuntime();
  return withPool(rt, () => {
    const ws = sharedWorkspace(rt);
    const image = rt.send.idArg(ws, rt.sel("iconForFile:"), nsString(rt, appPath));
    if (!image) throw new Error(`No icon for ${appPath}`);
    rt.send.setSize(image, rt.sel("setSize:"), ICON_POINTS, ICON_POINTS);

    const cgImage = rt.send.cgImage(
      image,
      rt.sel("CGImageForProposedRect:context:hints:"),
      null,
      null,
      null,
    );
    if (!cgImage) throw new Error(`Failed to rasterize icon for ${appPath}`);
    const allocated = rt.send.id(rt.cls("NSBitmapImageRep"), rt.sel("alloc"));
    const rep = allocated ? rt.send.idArg(allocated, rt.sel("initWithCGImage:"), cgImage) : null;
    if (!rep) throw new Error(`Failed to create bitmap for ${appPath}`);
    try {
      const data = rt.send.pngData(
        rep,
        rt.sel("representationUsingType:properties:"),
        PNG_FILE_TYPE,
        null,
      );
      const bytes = data ? rt.send.id(data, rt.sel("bytes")) : null;
      if (!data || !bytes) throw new Error(`Failed to encode icon for ${appPath}`);
      const length = Number(rt.send.u64(data, rt.sel("length")));
      // Copy out of the NSData buffer before the autorelease pool frees it.
      return new Uint8Array(toArrayBuffer(bytes, 0, length)).slice();
    } finally {
      rt.send.id(rep, rt.sel("release"));
    }
  });
}
