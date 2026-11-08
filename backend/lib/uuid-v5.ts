// RFC 4122 section 4.3 name-based UUIDs (version 5), using node:crypto's
// SHA-1 instead of the `uuid` package. This project only ever hashes a UTF-8
// name into a namespace, so that is all this module offers.

import { createHash } from 'crypto';

const UUID_BYTE_LENGTH = 16;

/** Parses the canonical 8-4-4-4-12 hex form of a namespace UUID. */
const namespaceBytes = (namespace: string): Buffer => {
  const hex = namespace.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new TypeError(`Invalid UUID namespace: ${namespace}`);
  }
  return Buffer.from(hex, 'hex');
};

export function uuidv5(name: string, namespace: string): string {
  // Per 4.3: hash the namespace UUID's bytes followed by the name's UTF-8
  // bytes, then keep the leftmost 16 bytes of the digest.
  const hash = createHash('sha1');
  hash.update(namespaceBytes(namespace));
  hash.update(Buffer.from(name, 'utf8'));
  const bytes = hash.digest().subarray(0, UUID_BYTE_LENGTH);

  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
