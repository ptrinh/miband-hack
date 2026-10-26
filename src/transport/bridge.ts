import { type ByteTransport } from './types';
import { t } from '../i18n';

export const BRIDGE_URL = 'ws://127.0.0.1:47851/band';

/**
 * SPP through the local helper (tools/bridge): a Mi Band 10 on macOS never answers Chrome's SDP query,
 * so Web Serial cannot open it. The helper opens RFCOMM channel 5 directly; binary WebSocket messages
 * are band bytes, text messages are the helper's status.
 */
export class BridgeTransport implements ByteTransport {
  readonly label = 'Mac helper (SPP)';
  onData: (data: Uint8Array) => void = () => {};
  onClose: () => void = () => {};
  private closed = false;

  private constructor(private readonly ws: WebSocket) {}

  static open(onStatus: (m: string) => void, url = BRIDGE_URL): Promise<BridgeTransport> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        reject(new Error(t('errBridgeDown')));
        return;
      }
      ws.binaryType = 'arraybuffer';
      const transport = new BridgeTransport(ws);
      let ready = false;
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') {
          transport.onData(new Uint8Array(ev.data as ArrayBuffer));
          return;
        }
        const msg = JSON.parse(ev.data) as { type: string; [k: string]: unknown };
        if (msg.type === 'ready') {
          ready = true;
          onStatus(`  ✓ helper opened RFCOMM channel ${msg.channel} (MTU ${msg.maxWrite})`);
          resolve(transport);
        } else if (msg.type === 'error') {
          const err = new Error(t('errBridgeBand', { phase: String(msg.phase), code: String(msg.code) }));
          if (!ready) reject(err);
          else onStatus(`⚠ ${err.message}`);
        } else if (msg.type === 'status') {
          onStatus(`  helper: ${String(msg.event)}${msg.channel ? ` ${String(msg.channel)}` : ''}${msg.count !== undefined ? ` ${String(msg.count)}` : ''}`);
        } else if (msg.type === 'closed') {
          onStatus(`  helper: closed (${String(msg.reason)})`);
        }
      };
      ws.onerror = () => {
        if (!ready) reject(new Error(t('errBridgeDown')));
      };
      ws.onclose = () => {
        if (!ready) reject(new Error(t('errBridgeDown')));
        if (!transport.closed) {
          transport.closed = true;
          transport.onClose();
        }
      };
    });
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error(t('errConnLost'));
    this.ws.send(data as Uint8Array<ArrayBuffer>);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.ws.close();
  }
}
