#include <napi.h>

#ifdef __APPLE__
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#endif

#include <string>
#include <cstring>

#ifdef __APPLE__

static CFStringRef toCFString(const std::string& s) {
    return CFStringCreateWithBytes(
        kCFAllocatorDefault,
        reinterpret_cast<const UInt8*>(s.data()),
        static_cast<CFIndex>(s.size()),
        kCFStringEncodingUTF8,
        false
    );
}

// Returns the raw data for a generic password item, or nullptr if not found.
// Caller must CFRelease the returned CFDataRef.
static CFDataRef findItem(const std::string& service, const std::string& account, OSStatus& outStatus) {
    CFStringRef svc = toCFString(service);
    CFStringRef acct = toCFString(account);

    CFMutableDictionaryRef query = CFDictionaryCreateMutable(
        kCFAllocatorDefault, 0,
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks
    );
    CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
    CFDictionarySetValue(query, kSecAttrService, svc);
    CFDictionarySetValue(query, kSecAttrAccount, acct);
    CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
    CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);

    CFTypeRef result = nullptr;
    outStatus = SecItemCopyMatching(query, &result);

    CFRelease(query);
    CFRelease(svc);
    CFRelease(acct);

    if (outStatus == errSecSuccess) {
        return reinterpret_cast<CFDataRef>(result);
    }
    if (result) CFRelease(result);
    return nullptr;
}

// getSecret(service, account) -> Buffer | null
Napi::Value GetSecret(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "getSecret(service: string, account: string)").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string service = info[0].As<Napi::String>().Utf8Value();
    std::string account = info[1].As<Napi::String>().Utf8Value();

    OSStatus status;
    CFDataRef data = findItem(service, account, status);

    if (status == errSecItemNotFound) {
        return env.Null();
    }
    if (status != errSecSuccess) {
        Napi::Error::New(env, "Keychain read failed (OSStatus " + std::to_string(status) + ")").ThrowAsJavaScriptException();
        return env.Null();
    }

    CFIndex len = CFDataGetLength(data);
    const UInt8* bytes = CFDataGetBytePtr(data);

    // Copy into a JS Buffer (CFDataRef is freed after copy)
    Napi::Buffer<uint8_t> buf = Napi::Buffer<uint8_t>::Copy(env, bytes, static_cast<size_t>(len));
    CFRelease(data);
    return buf;
}

// setSecret(service, account, secret: Buffer | Uint8Array) -> void
Napi::Value SetSecret(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 3 || !info[0].IsString() || !info[1].IsString() || !info[2].IsBuffer()) {
        Napi::TypeError::New(env, "setSecret(service: string, account: string, secret: Buffer)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string service = info[0].As<Napi::String>().Utf8Value();
    std::string account = info[1].As<Napi::String>().Utf8Value();
    Napi::Buffer<uint8_t> buf = info[2].As<Napi::Buffer<uint8_t>>();

    CFStringRef svc = toCFString(service);
    CFStringRef acct = toCFString(account);
    CFDataRef data = CFDataCreate(kCFAllocatorDefault, buf.Data(), static_cast<CFIndex>(buf.ByteLength()));

    // Try to update existing item first
    CFMutableDictionaryRef query = CFDictionaryCreateMutable(
        kCFAllocatorDefault, 0,
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks
    );
    CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
    CFDictionarySetValue(query, kSecAttrService, svc);
    CFDictionarySetValue(query, kSecAttrAccount, acct);

    CFMutableDictionaryRef attrs = CFDictionaryCreateMutable(
        kCFAllocatorDefault, 0,
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks
    );
    CFDictionarySetValue(attrs, kSecValueData, data);

    OSStatus status = SecItemUpdate(query, attrs);

    if (status == errSecItemNotFound) {
        // Item doesn't exist — add it
        CFDictionarySetValue(query, kSecValueData, data);
        status = SecItemAdd(query, nullptr);
    }

    CFRelease(query);
    CFRelease(attrs);
    CFRelease(data);
    CFRelease(svc);
    CFRelease(acct);

    if (status != errSecSuccess) {
        Napi::Error::New(env, "Keychain write failed (OSStatus " + std::to_string(status) + ")").ThrowAsJavaScriptException();
    }
    return env.Undefined();
}

// deleteSecret(service, account) -> boolean
Napi::Value DeleteSecret(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "deleteSecret(service: string, account: string)").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    std::string service = info[0].As<Napi::String>().Utf8Value();
    std::string account = info[1].As<Napi::String>().Utf8Value();

    CFStringRef svc = toCFString(service);
    CFStringRef acct = toCFString(account);

    CFMutableDictionaryRef query = CFDictionaryCreateMutable(
        kCFAllocatorDefault, 0,
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks
    );
    CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
    CFDictionarySetValue(query, kSecAttrService, svc);
    CFDictionarySetValue(query, kSecAttrAccount, acct);

    OSStatus status = SecItemDelete(query);

    CFRelease(query);
    CFRelease(svc);
    CFRelease(acct);

    if (status == errSecItemNotFound) {
        return Napi::Boolean::New(env, false);
    }
    if (status != errSecSuccess) {
        Napi::Error::New(env, "Keychain delete failed (OSStatus " + std::to_string(status) + ")").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }
    return Napi::Boolean::New(env, true);
}

#else

Napi::Value GetSecret(const Napi::CallbackInfo& info) {
    Napi::Error::New(info.Env(), "Keychain is only supported on macOS").ThrowAsJavaScriptException();
    return info.Env().Null();
}

Napi::Value SetSecret(const Napi::CallbackInfo& info) {
    Napi::Error::New(info.Env(), "Keychain is only supported on macOS").ThrowAsJavaScriptException();
    return info.Env().Undefined();
}

Napi::Value DeleteSecret(const Napi::CallbackInfo& info) {
    Napi::Error::New(info.Env(), "Keychain is only supported on macOS").ThrowAsJavaScriptException();
    return Napi::Boolean::New(info.Env(), false);
}

#endif

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("getSecret", Napi::Function::New(env, GetSecret));
    exports.Set("setSecret", Napi::Function::New(env, SetSecret));
    exports.Set("deleteSecret", Napi::Function::New(env, DeleteSecret));
    return exports;
}

NODE_API_MODULE(keychain_addon, Init)
