import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createHmac, pbkdf2Sync } from 'node:crypto';
import {
  binToHex, cashAddressToLockingBytecode, createVirtualMachineBch, decodeTransaction,
  encodeCashAddress, hexToBin,
} from '@bitauth/libauth';
import { hash160 } from '@cashscript/utils';
import { TransactionBuilder } from 'cashscript';
import {
  BrowserWallet, decryptBrowserWallet, encryptBrowserWallet, normalizeMnemonic,
} from '../src/browser-wallet.js';

const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const password = 'test password 12345';

function independentPublicKey(path) {
  const hmac = (key, message) => createHmac('sha512', key).update(message).digest();
  const publicKey = (privateKey) => {
    const ecdh = createECDH('secp256k1');
    ecdh.setPrivateKey(privateKey);
    return ecdh.getPublicKey(null, 'compressed');
  };
  const order = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
  let node = hmac('Bitcoin seed', pbkdf2Sync(mnemonic, 'mnemonic', 2048, 64, 'sha512'));
  let key = node.subarray(0, 32);
  let chain = node.subarray(32);
  for (const index of path) {
    const encodedIndex = Buffer.alloc(4);
    encodedIndex.writeUInt32BE(index);
    const prefix = index >= 0x80000000 ? Buffer.concat([Buffer.from([0]), key]) : publicKey(key);
    node = hmac(chain, Buffer.concat([prefix, encodedIndex]));
    const child = (BigInt(`0x${node.subarray(0, 32).toString('hex')}`) + BigInt(`0x${key.toString('hex')}`)) % order;
    key = Buffer.from(child.toString(16).padStart(64, '0'), 'hex');
    chain = node.subarray(32);
  }
  return publicKey(key);
}

test('browser wallet uses standard BCH receive and change derivation', async () => {
  const wallet = new BrowserWallet(mnemonic);
  for (const [path, index] of [[0, 0], [1, 4]]) {
    const expected = independentPublicKey([0x8000002c, 0x80000091, 0x80000000, path, index]);
    assert.equal(binToHex(wallet.getPubkey(path, BigInt(index))), expected.toString('hex'));
  }
  assert.throws(() => wallet.getPubkey(2, 0), /derivation path/);
  assert.throws(() => wallet.getPubkey(0, 2 ** 31), /derivation path/);
  await wallet.destroy();
  assert.throws(() => wallet.getPubkey(0, 0), /derivation path/);
});

test('password encryption protects the phrase and detects wrong passwords or tampering', async () => {
  const vault = await encryptBrowserWallet(mnemonic, password, 'chipnet');
  assert.equal(vault.includes(mnemonic), false);
  assert.equal(await decryptBrowserWallet(vault, password, 'chipnet'), mnemonic);
  assert.notEqual(await encryptBrowserWallet(mnemonic, password, 'chipnet'), vault);
  await assert.rejects(decryptBrowserWallet(vault, 'incorrect password', 'chipnet'), /Incorrect password/);
  await assert.rejects(decryptBrowserWallet(vault, password, 'mainnet'), /network/);
  const changed = JSON.parse(vault);
  changed.ciphertext = (changed.ciphertext[0] === '0' ? '1' : '0') + changed.ciphertext.slice(1);
  await assert.rejects(decryptBrowserWallet(JSON.stringify(changed), password, 'chipnet'), /damaged/);
  await assert.rejects(encryptBrowserWallet(mnemonic, 'short', 'chipnet'), /at least 12/);
  assert.throws(() => normalizeMnemonic('abandon '.repeat(12)), /recovery phrase/);
});

test('tab session restores the same account without saving the recovery phrase', async () => {
  const wallet = new BrowserWallet(mnemonic);
  const session = wallet.exportSession('vault');
  assert.equal(session.includes(mnemonic), false);
  const restored = BrowserWallet.fromSession(session, 'vault');
  assert.equal(binToHex(restored.getPubkey(0, 0)), binToHex(wallet.getPubkey(0, 0)));
  assert.equal(binToHex(restored.getPubkey(1, 4)), binToHex(wallet.getPubkey(1, 4)));
  assert.throws(() => BrowserWallet.fromSession(session, 'other vault'), /does not match|no longer matches/);
  await wallet.destroy();
  await restored.destroy();
});

test('locally signed CashToken send preserves change and passes the BCH virtual machine', async () => {
  const wallet = new BrowserWallet(mnemonic);
  const publicKey = wallet.getPubkey(0, 0);
  const spendAddress = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: hash160(publicKey) }).address;
  const tokenAddress = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: hash160(publicKey) }).address;
  const lockingBytecode = cashAddressToLockingBytecode(spendAddress).bytecode;
  const category = 'ab'.repeat(32);
  const input = {
    txid: '12'.repeat(32), vout: 0, satoshis: 30_000n,
    lockingBytecode: binToHex(lockingBytecode), token: { category, amount: 5n },
  };
  const unlocker = wallet.unlocker(0, 0);
  const builder = new TransactionBuilder({ provider: { network: 'chipnet' }, maximumFeeSatoshis: 10_000n });
  builder.addInput(input, unlocker)
    .addOutput({ to: tokenAddress, amount: 1000n, token: { category, amount: 1n } })
    .addTokenChangeOutputIfNeeded({ category, to: tokenAddress })
    .addBchChangeOutputIfNeeded({ to: spendAddress, feeRate: 1.1 });
  const transaction = decodeTransaction(hexToBin(builder.build()));
  assert.notEqual(typeof transaction, 'string');
  const sourceOutputs = [{
    lockingBytecode, valueSatoshis: input.satoshis,
    token: { category: hexToBin(category), amount: 5n },
  }];
  assert.equal(createVirtualMachineBch().verify({ transaction, sourceOutputs }), true);
  assert.deepEqual(transaction.outputs.filter((output) => output.token).map((output) => output.token.amount), [1n, 4n]);
  assert.ok(transaction.outputs.some((output) => !output.token && output.valueSatoshis > 0n));
  sourceOutputs[0].valueSatoshis += 1n;
  assert.notEqual(createVirtualMachineBch().verify({ transaction, sourceOutputs }), true);
  unlocker.template.privateKey.fill(0);
  await wallet.destroy();
});
