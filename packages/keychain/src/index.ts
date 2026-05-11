import type { Pointer } from "bun:ffi";

import { FFIType, dlopen, ptr, read, toArrayBuffer } from "bun:ffi";

// ─── Load system frameworks (always present on macOS) ────────────────────────

const CF = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const SEC = "/System/Library/Frameworks/Security.framework/Security";

const { symbols: cf } = dlopen(CF, {
  CFStringCreateWithBytes: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.i64, FFIType.u32, FFIType.u8],
    returns: FFIType.ptr,
  },
  CFDataCreate: { args: [FFIType.ptr, FFIType.ptr, FFIType.i64], returns: FFIType.ptr },
  CFDataGetLength: { args: [FFIType.ptr], returns: FFIType.i64 },
  CFDataGetBytePtr: { args: [FFIType.ptr], returns: FFIType.ptr },
  CFDictionaryCreateMutable: {
    args: [FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.ptr],
    returns: FFIType.ptr,
  },
  CFDictionarySetValue: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.ptr, // void — return value unused
  },
  CFRelease: {
    args: [FFIType.ptr],
    returns: FFIType.ptr, // void — return value unused
  },
});

const { symbols: sec } = dlopen(SEC, {
  SecItemCopyMatching: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  SecItemAdd: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  SecItemUpdate: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  SecItemDelete: { args: [FFIType.ptr], returns: FFIType.i32 },
});

// ─── Read CF/Security constants via dlsym ────────────────────────────────────

// We need raw dlopen/dlsym to read data symbol values (pointer-sized globals).
// RTLD_NOLOAD finds already-loaded libraries without reloading them.
const { symbols: dl } = dlopen("/usr/lib/libdl.dylib", {
  dlopen: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
  dlsym: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
});

const RTLD_NOLOAD = 0x10; // macOS: find already-loaded library, don't load fresh

// read.ptr returns number; cast to Pointer so it can be passed to FFI functions.
const asPtr = (n: number): Pointer => n as unknown as Pointer;

function openHandle(path: string): Pointer {
  const pathBuf = Buffer.from(path + "\0");
  const h = dl.dlopen(ptr(pathBuf), RTLD_NOLOAD);
  if (!h) throw new Error(`dlopen(RTLD_NOLOAD) failed for ${path}`);
  return h;
}

// dlsym returns the address of the named symbol.
// For CF pointer constants (CFStringRef, CFBooleanRef etc.), dereference the address
// to get the actual CFTypeRef pointer stored at that location.
function cfConst(handle: Pointer, name: string): Pointer {
  const nameBuf = Buffer.from(name + "\0");
  const addr = dl.dlsym(handle, ptr(nameBuf));
  if (!addr) throw new Error(`dlsym: ${name} not found`);
  return asPtr(read.ptr(addr, 0));
}

// For struct constants (kCFTypeDictionaryKeyCallBacks etc.), CFDictionary expects a
// pointer TO the struct — which is exactly the symbol address dlsym returns.
function cfStructAddr(handle: Pointer, name: string): Pointer {
  const nameBuf = Buffer.from(name + "\0");
  const addr = dl.dlsym(handle, ptr(nameBuf));
  if (!addr) throw new Error(`dlsym: ${name} not found`);
  return addr;
}

const cfHandle = openHandle(CF);
const secHandle = openHandle(SEC);

const kCFAllocatorDefault = null; // NULL = use default allocator
const kCFStringEncodingUTF8 = 0x08000100;
const kCFTypeDictionaryKeyCallBacks = cfStructAddr(cfHandle, "kCFTypeDictionaryKeyCallBacks");
const kCFTypeDictionaryValueCallBacks = cfStructAddr(cfHandle, "kCFTypeDictionaryValueCallBacks");
const kCFBooleanTrue = cfConst(cfHandle, "kCFBooleanTrue");

const kSecClass = cfConst(secHandle, "kSecClass");
const kSecClassGenericPassword = cfConst(secHandle, "kSecClassGenericPassword");
const kSecAttrService = cfConst(secHandle, "kSecAttrService");
const kSecAttrAccount = cfConst(secHandle, "kSecAttrAccount");
const kSecReturnData = cfConst(secHandle, "kSecReturnData");
const kSecMatchLimit = cfConst(secHandle, "kSecMatchLimit");
const kSecMatchLimitOne = cfConst(secHandle, "kSecMatchLimitOne");
const kSecValueData = cfConst(secHandle, "kSecValueData");

