import { createRequire } from "module";

import type {
  ContextOptions,
  TranscriptionResult,
  DetailedTranscriptionResult,
  TranscribeOptions,
  TranscribeWithAlternativesOptions,
  WhisperContextNative,
} from "./types.js";

export type {
  TokenData,
  TokenAlternative,
  TokenWithAlternatives,
  Segment,
  SegmentWithAlternatives,
  TranscriptionResult,
  DetailedTranscriptionResult,
  TranscribeOptions,
  TranscribeWithAlternativesOptions,
  ContextOptions,
} from "./types.js";

// Load native addon
const require = createRequire(import.meta.url);
const addon = require("../build/Release/whisper_cpp_addon.node");

/**
 * Whisper context for transcription
 */
export class WhisperContext {
  private native: WhisperContextNative;
  private freed = false;

  private constructor(native: WhisperContextNative) {
    this.native = native;
  }

  /**
   * Create a new WhisperContext from a model file
   */
  static create(modelPath: string, options?: ContextOptions): WhisperContext {
    const native = new addon.WhisperContext(modelPath, options);
    return new WhisperContext(native);
  }

  /**
   * Transcribe audio to text
   * @param audio - Float32Array of audio samples at 16kHz mono
   * @param options - Transcription options
   */
  transcribe(audio: Float32Array, options?: TranscribeOptions): TranscriptionResult {
    if (this.freed) {
      throw new Error("Context has been freed");
    }
    return this.native.transcribe(audio, options);
  }

  /**
   * Transcribe audio with token-level alternatives
   * @param audio - Float32Array of audio samples at 16kHz mono
   * @param options - Transcription options including topK
   */
  transcribeWithAlternatives(
    audio: Float32Array,
    options?: TranscribeWithAlternativesOptions,
  ): DetailedTranscriptionResult {
    if (this.freed) {
      throw new Error("Context has been freed");
    }
    return this.native.transcribeWithAlternatives(audio, options);
  }

  /**
   * Free the context and release resources
   */
  free(): void {
    if (!this.freed) {
      this.native.free();
      this.freed = true;
    }
  }
}

/**
 * Helper to create a context (alias for WhisperContext.create)
 */
export function createContext(modelPath: string, options?: ContextOptions): WhisperContext {
  return WhisperContext.create(modelPath, options);
}
