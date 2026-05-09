# @bizimind/whisper-cpp

Node addon wrapping [whisper.cpp](https://github.com/ggml-org/whisper.cpp) for speech-to-text transcription. Provides a TypeScript API for local, offline transcription.

## Features

- Native C++ bindings via node-addon-api
- GPU acceleration on macOS (Metal)
- Token-level alternatives for advanced use cases
- Automatic model download on install

## Installation

```bash
bun add @bizimind/whisper-cpp
```

The postinstall script automatically downloads whisper.cpp source code for building the native addon.

### Model Files

Download Whisper model files from [Hugging Face](https://huggingface.co/ggerganov/whisper.cpp/tree/main):

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
const ctx = WhisperContext.create("/path/to/ggml-large-v3-turbo.bin", {
  useGpu: true,
  noPrints: true,
});

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
    console.log(token.text, token.alternatives);
  }
}
```

## API

### `WhisperContext.create(modelPath, options?)`

| Option     | Type      | Default | Description                   |
| ---------- | --------- | ------- | ----------------------------- |
| `useGpu`   | `boolean` | `true`  | Enable Metal GPU acceleration |
| `noPrints` | `boolean` | `false` | Suppress whisper.cpp logging  |

### `ctx.transcribe(audio, options?)`

| Option      | Type      | Default | Description                          |
| ----------- | --------- | ------- | ------------------------------------ |
| `language`  | `string`  | `"en"`  | ISO 639-1 language code              |
| `prompt`    | `string`  | -       | Context prompt for domain vocabulary |
| `translate` | `boolean` | `false` | Translate to English                 |

Returns:

```typescript
{
  text: string;
  segments: Array<{ text: string; startTime: number; endTime: number }>;
}
```

### `ctx.free()`

Release resources. Must be called when done.

## Building

```bash
# Build native addon
bun run build

# Debug build
bun run build:debug

# Clean and rebuild
bun run rebuild
```

Requires CMake and a C++ compiler.

## License

MIT
