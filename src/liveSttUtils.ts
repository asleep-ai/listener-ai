// Frame plumbing shared by the live STT providers (liveSttProvider.ts and
// sonioxLiveProvider.ts). It lives in its own module so the Soniox provider
// never has to import the module that constructs it.

export function asUint8Array(data: ArrayBuffer | Uint8Array): Uint8Array {
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

export function parseMessageData(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  return String(data);
}

export function downsamplePcm16(
  input: Uint8Array,
  inputRate: number,
  outputRate: number,
): Uint8Array {
  if (inputRate === outputRate) return input;
  if (input.byteLength < 2) return input;
  // Int16Array views require a 2-byte-aligned offset; copy when the incoming
  // view starts on an odd byte to avoid a RangeError.
  const source =
    input.byteOffset % 2 === 0
      ? new Int16Array(input.buffer, input.byteOffset, Math.floor(input.byteLength / 2))
      : new Int16Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.floor(source.length / ratio));
  const output = new Int16Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(source.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += source[j] ?? 0;
      count++;
    }
    output[i] = Math.max(-32768, Math.min(32767, Math.round(sum / Math.max(1, count))));
  }
  return new Uint8Array(output.buffer);
}
