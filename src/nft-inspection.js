import { hexToBin } from '@bitauth/libauth';

export function inspectNft(nft) {
  const capability = nft?.capability;
  const commitment = nft?.commitment;
  const validCapability = ['none', 'mutable', 'minting'].includes(capability);
  const validCommitment = typeof commitment === 'string' &&
    /^(?:[0-9a-f]{2})*$/i.test(commitment) && commitment.length <= 80;

  return {
    capability: validCapability ? capability : null,
    commitment: validCommitment ? commitment.toLowerCase() : null,
    commitmentBytes: validCommitment ? hexToBin(commitment).length : null,
  };
}
