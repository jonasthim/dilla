import { CborError, arr, decode, type CborValue } from '../cbor';

/** Reject an oversized definite outer array before decode copies any contained byte strings. */
export function decodeBoundedArray(bytes: Uint8Array, maxRows: number): CborValue[] {
  const first = bytes[0];
  if (first === undefined || first >> 5 !== 4) throw new CborError('E_CBOR_SHAPE', 'expected outer array');
  const ai = first & 31;
  if (ai >= 28) throw new CborError('E_CBOR_TYPE', 'outer array length');
  let count = BigInt(ai);
  if (ai >= 24) {
    const width = ai === 24 ? 1 : ai === 25 ? 2 : ai === 26 ? 4 : 8;
    if (bytes.length < width + 1) throw new CborError('E_CBOR_TRUNCATED', 'outer array head');
    count = 0n;
    for (let i = 1; i <= width; i++) count = (count << 8n) | BigInt(bytes[i]);
  }
  if (count > BigInt(maxRows)) throw new CborError('E_CBOR_RANGE', 'outer array limit');
  return arr(decode(bytes));
}
