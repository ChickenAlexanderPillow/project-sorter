/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FRAMEIO_CLIENT_ID?: string;
  readonly VITE_FRAMEIO_SCOPES?: string;
  readonly VITE_FRAMEIO_ACCOUNT_ID?: string;
  readonly VITE_FRAMEIO_PROJECT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
