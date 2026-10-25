// Helpers shared by the editors of the customizable demo apps (Notes, Checklist): the content
// lives in this browser's localStorage only and moves between browsers as an exported JSON file.

/** The parsed JSON stored under `key`, or undefined when missing, corrupt or storage is blocked. */
export function loadStored(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

/** Stores `value` as JSON; false when the browser blocks or fills up storage. */
export function saveStored(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Saves `data` as a pretty-printed JSON download named `<prefix>-YYYY-MM-DD.json`. */
export function downloadJson(prefix: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${prefix}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Wires an Import button to a hidden file input; `onFile` errors go to `fail`. */
export function bindImport(btn: HTMLElement, input: HTMLInputElement, onFile: (file: File) => Promise<void>, fail: (e: unknown) => void): void {
  btn.onclick = () => input.click();
  input.onchange = () => {
    const file = input.files?.[0];
    input.value = ''; // allow importing the same file again
    if (file) onFile(file).catch(fail);
  };
}
