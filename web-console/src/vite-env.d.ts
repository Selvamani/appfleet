/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 'mock' (default): every API simulated by MSW. 'hybrid': built control-api endpoints go to a live control-api. */
  readonly VITE_API_MODE?: 'mock' | 'hybrid';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
