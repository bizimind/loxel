#include <napi.h>
#include "whisper.h"

#include <string>
#include <vector>
#include <algorithm>
#include <cmath>
#include <thread>

// Disable logging
static void log_disable(enum ggml_log_level, const char*, void*) {}

// Structure to hold top-k alternatives for a single token position
struct TokenAlternatives {
    std::vector<std::pair<int, float>> alternatives; // (token_id, probability)
};

// User data passed to the logits filter callback
struct LogitsCallbackData {
    whisper_context* ctx;
    int top_k;
    std::vector<TokenAlternatives> all_alternatives;
    std::vector<float> probs_buffer; // Reusable buffer for softmax
    std::vector<int> indices_buffer; // Reusable buffer for top-k sorting
};

// Softmax helper - writes to pre-allocated buffer
static void softmax_inplace(const float* logits, float* probs, int n) {
    if (n <= 0) return;

    float max_val = logits[0];
    for (int i = 1; i < n; i++) {
        if (logits[i] > max_val) max_val = logits[i];
    }

    float sum = 0.0f;
    for (int i = 0; i < n; i++) {
        probs[i] = std::exp(logits[i] - max_val);
        sum += probs[i];
    }

    // Prevent divide-by-zero if all logits were -inf
    if (sum <= 0.0f) sum = 1.0f;

    for (int i = 0; i < n; i++) {
        probs[i] /= sum;
    }
}

// Get top-k indices from probabilities using partial_sort
// Uses pre-allocated indices buffer to avoid repeated allocations
static std::vector<std::pair<int, float>> get_top_k(const float* probs, int n, int k, std::vector<int>& indices) {
    // Resize buffer if needed (only happens on first call or if vocab size changes)
    if (indices.size() != static_cast<size_t>(n)) {
        indices.resize(n);
    }

    // Reset index array
    for (int i = 0; i < n; i++) {
        indices[i] = i;
    }

    // Partial sort to get top-k
    k = std::min(k, n);
    std::partial_sort(indices.begin(), indices.begin() + k, indices.end(),
        [probs](int a, int b) { return probs[a] > probs[b]; });

    // Extract top-k
    std::vector<std::pair<int, float>> result;
    result.reserve(k);
    for (int i = 0; i < k; i++) {
        result.push_back({indices[i], probs[indices[i]]});
    }
    return result;
}

// Logits filter callback - called before each token is sampled
static void logits_filter_callback(
    struct whisper_context* ctx,
    struct whisper_state* /*state*/,
    const whisper_token_data* /*tokens*/,
    int /*n_tokens*/,
    float* logits,
    void* user_data)
{
    LogitsCallbackData* data = static_cast<LogitsCallbackData*>(user_data);

    const int n_vocab = whisper_n_vocab(ctx);

    // Ensure buffer is sized correctly
    if (data->probs_buffer.size() != static_cast<size_t>(n_vocab)) {
        data->probs_buffer.resize(n_vocab);
    }

    // Apply softmax to get probabilities
    softmax_inplace(logits, data->probs_buffer.data(), n_vocab);

    // Get top-k alternatives (reuses indices_buffer to avoid allocation)
    TokenAlternatives alts;
    alts.alternatives = get_top_k(data->probs_buffer.data(), n_vocab, data->top_k, data->indices_buffer);

    // Store for later
    data->all_alternatives.push_back(std::move(alts));
}

// Wrapper class for whisper context
class WhisperContext : public Napi::ObjectWrap<WhisperContext> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    WhisperContext(const Napi::CallbackInfo& info);
    ~WhisperContext();

private:
    static Napi::FunctionReference constructor;
    whisper_context* ctx_;

    Napi::Value Transcribe(const Napi::CallbackInfo& info);
    Napi::Value TranscribeWithAlternatives(const Napi::CallbackInfo& info);
    Napi::Value Free(const Napi::CallbackInfo& info);

    // Internal transcription that returns token data
    struct TokenInfo {
        int id;
        std::string text;
        float probability;
        float log_probability;
        int64_t t0;
        int64_t t1;
        std::vector<std::pair<int, float>> alternatives; // id, prob pairs
    };

    struct SegmentInfo {
        std::string text;
        int64_t t0;
        int64_t t1;
        std::vector<TokenInfo> tokens;
    };

    struct TranscriptionResult {
        std::string full_text;
        std::vector<SegmentInfo> segments;
        int whisper_return_code = 0;
        int n_samples = 0;
    };

    TranscriptionResult RunTranscription(const float* samples, int n_samples,
                                         const std::string& language,
                                         const std::string& prompt,
                                         int top_k,
                                         int threads,
                                         bool suppress_blank,
                                         float no_speech_thold);
};