// ─── OSStatus codes ──────────────────────────────────────────────────────────

const errSecSuccess = 0;
const errSecItemNotFound = -25300;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCFString(s: string): Pointer {
  const bytes = Buffer.from(s, "utf8");
  const ref = cf.CFStringCreateWithBytes(
    kCFAllocatorDefault,
    ptr(bytes),
    bytes.byteLength,
    kCFStringEncodingUTF8,
    0, // isExternalRepresentation = false
  );
  if (!ref) throw new Error(`CFStringCreateWithBytes failed for "${s}"`);
  return ref;
}

function makeQueryDict(
  service: string,
  account: string,
): { dict: Pointer; svc: Pointer; acct: Pointer } {
  const svc = makeCFString(service);
  const acct = makeCFString(account);
  const dict = cf.CFDictionaryCreateMutable(
    kCFAllocatorDefault,
    0, // capacity — 0 means unlimited
    kCFTypeDictionaryKeyCallBacks,
    kCFTypeDictionaryValueCallBacks,
  );
  if (!dict) throw new Error("CFDictionaryCreateMutable failed");
  cf.CFDictionarySetValue(dict, kSecClass, kSecClassGenericPassword);
  cf.CFDictionarySetValue(dict, kSecAttrService, svc);
  cf.CFDictionarySetValue(dict, kSecAttrAccount, acct);
  return { dict, svc, acct };
}

function releaseQuery({ dict, svc, acct }: { dict: Pointer; svc: Pointer; acct: Pointer }): void {
  cf.CFRelease(dict);
  cf.CFRelease(svc);
  cf.CFRelease(acct);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function getSecret(service: string, account: string): Buffer | null {
  const q = makeQueryDict(service, account);
  cf.CFDictionarySetValue(q.dict, kSecReturnData, kCFBooleanTrue);
  cf.CFDictionarySetValue(q.dict, kSecMatchLimit, kSecMatchLimitOne);

  // SecItemCopyMatching writes a CFDataRef pointer into this slot
  const resultSlot = new BigUint64Array(1);
  const status = sec.SecItemCopyMatching(q.dict, ptr(resultSlot));
  releaseQuery(q);

  if (status === errSecItemNotFound) return null;
  if (status !== errSecSuccess) throw new Error(`Keychain read failed (OSStatus ${status})`);

  const dataRef = asPtr(Number(resultSlot[0]));
  const len = Number(cf.CFDataGetLength(dataRef));
  const bytesPtr = cf.CFDataGetBytePtr(dataRef)!;
  // Buffer.from(ArrayBuffer) creates a shared view — copy before CFRelease frees the backing memory.
  // Buffer.from(TypedArray) copies, so route via Uint8Array.
  const result = Buffer.from(new Uint8Array(toArrayBuffer(bytesPtr, 0, len)));
  cf.CFRelease(dataRef);
  return result;
}

export function setSecret(service: string, account: string, secret: Buffer): void {
  const data = cf.CFDataCreate(kCFAllocatorDefault, ptr(secret), secret.byteLength);
  if (!data) throw new Error("CFDataCreate failed");

  const q = makeQueryDict(service, account);

  // Try update first (item already exists)
  const attrs = cf.CFDictionaryCreateMutable(
    kCFAllocatorDefault,
    0,
    kCFTypeDictionaryKeyCallBacks,
    kCFTypeDictionaryValueCallBacks,
  );
  if (!attrs) throw new Error("CFDictionaryCreateMutable failed");
  cf.CFDictionarySetValue(attrs, kSecValueData, data);

  let status = sec.SecItemUpdate(q.dict, attrs);

  if (status === errSecItemNotFound) {
    // Item doesn't exist — add it
    cf.CFDictionarySetValue(q.dict, kSecValueData, data);
    status = sec.SecItemAdd(q.dict, null);
  }

  cf.CFRelease(attrs);
  cf.CFRelease(data);
  releaseQuery(q);

  if (status !== errSecSuccess) throw new Error(`Keychain write failed (OSStatus ${status})`);
}

export function deleteSecret(service: string, account: string): boolean {
  const q = makeQueryDict(service, account);
  const status = sec.SecItemDelete(q.dict);
  releaseQuery(q);

  if (status === errSecItemNotFound) return false;
  if (status !== errSecSuccess) throw new Error(`Keychain delete failed (OSStatus ${status})`);
  return true;
}
