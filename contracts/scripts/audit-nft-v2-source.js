import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const contractsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const targets = [resolve(contractsRoot, "nftv2"), resolve(contractsRoot, "nft", "MattMineVRFV25Adapter.sol")];
const files = targets.flatMap(walk).filter((path) => path.endsWith(".sol"));
const violations = [];
for (const path of files) {
  const source = readFileSync(path, "utf8");
  for (const [label, pattern] of [
    ["selfdestruct", /\bselfdestruct\b/],
    ["tx.origin", /\btx\.origin\b/],
    ["runtime placeholder", /\b(REPLACE_ME|TODO_DEPLOYMENT|FIXME_DEPLOYMENT)\b/]
  ]) if (pattern.test(source)) violations.push(`${path}: forbidden ${label}`);
  if (!/^\/\/ SPDX-License-Identifier: MIT/m.test(source)) violations.push(`${path}: missing SPDX MIT header`);
  if (!/pragma solidity \^0\.8\.28;/.test(source)) violations.push(`${path}: compiler pragma drift`);
}
const config = readFileSync(resolve(contractsRoot, "..", "hardhat.config.js"), "utf8");
for (const required of [
  'version: "0.8.28"', 'evmVersion: "london"', 'viaIR: true',
  'optimizer:', 'enabled: true', 'apiUrl: "https://sourcify.roninchain.com/server/"'
]) if (!config.includes(required)) violations.push(`hardhat.config.js: missing ${required}`);
if (violations.length) throw new Error(`NFT V2 source audit failed:\n${violations.join("\n")}`);
console.log(`NFT V2 source audit passed for ${files.length} Solidity files.`);
console.log("No selfdestruct, tx.origin, deployment placeholders, compiler drift, or Ronin build-profile drift was found.");

function walk(path) {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((entry) => walk(resolve(path, entry)));
}