Napi::FunctionReference WhisperContext::constructor;

Napi::Object WhisperContext::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "WhisperContext", {
        InstanceMethod("transcribe", &WhisperContext::Transcribe),
        InstanceMethod("transcribeWithAlternatives", &WhisperContext::TranscribeWithAlternatives),
        InstanceMethod("free", &WhisperContext::Free),
    });

    constructor = Napi::Persistent(func);
    constructor.SuppressDestruct();

    exports.Set("WhisperContext", func);
    return exports;
}

WhisperContext::WhisperContext(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<WhisperContext>(info), ctx_(nullptr) {

    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Model path string expected").ThrowAsJavaScriptException();
        return;
    }

    std::string model_path = info[0].As<Napi::String>().Utf8Value();
    if (model_path.length() > 4096) {
        Napi::Error::New(env, "Model path too long (max 4096 chars)").ThrowAsJavaScriptException();
        return;
    }

    // Parse options
    bool use_gpu = true;
    bool no_prints = true;

    if (info.Length() > 1 && info[1].IsObject()) {
        Napi::Object opts = info[1].As<Napi::Object>();
        if (opts.Has("useGpu") && opts.Get("useGpu").IsBoolean()) {
            use_gpu = opts.Get("useGpu").As<Napi::Boolean>().Value();
        }
        if (opts.Has("noPrints") && opts.Get("noPrints").IsBoolean()) {
            no_prints = opts.Get("noPrints").As<Napi::Boolean>().Value();
        }
    }

    if (no_prints) {
        whisper_log_set(log_disable, nullptr);
    }

    whisper_context_params cparams = whisper_context_default_params();
    cparams.use_gpu = use_gpu;

    ctx_ = whisper_init_from_file_with_params(model_path.c_str(), cparams);

    if (ctx_ == nullptr) {
        Napi::Error::New(env, "Failed to load whisper model").ThrowAsJavaScriptException();
        return;
    }
}

WhisperContext::~WhisperContext() {
    if (ctx_ != nullptr) {
        whisper_free(ctx_);
        ctx_ = nullptr;
    }
}

WhisperContext::TranscriptionResult WhisperContext::RunTranscription(
    const float* samples, int n_samples,
    const std::string& language,
    const std::string& prompt,
    int top_k,
    int threads,
    bool suppress_blank,
    float no_speech_thold) {

    TranscriptionResult result;

    if (ctx_ == nullptr) {
        return result;
    }

    whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

    wparams.print_realtime = false;
    wparams.print_progress = false;
    wparams.print_timestamps = false;
    wparams.print_special = false;
    // Use provided threads or default to min(4, hardware_concurrency)
    const int default_threads = std::min(4, (int)std::thread::hardware_concurrency());
    wparams.n_threads = threads > 0 ? threads : default_threads;
    wparams.language = language.c_str();
    wparams.initial_prompt = prompt.empty() ? nullptr : prompt.c_str();
    wparams.token_timestamps = true; // We need token timestamps
    wparams.suppress_blank = suppress_blank;
    wparams.no_speech_thold = no_speech_thold;

    // Set up logits filter callback for top-k alternatives
    LogitsCallbackData callback_data;
    callback_data.ctx = ctx_;
    // topK is validated at JS boundary to be in [1, 100]; 0 means no alternatives
    callback_data.top_k = top_k > 0 ? top_k : 5;

    if (top_k > 0) {
        wparams.logits_filter_callback = logits_filter_callback;
        wparams.logits_filter_callback_user_data = &callback_data;
    }

    // Run transcription
    int ret = whisper_full(ctx_, wparams, samples, n_samples);
    result.whisper_return_code = ret;
    result.n_samples = n_samples;

    if (ret != 0) {
        return result;
    }

    // Collect results
    const int n_segments = whisper_full_n_segments(ctx_);

    // Index to track which alternatives we've used
    size_t alt_idx = 0;

    for (int i = 0; i < n_segments; i++) {
        SegmentInfo seg;
        seg.text = whisper_full_get_segment_text(ctx_, i);
        seg.t0 = whisper_full_get_segment_t0(ctx_, i);
        seg.t1 = whisper_full_get_segment_t1(ctx_, i);

        result.full_text += seg.text;

        const int n_tokens = whisper_full_n_tokens(ctx_, i);

        for (int j = 0; j < n_tokens; j++) {
            whisper_token_data tdata = whisper_full_get_token_data(ctx_, i, j);

            TokenInfo tok;
            tok.id = tdata.id;
            const char* tok_str = whisper_token_to_str(ctx_, tdata.id);
            tok.text = tok_str ? tok_str : "";
            tok.probability = tdata.p;
            tok.log_probability = tdata.plog;
            tok.t0 = tdata.t0;
            tok.t1 = tdata.t1;

            // Get alternatives from callback data
            // Only use alternatives if the top alternative matches the selected token
            if (top_k > 0 && alt_idx < callback_data.all_alternatives.size()) {
                const auto& alts = callback_data.all_alternatives[alt_idx].alternatives;
                if (!alts.empty() && alts[0].first == tok.id) {
                    tok.alternatives = alts;
                }
                alt_idx++;
            }

            seg.tokens.push_back(tok);
        }

        result.segments.push_back(seg);
    }

    return result;
}

