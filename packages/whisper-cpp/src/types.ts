export interface TokenData {
  id: number;
  text: string;
  probability: number;
  startTime: number;
  endTime: number;
}

export interface TokenAlternative {
  id: number;
  text: string;
  probability: number;
}

export interface TokenWithAlternatives extends TokenData {
  alternatives: TokenAlternative[];
}

export interface Segment {
  text: string;
  startTime: number;
  endTime: number;
  tokens: TokenData[];
}

export interface SegmentWithAlternatives {
  text: string;
  startTime: number;
  endTime: number;
  tokens: TokenWithAlternatives[];
}

export interface TranscriptionResult {
  text: string;
  segments: Segment[];
}

export interface DetailedTranscriptionResult {
  text: string;
  segments: SegmentWithAlternatives[];
  tokensWithAlternatives: TokenWithAlternatives[];
}

export interface TranscribeOptions {
  language?: string;
  prompt?: string;
  /** Number of threads to use for transcription. Defaults to min(4, hardware_concurrency). */
  threads?: number;
  /** Suppress blank tokens at the beginning. Defaults to true. Set to false to capture short phrases like "Cool", "Awesome". */
  suppressBlank?: boolean;
  /** Threshold for no-speech detection (0-1). Defaults to 0.6. Lower values are more sensitive. */
  noSpeechThreshold?: number;
}

export interface TranscribeWithAlternativesOptions extends TranscribeOptions {
  topK?: number;
}

export interface ContextOptions {
  useGpu?: boolean;
  noPrints?: boolean;
}

export interface WhisperContextNative {
  transcribe(audio: Float32Array, options?: TranscribeOptions): TranscriptionResult;
  transcribeWithAlternatives(
    audio: Float32Array,
    options?: TranscribeWithAlternativesOptions,
  ): DetailedTranscriptionResult;
  free(): void;
}
