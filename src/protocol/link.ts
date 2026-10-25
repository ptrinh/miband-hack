import type { AuthSession } from '../core/auth';

/** Framing layer between the device logic and a transport. */
export interface Link {
  readonly name: string;
  auth: AuthSession | null;
  /** The band is ready for the auth handshake (session established). */
  onReadyForAuth: () => void;
  /** Decrypted protobuf command bytes from the band. */
  onCommand: (bytes: Uint8Array) => void;
  onClose: () => void;
  log: (msg: string) => void;

  start(): Promise<void>;
  sendCommand(bytes: Uint8Array, isAuth: boolean): Promise<void>;
  /** Sends one data-upload part; resolves once the link can accept the next one. */
  sendData(chunk: Uint8Array): Promise<void>;
  onAuthSuccess(): void;
  close(): Promise<void>;
}

export const noop = (): void => {};

export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
