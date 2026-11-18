import {
  decodeBip39Mnemonic,
  deriveHdPath,
  deriveHdPathRelative,
  deriveHdPrivateNodeFromBip39Mnemonic,
  generateBip39Mnemonic,
  secp256k1,
} from '@bitauth/libauth';
import { SignatureTemplate } from 'cashscript';

const ITERATIONS = 600_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export const browserWalletStorageKey = (network) => `cashcraft:browser-wallet:v1:${network}`;
export { generateBip39Mnemonic };

export function normalizeMnemonic(phrase) {
  const normalized = phrase.trim().toLowerCase().replace(/\s+/g, ' ');
  if (typeof decodeBip39Mnemonic(normalized) === 'string') {
    throw new Error('Invalid BIP39 recovery phrase or checksum.');
  }
  return normalized;
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytes(value, length) {
  if (typeof value !== 'string' || value.length !== length * 2 || !/^[0-9a-f]+$/.test(value)) {
    throw new Error('Invalid encrypted wallet data.');
  }
  return Uint8Array.from(value.match(/../g), (pair) => Number.parseInt(pair, 16));
}

async function passwordKey(password, salt) {
  if (password.length < 12) throw new Error('Use a password of at least 12 characters.');
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

export async function encryptBrowserWallet(phrase, password, network) {
  const plaintext = encoder.encode(normalizeMnemonic(phrase));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const key = await passwordKey(password, salt);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(`cashcraft-wallet-v1:${network}`) },
      key, plaintext,
    );
    return JSON.stringify({ version: 1, network, salt: hex(salt), iv: hex(iv), ciphertext: hex(new Uint8Array(ciphertext)) });
  } finally {
    plaintext.fill(0);
  }
}

export async function decryptBrowserWallet(serialized, password, network) {
  const vault = JSON.parse(serialized);
  if (!vault || vault.version !== 1 || vault.network !== network) {
    throw new Error('Encrypted wallet network or version does not match.');
  }
  const salt = bytes(vault.salt, 16);
  const iv = bytes(vault.iv, 12);
  if (typeof vault.ciphertext !== 'string' || vault.ciphertext.length < 32 ||
      vault.ciphertext.length > 1024 || vault.ciphertext.length % 2 !== 0) {
    throw new Error('Invalid encrypted wallet data.');
  }
  const ciphertext = bytes(vault.ciphertext, vault.ciphertext.length / 2);
  const key = await passwordKey(password, salt);
  let plaintext;
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(`cashcraft-wallet-v1:${network}`) },
      key, ciphertext,
    ));
  } catch {
    throw new Error('Incorrect password or damaged encrypted wallet.');
  }
  try {
    return normalizeMnemonic(decoder.decode(plaintext));
  } finally {
    plaintext.fill(0);
  }
}

export class BrowserWallet {
  constructor(phrase) {
    const root = deriveHdPrivateNodeFromBip39Mnemonic(normalizeMnemonic(phrase));
    try {
      this.account = deriveHdPath(root, "m/44'/145'/0'");
    } finally {
      root.privateKey.fill(0);
      root.chainCode.fill(0);
    }
    this.isBrowserWallet = true;
  }

  exportSession(vault) {
    if (!this.account || !vault) throw new Error('Browser wallet session is unavailable.');
    const account = this.account;
    return JSON.stringify({
      vault, privateKey: hex(account.privateKey), chainCode: hex(account.chainCode),
      parentFingerprint: hex(account.parentFingerprint), parentIdentifier: hex(account.parentIdentifier),
      childIndex: account.childIndex, depth: account.depth,
    });
  }

  static fromSession(serialized, vault) {
    const saved = JSON.parse(serialized);
    if (!vault || saved.vault !== vault || saved.depth !== 3 || saved.childIndex !== 0x80000000) {
      throw new Error('Browser wallet session no longer matches the encrypted wallet.');
    }
    const wallet = Object.create(BrowserWallet.prototype);
    wallet.account = {
      privateKey: bytes(saved.privateKey, 32),
      chainCode: bytes(saved.chainCode, 32),
      parentFingerprint: bytes(saved.parentFingerprint, 4),
      parentIdentifier: bytes(saved.parentIdentifier, 20),
      childIndex: saved.childIndex,
      depth: saved.depth,
    };
    if (!secp256k1.validatePrivateKey(wallet.account.privateKey)) {
      wallet.account.privateKey.fill(0);
      wallet.account.chainCode.fill(0);
      throw new Error('Invalid browser wallet session.');
    }
    wallet.isBrowserWallet = true;
    return wallet;
  }

  privateKey(pathIndex, index) {
    const n = Number(index);
    if (!this.account || ![0, 1].includes(pathIndex) || !Number.isSafeInteger(n) || n < 0 || n >= 2 ** 31) {
      throw new Error('Invalid browser wallet derivation path.');
    }
    const node = deriveHdPathRelative(this.account, `${pathIndex}/${n}`);
    node.chainCode.fill(0);
    return node.privateKey;
  }

  getPubkey(pathIndex, index) {
    const key = this.privateKey(pathIndex, index);
    try {
      const publicKey = secp256k1.derivePublicKeyCompressed(key);
      if (typeof publicKey === 'string') throw new Error(publicKey);
      return publicKey;
    } finally {
      key.fill(0);
    }
  }

  unlocker(pathIndex, index) {
    const key = this.privateKey(pathIndex, index);
    try {
      return new SignatureTemplate(key).unlockP2PKH();
    } catch (error) {
      key.fill(0);
      throw error;
    }
  }

  clearStoredSession() {}

  async destroy() {
    if (this.account) {
      this.account.privateKey.fill(0);
      this.account.chainCode.fill(0);
      this.account = null;
    }
  }
}
