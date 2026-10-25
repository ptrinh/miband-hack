import { type ByteTransport, SPP_UUID } from './types';
import { t } from '../i18n';

export const webSerialAvailable = (): boolean => typeof navigator !== 'undefined' && 'serial' in navigator;

/**
 * Bluetooth Classic SPP via Web Serial (Chrome/Edge 117+ on desktop). The band must already be
 * paired in the OS Bluetooth settings; it then shows up as an RFCOMM serial port.
 */
export class SerialTransport implements ByteTransport {
  onData: (data: Uint8Array) => void = () => {};
  onClose: () => void = () => {};
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private closed = false;

  private constructor(private readonly port: SerialPort, readonly label: string) {}

  static async request(): Promise<SerialTransport> {
    if (!webSerialAvailable()) throw new Error(t('errNoWebSerial'));
    const port = await navigator.serial.requestPort({
      filters: [{ bluetoothServiceClassId: SPP_UUID }],
      allowedBluetoothServiceClassIds: [SPP_UUID],
    } as SerialPortRequestOptions);
    // Baud rate is meaningless for RFCOMM but required by the API.
    await port.open({ baudRate: 115200, bufferSize: 65536 });
    const info = port.getInfo() as SerialPortInfo & { bluetoothServiceClassId?: string };
    const transport = new SerialTransport(port, info.bluetoothServiceClassId ? 'Bluetooth SPP' : 'Serial');
    transport.writer = port.writable!.getWriter();
    void transport.readLoop();
    return transport;
  }

  private async readLoop(): Promise<void> {
    try {
      while (this.port.readable && !this.closed) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value?.length) this.onData(value);
          }
        } finally {
          this.reader.releaseLock();
        }
      }
    } catch (e) {
      console.warn('[serial] read error', e);
    }
    if (!this.closed) {
      this.closed = true;
      this.onClose();
    }
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error('Serial port is not open');
    await this.writer.write(data);
  }

  async close(): Promise<void> {
    this.closed = true;
    try { await this.reader?.cancel(); } catch { /* already closed */ }
    try { this.writer?.releaseLock(); } catch { /* ignore */ }
    try { await this.port.close(); } catch { /* ignore */ }
  }
}
