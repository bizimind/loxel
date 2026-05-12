import type { Pointer } from "bun:ffi";

import { FFIType, dlopen, ptr, read, toArrayBuffer } from "bun:ffi";

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

const RTLD_NOLOAD = 0x10;
const kCFNumberSInt32Type = 3;

const asPtr = (n: number): Pointer => n as unknown as Pointer;

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

const kCFAllocatorDefault = null;
const kCFTypeDictionaryKeyCallBacks = cfStructAddr(cfHandle, "kCFTypeDictionaryKeyCallBacks");
const kCFTypeDictionaryValueCallBacks = cfStructAddr(cfHandle, "kCFTypeDictionaryValueCallBacks");
const kCFBooleanTrue = cfConst(cfHandle, "kCFBooleanTrue");

const kSecClass = cfConst(secHandle, "kSecClass");
const kSecClassKey = cfConst(secHandle, "kSecClassKey");
const kSecAttrApplicationTag = cfConst(secHandle, "kSecAttrApplicationTag");
const kSecAttrAccessible = cfConst(secHandle, "kSecAttrAccessible");
const kSecAttrAccessibleAfterFirstUnlock = cfConst(secHandle, "kSecAttrAccessibleAfterFirstUnlock");
const kSecAttrIsPermanent = cfConst(secHandle, "kSecAttrIsPermanent");
const kSecAttrKeyClass = cfConst(secHandle, "kSecAttrKeyClass");
const kSecAttrKeyClassPrivate = cfConst(secHandle, "kSecAttrKeyClassPrivate");
const kSecAttrKeySizeInBits = cfConst(secHandle, "kSecAttrKeySizeInBits");
const kSecAttrKeyType = cfConst(secHandle, "kSecAttrKeyType");
const kSecAttrKeyTypeRSA = cfConst(secHandle, "kSecAttrKeyTypeRSA");
const kSecPrivateKeyAttrs = cfConst(secHandle, "kSecPrivateKeyAttrs");
const kSecReturnRef = cfConst(secHandle, "kSecReturnRef");
const kSecUseDataProtectionKeychain = cfConst(secHandle, "kSecUseDataProtectionKeychain");
const kSecKeyAlgorithmRSAEncryptionOAEPSHA256 = cfConst(
  secHandle,
  "kSecKeyAlgorithmRSAEncryptionOAEPSHA256",
);

const errSecSuccess = 0;
const errSecItemNotFound = -25300;

function makeCFData(value: Buffer): Pointer {
  const ref = cf.CFDataCreate(kCFAllocatorDefault, ptr(value), value.byteLength);
  if (!ref) throw new Error("CFDataCreate failed");
  return ref;
}

function makeCFNumber(value: number): Pointer {
  const slot = new Int32Array([value]);
  const ref = cf.CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, ptr(slot));
  if (!ref) throw new Error(`CFNumberCreate failed for ${value}`);
  return ref;
}

function makeDict(): Pointer {
  const dict = cf.CFDictionaryCreateMutable(
    kCFAllocatorDefault,
    0,
    kCFTypeDictionaryKeyCallBacks,
    kCFTypeDictionaryValueCallBacks,
  );
  if (!dict) throw new Error("CFDictionaryCreateMutable failed");
  return dict;
}

function copyCFData(dataRef: Pointer): Buffer {
  const len = Number(cf.CFDataGetLength(dataRef));
  const bytesPtr = cf.CFDataGetBytePtr(dataRef);
  if (!bytesPtr) throw new Error("CFDataGetBytePtr failed");
  return Buffer.from(new Uint8Array(toArrayBuffer(bytesPtr, 0, len)));
}

function errorDescription(errorRef: Pointer | null): string {
  if (!errorRef) return "unknown error";
  const descriptionRef = cf.CFErrorCopyDescription(errorRef);
  cf.CFRelease(errorRef);
  if (!descriptionRef) return "unknown error";

  // CFString's textual representation is not directly exposed here; the pointer
  // value still gives enough context to correlate native failures while avoiding
  // another fragile FFI conversion surface.
  const description = `CFError ${descriptionRef}`;
  cf.CFRelease(descriptionRef);
  return description;
}

function makePrivateKeyQuery(tag: Buffer): Pointer {
  const tagData = makeCFData(tag);
  const query = makeDict();
  cf.CFDictionarySetValue(query, kSecClass, kSecClassKey);
  cf.CFDictionarySetValue(query, kSecAttrKeyClass, kSecAttrKeyClassPrivate);
  cf.CFDictionarySetValue(query, kSecAttrApplicationTag, tagData);
  cf.CFDictionarySetValue(query, kSecReturnRef, kCFBooleanTrue);
  cf.CFDictionarySetValue(query, kSecUseDataProtectionKeychain, kCFBooleanTrue);
  cf.CFRelease(tagData);
  return query;
}

