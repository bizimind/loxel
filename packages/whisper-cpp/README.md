# @bizimind/whisper-cpp

Node addon wrapping [whisper.cpp](https://github.com/ggml-org/whisper.cpp) for speech-to-text transcription. Provides a TypeScript API for local, offline transcription.

## Features

- Native C++ bindings via node-addon-api
- GPU acceleration on macOS (Metal)
- Token-level probabilities and top-K alternatives for advanced use cases
- whisper.cpp source (pinned version) downloaded automatically on install

## Installation

Workspace-only package; add `"@bizimind/whisper-cpp": "workspace:*"` to a package's dependencies. The `postinstall` script (`scripts/download-whisper.ts`) downloads the pinned whisper.cpp release into `deps/whisper.cpp`; then build the native addon (see [Building](#building)).

### Model Files

Models are not bundled. Download a Whisper model from [Hugging Face](https://huggingface.co/ggerganov/whisper.cpp/tree/main):

```bash
# Recommended: Large v3 Turbo (1.5GB, best quality/speed)
curl -L -o ggml-large-v3-turbo.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin

# Alternative: Base English (142MB, faster)
curl -L -o ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

## Usage

```typescript
import { WhisperContext } from "@bizimind/whisper-cpp";

// Create context from model file
const ctx = WhisperContext.create("/path/to/ggml-large-v3-turbo.bin", { useGpu: true });

// Transcribe audio (16kHz mono Float32Array)
const result = ctx.transcribe(audioSamples, {
  language: "en",
  prompt: "Technical terms: API, SDK, CLI",
});

console.log(result.text);
// "Let's create a new API endpoint"

// Free resources when done
ctx.free();
```

### Transcription with Alternatives

For applications that need token-level confidence or alternatives:

```typescript
const detailed = ctx.transcribeWithAlternatives(audioSamples, {
  language: "en",
  topK: 3, // Return top 3 alternatives per token
});

for (const segment of detailed.segments) {
  for (const token of segment.tokens) {
    console.log(token.text, token.probability, token.alternatives);
  }
}
```

## API

Exported from `src/index.ts`; result and option types are in `src/types.ts`.

### `WhisperContext.create(modelPath, options?)`

`createContext(modelPath, options?)` is an alias.

| Option     | Type      | Default | Description                   |
| ---------- | --------- | ------- | ----------------------------- |
| `useGpu`   | `boolean` | `true`  | Enable Metal GPU acceleration |
| `noPrints` | `boolean` | `true`  | Suppress whisper.cpp logging  |

### `ctx.transcribe(audio, options?)`

| Option              | Type      | Default                    | Description                                                      |
| ------------------- | --------- | -------------------------- | ---------------------------------------------------------------- |
| `language`          | `string`  | `"en"`                     | Language code                                                    |
| `prompt`            | `string`  | -                          | Context prompt for domain vocabulary                             |
| `threads`           | `number`  | `min(4, hardware threads)` | Threads used for transcription                                   |
| `suppressBlank`     | `boolean` | `true`                     | Suppress leading blank tokens; set `false` to keep short phrases |
| `noSpeechThreshold` | `number`  | `0.6`                      | No-speech detection threshold (0–1); lower is more sensitive     |

Returns `{ text, segments }`, where each segment has `text`, `startTime`, `endTime`, and `tokens` (each with `text`, `probability`, and timings).

### `ctx.transcribeWithAlternatives(audio, options?)`

Accepts the same options plus `topK` (1–100, default 5). Each token additionally carries `alternatives`, and the result includes a flat `tokensWithAlternatives` list.

### `ctx.free()`

Release resources. Must be called when done; the context throws if used afterwards.

## Building

```bash
pnpm -C packages/whisper-cpp run build         # Build native addon
pnpm -C packages/whisper-cpp run build:debug   # Debug build
pnpm -C packages/whisper-cpp run rebuild       # Clean and rebuild
```

Requires CMake and a C++ compiler.

## License

[FSL-1.1-ALv2](../../LICENSE) — source available for non-competing use; converts to Apache 2.0 after 2 years.
