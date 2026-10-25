/** A reliable, ordered byte stream to the band (SPP over Web Serial, or BLE V2 characteristics). */
export interface ByteTransport {
  readonly label: string;
  write(data: Uint8Array): Promise<void>;
  onData: (data: Uint8Array) => void;
  onClose: () => void;
  close(): Promise<void>;
}

export const SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb';
export const XIAOMI_SERVICE = 0xfe95;
export const uuid16 = (n: number): string => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
