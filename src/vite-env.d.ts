/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute API origin for packaged app builds, e.g. https://voice-memo.example.workers.dev */
  readonly VITE_API_BASE?: string;
}
