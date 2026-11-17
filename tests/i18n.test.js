import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const languageOptions = ['en', 'es', 'fr', 'de'].map((languageOption) => ({
  dataset: { languageOption },
  setAttribute(name, value) { this[name] = value; },
}));
globalThis.localStorage = {
  value: 'fr',
  getItem(key) {
    assert.equal(key, 'ctf-language');
    return this.value;
  },
  setItem(key, value) {
    assert.equal(key, 'ctf-language');
    this.value = value;
  },
};
globalThis.document = {
  body: { nodeType: 1, childNodes: [], hasAttribute() { return false; } },
  documentElement: {},
  querySelectorAll() { return languageOptions; },
};
globalThis.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
globalThis.MutationObserver = class {
  observe() {}
};

const source = await readFile(new URL('../src/i18n.js', import.meta.url), 'utf8');
const { setLanguage, translate } = await import('../src/i18n.js');

test('French and German translate every existing Spanish dictionary entry', () => {
  const keysFor = (language) => {
    const body = source.match(new RegExp(`const ${language} = \\{([\\s\\S]*?)\\n\\};`))?.[1];
    assert.ok(body, `missing ${language} dictionary`);
    return [...body.matchAll(/^  '([^']+)': '([^']*)',?$/gm)].map(([, key, value]) => {
      assert.notEqual(value, '', `${language} translation missing for ${key}`);
      return key;
    }).sort();
  };
  const keys = keysFor('spanish');
  for (const language of ['french', 'german']) {
    assert.deepEqual(keysFor(language), keys);
  }
});

test('stored language initializes selection and supported language changes persist', () => {
  assert.equal(document.documentElement.lang, 'fr');
  assert.equal(localStorage.value, 'fr');

  for (const language of ['de', 'es', 'en']) {
    setLanguage(language);
    assert.equal(document.documentElement.lang, language);
    assert.equal(localStorage.value, language);
    assert.equal(languageOptions.find((option) => option.dataset.languageOption === language)['aria-pressed'], 'true');
  }
});

test('French and German translate static and dynamic strings', () => {
  setLanguage('fr');
  assert.equal(translate('Connection'), 'Connexion');
  assert.equal(translate('Wallet handshake complete · Connected to wallet'), 'Connexion au portefeuille établie · Connected to wallet');
  assert.equal(translate('12 base units'), '12 unités de base');
  assert.equal(translate('2 fungible-token categories'), '2 catégories de jetons fongibles');

  setLanguage('de');
  assert.equal(translate('Connection'), 'Verbindung');
  assert.equal(translate('Wallet disconnected · user rejected'), 'Wallet getrennt · user rejected');
  assert.equal(translate('12 token base units'), '12 Token-Basiseinheiten');
  assert.equal(translate('1 fungible-token category'), '1 Kategorie fungibler Token');
});

test('landing privacy message is translated in each supported language', () => {
  const headline = 'No account. No KYC. Just your wallet.';
  const description = 'Connect your wallet to manage BCH and CashTokens. Your keys stay in your wallet.';
  for (const language of ['es', 'fr', 'de']) {
    setLanguage(language);
    assert.notEqual(translate(headline), headline);
    assert.notEqual(translate(description), description);
  }
});

test('unsupported saved languages and unknown strings fall back to English', () => {
  setLanguage('xx');
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(localStorage.value, 'en');
  assert.equal(translate('Connection'), 'Connection');
  assert.equal(translate('A string without a translation'), 'A string without a translation');
});