function findPrivateKey(tag: Buffer): Pointer | null {
  const query = makePrivateKeyQuery(tag);
  const resultSlot = new BigUint64Array(1);
  const status = sec.SecItemCopyMatching(query, ptr(resultSlot));
  cf.CFRelease(query);

  if (status === errSecItemNotFound) return null;
  if (status !== errSecSuccess) throw new Error(`Key lookup failed (OSStatus ${status})`);
  return asPtr(Number(resultSlot[0]));
}

function createPrivateKey(tag: Buffer): Pointer {
  const tagData = makeCFData(tag);
  const keySize = makeCFNumber(2048);
  const privateAttrs = makeDict();
  const attrs = makeDict();
  const errorSlot = new BigUint64Array(1);

  cf.CFDictionarySetValue(privateAttrs, kSecAttrIsPermanent, kCFBooleanTrue);
  cf.CFDictionarySetValue(privateAttrs, kSecAttrApplicationTag, tagData);
  cf.CFDictionarySetValue(privateAttrs, kSecAttrAccessible, kSecAttrAccessibleAfterFirstUnlock);
  cf.CFDictionarySetValue(privateAttrs, kSecUseDataProtectionKeychain, kCFBooleanTrue);

  cf.CFDictionarySetValue(attrs, kSecAttrKeyType, kSecAttrKeyTypeRSA);
  cf.CFDictionarySetValue(attrs, kSecAttrKeySizeInBits, keySize);
  cf.CFDictionarySetValue(attrs, kSecPrivateKeyAttrs, privateAttrs);
  cf.CFDictionarySetValue(attrs, kSecUseDataProtectionKeychain, kCFBooleanTrue);

  const key = sec.SecKeyCreateRandomKey(attrs, ptr(errorSlot));
  cf.CFRelease(attrs);
  cf.CFRelease(privateAttrs);
  cf.CFRelease(keySize);
  cf.CFRelease(tagData);

  if (!key) {
    throw new Error(`Key creation failed: ${errorDescription(asPtr(Number(errorSlot[0])))}`);
  }
  return key;
}

function getOrCreatePrivateKey(tag: Buffer): Pointer {
  return findPrivateKey(tag) ?? createPrivateKey(tag);
}

function makeTag(name: string): Buffer {
  return Buffer.from(name, "utf8");
}

export function encryptWithKey(name: string, plaintext: Buffer): Buffer {
  const privateKey = getOrCreatePrivateKey(makeTag(name));
  const publicKey = sec.SecKeyCopyPublicKey(privateKey);
  if (!publicKey) {
    cf.CFRelease(privateKey);
    throw new Error("SecKeyCopyPublicKey failed");
  }

  const data = makeCFData(plaintext);
  const errorSlot = new BigUint64Array(1);
  const encrypted = sec.SecKeyCreateEncryptedData(
    publicKey,
    kSecKeyAlgorithmRSAEncryptionOAEPSHA256,
    data,
    ptr(errorSlot),
  );
  cf.CFRelease(data);
  cf.CFRelease(publicKey);
  cf.CFRelease(privateKey);

  if (!encrypted) {
    throw new Error(`Key encryption failed: ${errorDescription(asPtr(Number(errorSlot[0])))}`);
  }
  const result = copyCFData(encrypted);
  cf.CFRelease(encrypted);
  return result;
}

export function decryptWithKey(name: string, ciphertext: Buffer): Buffer {
  const privateKey = getOrCreatePrivateKey(makeTag(name));
  const data = makeCFData(ciphertext);
  const errorSlot = new BigUint64Array(1);
  const decrypted = sec.SecKeyCreateDecryptedData(
    privateKey,
    kSecKeyAlgorithmRSAEncryptionOAEPSHA256,
    data,
    ptr(errorSlot),
  );
  cf.CFRelease(data);
  cf.CFRelease(privateKey);

  if (!decrypted) {
    throw new Error(`Key decryption failed: ${errorDescription(asPtr(Number(errorSlot[0])))}`);
  }
  const result = copyCFData(decrypted);
  cf.CFRelease(decrypted);
  return result;
}

export function deleteKey(name: string): boolean {
  const query = makePrivateKeyQuery(makeTag(name));
  const status = sec.SecItemDelete(query);
  cf.CFRelease(query);

  if (status === errSecItemNotFound) return false;
  if (status !== errSecSuccess) throw new Error(`Key delete failed (OSStatus ${status})`);
  return true;
}