Napi::Value WhisperContext::Transcribe(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (ctx_ == nullptr) {
        Napi::Error::New(env, "Context has been freed").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    if (info.Length() < 1 || !info[0].IsTypedArray()) {
        Napi::TypeError::New(env, "Float32Array expected").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::TypedArray arr = info[0].As<Napi::TypedArray>();
    if (arr.TypedArrayType() != napi_float32_array) {
        Napi::TypeError::New(env, "Float32Array expected, got different TypedArray").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Float32Array audio = info[0].As<Napi::Float32Array>();
    const float* samples = audio.Data();
    const int n_samples = audio.ElementLength();

    std::string language = "en";
    std::string prompt = "";
    int threads = 0; // 0 means use default
    bool suppress_blank = true; // Default: suppress blank tokens at start
    float no_speech_thold = 0.6f; // Default: 60% threshold

    if (info.Length() > 1 && info[1].IsObject()) {
        Napi::Object opts = info[1].As<Napi::Object>();
        if (opts.Has("language") && opts.Get("language").IsString()) {
            language = opts.Get("language").As<Napi::String>().Utf8Value();
            if (language.length() > 16) {
                Napi::Error::New(env, "Language code too long").ThrowAsJavaScriptException();
                return env.Undefined();
            }
        }
        if (opts.Has("prompt") && opts.Get("prompt").IsString()) {
            prompt = opts.Get("prompt").As<Napi::String>().Utf8Value();
            if (prompt.length() > 16384) {
                Napi::Error::New(env, "Prompt too long (max 16KB)").ThrowAsJavaScriptException();
                return env.Undefined();
            }
        }
        if (opts.Has("threads") && opts.Get("threads").IsNumber()) {
            threads = opts.Get("threads").As<Napi::Number>().Int32Value();
            if (threads < 1 || threads > 128) {
                Napi::RangeError::New(env, "threads must be between 1 and 128").ThrowAsJavaScriptException();
                return env.Undefined();
            }
        }
        if (opts.Has("suppressBlank") && opts.Get("suppressBlank").IsBoolean()) {
            suppress_blank = opts.Get("suppressBlank").As<Napi::Boolean>().Value();
        }
        if (opts.Has("noSpeechThreshold") && opts.Get("noSpeechThreshold").IsNumber()) {
            no_speech_thold = opts.Get("noSpeechThreshold").As<Napi::Number>().FloatValue();
            if (no_speech_thold < 0.0f || no_speech_thold > 1.0f) {
                Napi::RangeError::New(env, "noSpeechThreshold must be between 0 and 1").ThrowAsJavaScriptException();
                return env.Undefined();
            }
        }
    }

    TranscriptionResult result = RunTranscription(samples, n_samples, language, prompt, 0, threads, suppress_blank, no_speech_thold);

    // Build result object
    Napi::Object obj = Napi::Object::New(env);
    obj.Set("text", Napi::String::New(env, result.full_text));

    Napi::Array segments = Napi::Array::New(env, result.segments.size());
    for (size_t i = 0; i < result.segments.size(); i++) {
        const auto& seg = result.segments[i];
        Napi::Object segObj = Napi::Object::New(env);
        segObj.Set("text", Napi::String::New(env, seg.text));
        segObj.Set("startTime", Napi::Number::New(env, seg.t0 * 10)); // Convert to ms
        segObj.Set("endTime", Napi::Number::New(env, seg.t1 * 10));

        Napi::Array tokens = Napi::Array::New(env, seg.tokens.size());
        for (size_t j = 0; j < seg.tokens.size(); j++) {
            const auto& tok = seg.tokens[j];
            Napi::Object tokObj = Napi::Object::New(env);
            tokObj.Set("id", Napi::Number::New(env, tok.id));
            tokObj.Set("text", Napi::String::New(env, tok.text));
            tokObj.Set("probability", Napi::Number::New(env, tok.probability));
            tokObj.Set("startTime", Napi::Number::New(env, tok.t0 * 10));
            tokObj.Set("endTime", Napi::Number::New(env, tok.t1 * 10));
            tokens[j] = tokObj;
        }
        segObj.Set("tokens", tokens);

        segments[i] = segObj;
    }
    obj.Set("segments", segments);

    return obj;
}

Napi::Value WhisperContext::TranscribeWithAlternatives(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (ctx_ == nullptr) {
        Napi::Error::New(env, "Context has been freed").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    if (info.Length() < 1 || !info[0].IsTypedArray()) {
        Napi::TypeError::New(env, "Float32Array expected").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::TypedArray arr = info[0].As<Napi::TypedArray>();
    if (arr.TypedArrayType() != napi_float32_array) {
        Napi::TypeError::New(env, "Float32Array expected, got different TypedArray").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Float32Array audio = info[0].As<Napi::Float32Array>();
    const float* samples = audio.Data();
    const int n_samples = audio.ElementLength();

    int top_k = 5;
    std::string language = "en";
    std::string prompt = "";
    int threads = 0; // 0 means use default
    bool suppress_blank = true; // Default: suppress blank tokens at start
    float no_speech_thold = 0.6f; // Default: 60% threshold

    if (info.Length() > 1 && info[1].IsObject()) {
        Napi::Object opts = info[1].As<Napi::Object>();
        if (opts.Has("topK") && opts.Get("topK").IsNumber()) {
            top_k = opts.Get("topK").As<Napi::Number>().Int32Value();
            if (top_k < 1 || top_k > 100) {
                Napi::RangeError::New(env, "topK must be between 1 and 100").ThrowAsJavaScriptException();
                return env.Undefined();
            }
        }
        if (opts.Has("language") && opts.Get("language").IsString()) {
            language = opts.Get("language").As<Napi::String>().Utf8Value();
            if (language.length() > 16) {
                Napi::Error::New(env, "Language code too long").ThrowAsJavaScriptException();
                return env.Undefined();
            }
        }
        if (opts.Has("prompt") && opts.Get("prompt").IsString()) {
            prompt = opts.Get("prompt").As<Napi::String>().Utf8Value();
            if (prompt.length() > 16384) {
                Napi::Error::New(env, "Prompt too long (max 16KB)").ThrowAsJavaScriptException();
                return env.Undefined();
            }
        }
        if (opts.Has("threads") && opts.Get("threads").IsNumber()) {
            threads = opts.Get("threads").As<Napi::Number>().Int32Value();
            if (threads < 1 || threads > 128) {
                Napi::RangeError::New(env, "threads must be between 1 and 128").ThrowAsJavaScriptException();
                return env.Undefined();
            }
        }
        if (opts.Has("suppressBlank") && opts.Get("suppressBlank").IsBoolean()) {
            suppress_blank = opts.Get("suppressBlank").As<Napi::Boolean>().Value();
        }
        if (opts.Has("noSpeechThreshold") && opts.Get("noSpeechThreshold").IsNumber()) {
            no_speech_thold = opts.Get("noSpeechThreshold").As<Napi::Number>().FloatValue();
            if (no_speech_thold < 0.0f || no_speech_thold > 1.0f) {
                Napi::RangeError::New(env, "noSpeechThreshold must be between 0 and 1").ThrowAsJavaScriptException();
                return env.Undefined();
            }
        }
    }

    TranscriptionResult result = RunTranscription(samples, n_samples, language, prompt, top_k, threads, suppress_blank, no_speech_thold);

    // Build result object (same as Transcribe but with alternatives)
    Napi::Object obj = Napi::Object::New(env);
    obj.Set("text", Napi::String::New(env, result.full_text));
    obj.Set("_debug_whisper_return_code", Napi::Number::New(env, result.whisper_return_code));
    obj.Set("_debug_n_samples", Napi::Number::New(env, result.n_samples));

    Napi::Array segments = Napi::Array::New(env, result.segments.size());
    for (size_t i = 0; i < result.segments.size(); i++) {
        const auto& seg = result.segments[i];
        Napi::Object segObj = Napi::Object::New(env);
        segObj.Set("text", Napi::String::New(env, seg.text));
        segObj.Set("startTime", Napi::Number::New(env, seg.t0 * 10));
        segObj.Set("endTime", Napi::Number::New(env, seg.t1 * 10));

        Napi::Array tokens = Napi::Array::New(env, seg.tokens.size());
        for (size_t j = 0; j < seg.tokens.size(); j++) {
            const auto& tok = seg.tokens[j];
            Napi::Object tokObj = Napi::Object::New(env);
            tokObj.Set("id", Napi::Number::New(env, tok.id));
            tokObj.Set("text", Napi::String::New(env, tok.text));
            tokObj.Set("probability", Napi::Number::New(env, tok.probability));
            tokObj.Set("startTime", Napi::Number::New(env, tok.t0 * 10));
            tokObj.Set("endTime", Napi::Number::New(env, tok.t1 * 10));

            // Add alternatives
            Napi::Array alts = Napi::Array::New(env, tok.alternatives.size());
            for (size_t k = 0; k < tok.alternatives.size(); k++) {
                Napi::Object altObj = Napi::Object::New(env);
                altObj.Set("id", Napi::Number::New(env, tok.alternatives[k].first));
                const char* alt_text = whisper_token_to_str(ctx_, tok.alternatives[k].first);
                altObj.Set("text", Napi::String::New(env, alt_text ? alt_text : ""));
                altObj.Set("probability", Napi::Number::New(env, tok.alternatives[k].second));
                alts[k] = altObj;
            }
            tokObj.Set("alternatives", alts);

            tokens[j] = tokObj;
        }
        segObj.Set("tokens", tokens);

        segments[i] = segObj;
    }
    obj.Set("segments", segments);

    // Also add a flat list of all tokens with alternatives
    std::vector<TokenInfo> all_tokens;
    for (const auto& seg : result.segments) {
        for (const auto& tok : seg.tokens) {
            all_tokens.push_back(tok);
        }
    }

    Napi::Array tokensWithAlts = Napi::Array::New(env, all_tokens.size());
    for (size_t i = 0; i < all_tokens.size(); i++) {
        const auto& tok = all_tokens[i];
        Napi::Object tokObj = Napi::Object::New(env);
        tokObj.Set("id", Napi::Number::New(env, tok.id));
        tokObj.Set("text", Napi::String::New(env, tok.text));
        tokObj.Set("probability", Napi::Number::New(env, tok.probability));
        tokObj.Set("startTime", Napi::Number::New(env, tok.t0 * 10));
        tokObj.Set("endTime", Napi::Number::New(env, tok.t1 * 10));

        Napi::Array alts = Napi::Array::New(env, tok.alternatives.size());
        for (size_t k = 0; k < tok.alternatives.size(); k++) {
            Napi::Object altObj = Napi::Object::New(env);
            altObj.Set("id", Napi::Number::New(env, tok.alternatives[k].first));
            const char* alt_text = whisper_token_to_str(ctx_, tok.alternatives[k].first);
            altObj.Set("text", Napi::String::New(env, alt_text ? alt_text : ""));
            altObj.Set("probability", Napi::Number::New(env, tok.alternatives[k].second));
            alts[k] = altObj;
        }
        tokObj.Set("alternatives", alts);

        tokensWithAlts[i] = tokObj;
    }
    obj.Set("tokensWithAlternatives", tokensWithAlts);

    return obj;
}

Napi::Value WhisperContext::Free(const Napi::CallbackInfo& info) {
    if (ctx_ != nullptr) {
        whisper_free(ctx_);
        ctx_ = nullptr;
    }
    return info.Env().Undefined();
}

// Module initialization
Napi::Object Init(Napi::Env env, Napi::Object exports) {
    WhisperContext::Init(env, exports);
    return exports;
}

NODE_API_MODULE(whisper_cpp_addon, Init)
