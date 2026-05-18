import type { Pointer } from "bun:ffi";
import { FFIType, dlopen, ptr, read, toArrayBuffer } from "bun:ffi";

const CF = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const SEC = "/System/Library/Frameworks/Security.framework/Security";
const RTLD_NOLOAD = 0x10;
const kCFNumberSInt32Type = 3;
const errSecSuccess = 0;
const errSecItemNotFound = -25300;

type Native = ReturnType<typeof loadNative>;

let native: Native | null = null;

const asPtr = (n: number): Pointer => n as unknown as Pointer;

function unsupportedPlatform(): never {
  throw new Error("@bizimind/keychain is only supported on macOS");
}

function getNative(): Native {
  if (process.platform !== "darwin") unsupportedPlatform();
  native ??= loadNative();
  return native;
}

function loadNative() {
  const { symbols: cf } = dlopen(CF, {
    CFDataCreate: { args: [FFIType.ptr, FFIType.ptr, FFIType.i64], returns: FFIType.ptr },
    CFDataGetLength: { args: [FFIType.ptr], returns: FFIType.i64 },
    CFDataGetBytePtr: { args: [FFIType.ptr], returns: FFIType.ptr },
    CFNumberCreate: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
    CFDictionaryCreateMutable: {
      args: [FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.ptr],
      returns: FFIType.ptr,
    },
    CFDictionarySetValue: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
    CFErrorCopyDescription: { args: [FFIType.ptr], returns: FFIType.ptr },
    CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
  });

  const { symbols: sec } = dlopen(SEC, {
    SecItemCopyMatching: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    SecItemDelete: { args: [FFIType.ptr], returns: FFIType.i32 },
    SecKeyCreateRandomKey: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    SecKeyCopyPublicKey: { args: [FFIType.ptr], returns: FFIType.ptr },
    SecKeyCreateEncryptedData: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.ptr,
    },
    SecKeyCreateDecryptedData: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.ptr,
    },
  });

  const { symbols: dl } = dlopen("/usr/lib/libdl.dylib", {
    dlopen: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
    dlsym: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  });

  function openHandle(path: string): Pointer {
    const pathBuf = Buffer.from(path + "\0");
    const handle = dl.dlopen(ptr(pathBuf), RTLD_NOLOAD);
    if (!handle) throw new Error(`dlopen(RTLD_NOLOAD) failed for ${path}`);
    return handle;
  }

  function cfConst(handle: Pointer, name: string): Pointer {
    const nameBuf = Buffer.from(name + "\0");
    const addr = dl.dlsym(handle, ptr(nameBuf));
    if (!addr) throw new Error(`dlsym: ${name} not found`);
    return asPtr(read.ptr(addr, 0));
  }

  function cfStructAddr(handle: Pointer, name: string): Pointer {
    const nameBuf = Buffer.from(name + "\0");
    const addr = dl.dlsym(handle, ptr(nameBuf));
    if (!addr) throw new Error(`dlsym: ${name} not found`);
    return addr;
  }

  const cfHandle = openHandle(CF);
  const secHandle = openHandle(SEC);

  return {
    cf,
    sec,
    kCFAllocatorDefault: null,
    kCFTypeDictionaryKeyCallBacks: cfStructAddr(cfHandle, "kCFTypeDictionaryKeyCallBacks"),
    kCFTypeDictionaryValueCallBacks: cfStructAddr(cfHandle, "kCFTypeDictionaryValueCallBacks"),
    kCFBooleanTrue: cfConst(cfHandle, "kCFBooleanTrue"),
    kSecClass: cfConst(secHandle, "kSecClass"),
    kSecClassKey: cfConst(secHandle, "kSecClassKey"),
    kSecAttrApplicationTag: cfConst(secHandle, "kSecAttrApplicationTag"),
    kSecAttrAccessible: cfConst(secHandle, "kSecAttrAccessible"),
    kSecAttrAccessibleAfterFirstUnlock: cfConst(secHandle, "kSecAttrAccessibleAfterFirstUnlock"),
    kSecAttrIsPermanent: cfConst(secHandle, "kSecAttrIsPermanent"),
    kSecAttrKeyClass: cfConst(secHandle, "kSecAttrKeyClass"),
    kSecAttrKeyClassPrivate: cfConst(secHandle, "kSecAttrKeyClassPrivate"),
    kSecAttrKeySizeInBits: cfConst(secHandle, "kSecAttrKeySizeInBits"),
    kSecAttrKeyType: cfConst(secHandle, "kSecAttrKeyType"),
    kSecAttrKeyTypeRSA: cfConst(secHandle, "kSecAttrKeyTypeRSA"),
    kSecPrivateKeyAttrs: cfConst(secHandle, "kSecPrivateKeyAttrs"),
    kSecReturnRef: cfConst(secHandle, "kSecReturnRef"),
    kSecUseDataProtectionKeychain: cfConst(secHandle, "kSecUseDataProtectionKeychain"),
    kSecKeyAlgorithmRSAEncryptionOAEPSHA256: cfConst(
      secHandle,
      "kSecKeyAlgorithmRSAEncryptionOAEPSHA256",
    ),
  };
}

