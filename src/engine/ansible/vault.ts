/**
 * Ansible Vault: files and strings encrypted with a password, in the format the real
 * thing writes ($ANSIBLE_VAULT;1.1;AES256 followed by hex). The cipher here is a
 * password-keyed stream, not AES: it is reversible, deterministic and useless for real
 * secrets, which is the point. What matters for learning is the workflow: an encrypted
 * file is unreadable without the password, git sees only hex, and a playbook that needs
 * one says so.
 */

export const VAULT_HEADER = '$ANSIBLE_VAULT;1.1;AES256';

export class VaultError extends Error {}

function keyStream(password: string, length: number, salt: string): number[] {
  let h = 0x811c9dc5;
  for (const c of salt + password) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  const out: number[] = [];
  for (let i = 0; i < length; i++) {
    h = Math.imul(h ^ (i + 0x9e37), 0x01000193) >>> 0;
    out.push((h >>> 16) & 0xff);
  }
  return out;
}

function toHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function wrap(hex: string, indent = ''): string {
  const lines: string[] = [];
  for (let i = 0; i < hex.length; i += 80) lines.push(indent + hex.slice(i, i + 80));
  return lines.join('\n');
}

export function isVaulted(text: string): boolean {
  return text.trimStart().startsWith('$ANSIBLE_VAULT');
}

/** Encrypt text into the vault envelope. The salt keeps two files from looking alike. */
export function vaultEncrypt(plain: string, password: string, salt = 'netlab'): string {
  const bytes = [...unescape(encodeURIComponent(plain))].map((c) => c.charCodeAt(0));
  const key = keyStream(password, bytes.length, salt);
  const body = toHex(bytes.map((b, i) => b ^ key[i]));
  const checksum = toHex(keyStream(password, 4, salt + plain.length));
  const payload = toHex([...`${salt}\n${checksum}\n${body}`].map((c) => c.charCodeAt(0)));
  return `${VAULT_HEADER}\n${wrap(payload)}\n`;
}

export function vaultDecrypt(text: string, passwords: string[]): string {
  const body = text.trim().split('\n').slice(1).join('').replace(/\s/g, '');
  if (!/^[0-9a-f]*$/.test(body) || body.length % 2) throw new VaultError('input is not vault encrypted data');
  const outer = String.fromCharCode(...(body.match(/../g) ?? []).map((h) => parseInt(h, 16)));
  const [salt, checksum, hex] = outer.split('\n');
  if (hex === undefined) throw new VaultError('input is not vault encrypted data');
  const bytes = (hex.match(/../g) ?? []).map((h) => parseInt(h, 16));
  for (const password of passwords) {
    const key = keyStream(password, bytes.length, salt);
    const plain = decodeURIComponent(escape(String.fromCharCode(...bytes.map((b, i) => b ^ key[i]))));
    if (toHex(keyStream(password, 4, salt + plain.length)) === checksum) return plain;
  }
  throw new VaultError('Decryption failed (no vault secrets were found that could decrypt)');
}

/** !vault |-style inline strings, as ansible-vault encrypt_string writes them. */
export function encryptString(plain: string, password: string, indent = '          '): string {
  const envelope = vaultEncrypt(plain, password, 'inline');
  const [, ...rest] = envelope.trim().split('\n');
  return `!vault |\n${indent}${VAULT_HEADER}\n${rest.map((l) => indent + l).join('\n')}`;
}

/** Decrypt any vaulted values inside parsed YAML data (strings starting with the header). */
export function decryptValues<T>(value: T, passwords: string[]): T {
  if (typeof value === 'string' && isVaulted(value)) return vaultDecrypt(value, passwords) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => decryptValues(v, passwords)) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, decryptValues(v, passwords)])) as unknown as T;
  }
  return value;
}
