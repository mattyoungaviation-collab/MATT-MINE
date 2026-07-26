import { concatHex, encodeAbiParameters, keccak256 } from 'viem';

const LEAF_PARAMETERS = [
  { type: 'uint256' },
  { type: 'address' },
  { type: 'uint256' },
  { type: 'uint8' },
  { type: 'address' },
  { type: 'uint256' }
];

export function createStandardMerkleTree(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError('At least one Merkle value is required.');
  }
  const hashedValues = values.map((value, valueIndex) => ({
    valueIndex,
    hash: standardLeafHash(value)
  })).sort((left, right) => left.hash.localeCompare(right.hash));
  const tree = new Array(2 * hashedValues.length - 1);
  const treeIndices = new Array(values.length);
  for (const [leafIndex, leaf] of hashedValues.entries()) {
    const treeIndex = tree.length - leafIndex - 1;
    tree[treeIndex] = leaf.hash;
    treeIndices[leaf.valueIndex] = treeIndex;
  }
  for (let index = tree.length - hashedValues.length - 1; index >= 0; index -= 1) {
    tree[index] = standardNodeHash(tree[index * 2 + 1], tree[index * 2 + 2]);
  }
  return {
    root: tree[0],
    getProof(valueIndex) {
      let treeIndex = treeIndices[valueIndex];
      if (!Number.isSafeInteger(treeIndex)) throw new RangeError('Merkle value index is out of bounds.');
      const proof = [];
      while (treeIndex > 0) {
        const sibling = treeIndex % 2 === 1 ? treeIndex + 1 : treeIndex - 1;
        proof.push(tree[sibling]);
        treeIndex = Math.floor((treeIndex - 1) / 2);
      }
      return proof;
    }
  };
}

export function standardLeafHash(value) {
  return keccak256(keccak256(encodeAbiParameters(LEAF_PARAMETERS, value)));
}

export function standardNodeHash(left, right) {
  return keccak256(concatHex([left, right].sort((a, b) => a.localeCompare(b))));
}

export function verifyStandardProof(root, value, proof) {
  const resolved = proof.reduce((hash, sibling) => standardNodeHash(hash, sibling), standardLeafHash(value));
  return resolved.toLowerCase() === String(root || '').toLowerCase();
}