function makeCFData(n: Native, value: Buffer): Pointer {
  const ref = n.cf.CFDataCreate(n.kCFAllocatorDefault, ptr(value), value.byteLength);
  if (!ref) throw new Error("CFDataCreate failed");
  return ref;
}

function makeCFNumber(n: Native, value: number): Pointer {
  const slot = new Int32Array([value]);
  const ref = n.cf.CFNumberCreate(n.kCFAllocatorDefault, kCFNumberSInt32Type, ptr(slot));
  if (!ref) throw new Error(`CFNumberCreate failed for ${value}`);
  return ref;
}

function makeDict(n: Native): Pointer {
  const dict = n.cf.CFDictionaryCreateMutable(
    n.kCFAllocatorDefault,
    0,
    n.kCFTypeDictionaryKeyCallBacks,
    n.kCFTypeDictionaryValueCallBacks,
  );
  if (!dict) throw new Error("CFDictionaryCreateMutable failed");
  return dict;
}

function copyCFData(n: Native, dataRef: Pointer): Buffer {
  const len = Number(n.cf.CFDataGetLength(dataRef));
  const bytesPtr = n.cf.CFDataGetBytePtr(dataRef);
  if (!bytesPtr) throw new Error("CFDataGetBytePtr failed");
  return Buffer.from(new Uint8Array(toArrayBuffer(bytesPtr, 0, len)));
}

function errorDescription(n: Native, errorRef: Pointer | null): string {
  if (!errorRef) return "unknown error";
  const descriptionRef = n.cf.CFErrorCopyDescription(errorRef);
  n.cf.CFRelease(errorRef);
  if (!descriptionRef) return "unknown error";

  const description = `CFError ${descriptionRef}`;
  n.cf.CFRelease(descriptionRef);
  return description;
}

function makePrivateKeyQuery(n: Native, tag: Buffer): Pointer {
  const tagData = makeCFData(n, tag);
  const query = makeDict(n);
  n.cf.CFDictionarySetValue(query, n.kSecClass, n.kSecClassKey);
  n.cf.CFDictionarySetValue(query, n.kSecAttrKeyClass, n.kSecAttrKeyClassPrivate);
  n.cf.CFDictionarySetValue(query, n.kSecAttrApplicationTag, tagData);
  n.cf.CFDictionarySetValue(query, n.kSecReturnRef, n.kCFBooleanTrue);
  n.cf.CFDictionarySetValue(query, n.kSecUseDataProtectionKeychain, n.kCFBooleanTrue);
  n.cf.CFRelease(tagData);
  return query;
}

function findPrivateKey(n: Native, tag: Buffer): Pointer | null {
  const query = makePrivateKeyQuery(n, tag);
  const resultSlot = new BigUint64Array(1);
  const status = n.sec.SecItemCopyMatching(query, ptr(resultSlot));
  n.cf.CFRelease(query);

  if (status === errSecItemNotFound) return null;
  if (status !== errSecSuccess) throw new Error(`Key lookup failed (OSStatus ${status})`);
  return asPtr(Number(resultSlot[0]));
}

function createPrivateKey(n: Native, tag: Buffer): Pointer {
  const tagData = makeCFData(n, tag);
  const keySize = makeCFNumber(n, 2048);
  const privateAttrs = makeDict(n);
  const attrs = makeDict(n);
  const errorSlot = new BigUint64Array(1);

  n.cf.CFDictionarySetValue(privateAttrs, n.kSecAttrIsPermanent, n.kCFBooleanTrue);
  n.cf.CFDictionarySetValue(privateAttrs, n.kSecAttrApplicationTag, tagData);
  n.cf.CFDictionarySetValue(
    privateAttrs,
    n.kSecAttrAccessible,
    n.kSecAttrAccessibleAfterFirstUnlock,
  );
  n.cf.CFDictionarySetValue(privateAttrs, n.kSecUseDataProtectionKeychain, n.kCFBooleanTrue);

  n.cf.CFDictionarySetValue(attrs, n.kSecAttrKeyType, n.kSecAttrKeyTypeRSA);
  n.cf.CFDictionarySetValue(attrs, n.kSecAttrKeySizeInBits, keySize);
  n.cf.CFDictionarySetValue(attrs, n.kSecPrivateKeyAttrs, privateAttrs);
  n.cf.CFDictionarySetValue(attrs, n.kSecUseDataProtectionKeychain, n.kCFBooleanTrue);

  const key = n.sec.SecKeyCreateRandomKey(attrs, ptr(errorSlot));
  n.cf.CFRelease(attrs);
  n.cf.CFRelease(privateAttrs);
  n.cf.CFRelease(keySize);
  n.cf.CFRelease(tagData);

  if (!key) {
    throw new Error(`Key creation failed: ${errorDescription(n, asPtr(Number(errorSlot[0])))}`);
  }
  return key;
}

function getOrCreatePrivateKey(n: Native, tag: Buffer): Pointer {
  return findPrivateKey(n, tag) ?? createPrivateKey(n, tag);
}

function makeTag(name: string): Buffer {
  return Buffer.from(name, "utf8");
}

export function encryptWithKey(name: string, plaintext: Buffer): Buffer {
  const n = getNative();
  const privateKey = getOrCreatePrivateKey(n, makeTag(name));
  const publicKey = n.sec.SecKeyCopyPublicKey(privateKey);
  if (!publicKey) {
    n.cf.CFRelease(privateKey);
    throw new Error("SecKeyCopyPublicKey failed");
  }

  const data = makeCFData(n, plaintext);
  const errorSlot = new BigUint64Array(1);
  const encrypted = n.sec.SecKeyCreateEncryptedData(
    publicKey,
    n.kSecKeyAlgorithmRSAEncryptionOAEPSHA256,
    data,
    ptr(errorSlot),
  );
  n.cf.CFRelease(data);
  n.cf.CFRelease(publicKey);
  n.cf.CFRelease(privateKey);

  if (!encrypted) {
    throw new Error(`Key encryption failed: ${errorDescription(n, asPtr(Number(errorSlot[0])))}`);
  }
  const result = copyCFData(n, encrypted);
  n.cf.CFRelease(encrypted);
  return result;
}

export function decryptWithKey(name: string, ciphertext: Buffer): Buffer {
  const n = getNative();
  const privateKey = getOrCreatePrivateKey(n, makeTag(name));
  const data = makeCFData(n, ciphertext);
  const errorSlot = new BigUint64Array(1);
  const decrypted = n.sec.SecKeyCreateDecryptedData(
    privateKey,
    n.kSecKeyAlgorithmRSAEncryptionOAEPSHA256,
    data,
    ptr(errorSlot),
  );
  n.cf.CFRelease(data);
  n.cf.CFRelease(privateKey);

  if (!decrypted) {
    throw new Error(`Key decryption failed: ${errorDescription(n, asPtr(Number(errorSlot[0])))}`);
  }
  const result = copyCFData(n, decrypted);
  n.cf.CFRelease(decrypted);
  return result;
}

export function deleteKey(name: string): boolean {
  const n = getNative();
  const query = makePrivateKeyQuery(n, makeTag(name));
  const status = n.sec.SecItemDelete(query);
  n.cf.CFRelease(query);

  if (status === errSecItemNotFound) return false;
  if (status !== errSecSuccess) throw new Error(`Key delete failed (OSStatus ${status})`);
  return true;
}
