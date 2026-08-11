import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AbiCoder } from "ethers";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const contractsDirectory = resolve(scriptDirectory, "..");
const kitDirectory = resolve(contractsDirectory, "verification", "saigon-nft-v1");
if (existsSync(kitDirectory)) throw new Error(`Verification kit already exists: ${kitDirectory}`);

const manifest = JSON.parse(readFileSync(resolve(contractsDirectory, "deployments", "nft-saigon.json"), "utf8"));
if (manifest.chainId !== 202601 || manifest.scope !== "MattMineNftV1Saigon") {
  throw new Error("The deployment manifest is not the MATT Mine NFT Saigon release.");
}

const definitions = [
  ["MattMineSaigonMatt", "src/nft/testnet/MattMineSaigonMatt.sol"],
  ["MattMineSaigonCrystal", "src/nft/testnet/MattMineSaigonCrystal.sol"],
  ["MattMineSaigonRandomness", "src/nft/testnet/MattMineSaigonRandomness.sol"],
  ["MattMiner", "src/nft/MattMiner.sol"],
  ["MattEquipment", "src/nft/MattEquipment.sol"],
  ["MattLoadout", "src/nft/MattLoadout.sol"],
  ["MattChest", "src/nft/MattChest.sol"],
  ["MattGameSettlement", "src/nft/MattGameSettlement.sol"],
  ["MattCrystalRedemption", "src/nft/MattCrystalRedemption.sol"]
];

for (const directory of [
  "artifacts",
  "constructor-args",
  "encoded-constructor-args",
  "standard-json",
  "sources"
]) mkdirSync(resolve(kitDirectory, directory), { recursive: true });

const abiCoder = AbiCoder.defaultAbiCoder();
const contracts = [];
let compilerSettings;
let compiler;

for (const [name, sourceName] of definitions) {
  const record = manifest.contracts?.[name];
  if (!record) throw new Error(`${name} is missing from the deployment manifest.`);
  const artifactPath = resolve(contractsDirectory, "artifacts", ...sourceName.split("/"), `${name}.json`);
  const artifactText = readFileSync(artifactPath, "utf8");
  const artifact = JSON.parse(artifactText);
  const buildInfoPath = resolve(contractsDirectory, "artifacts", "build-info", `${artifact.buildInfoId}.json`);
  const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf8"));
  const input = buildInfo.input;
  compiler ??= {
    version: buildInfo.solcVersion,
    longVersion: buildInfo.solcLongVersion,
    type: buildInfo.compilerType
  };
  compilerSettings ??= input.settings;

  const constructor = artifact.abi.find((entry) => entry.type === "constructor");
  const types = constructor?.inputs?.map((inputDefinition) => inputDefinition.type) ?? [];
  if (types.length !== record.constructorArgs.length) {
    throw new Error(`${name} constructor argument count does not match its artifact ABI.`);
  }
  const encoded = abiCoder.encode(types, record.constructorArgs).slice(2);
  const identifier = `${sourceName}:${name}`;

  writeFileSync(resolve(kitDirectory, "artifacts", `${name}.json`), artifactText, "utf8");
  writeJson(resolve(kitDirectory, "standard-json", `${name}.json`), input);
  writeFileSync(
    resolve(kitDirectory, "constructor-args", `${name}.js`),
    `export default ${JSON.stringify(record.constructorArgs, null, 2)};\n`,
    "utf8"
  );
  writeFileSync(resolve(kitDirectory, "encoded-constructor-args", `${name}.txt`), `${encoded}\n`, "utf8");

  for (const [inputSourceName, source] of Object.entries(input.sources)) {
    if (inputSourceName.includes("..") || inputSourceName.startsWith("/") || /^[A-Za-z]:/.test(inputSourceName)) {
      throw new Error(`Unsafe compiler source path: ${inputSourceName}`);
    }
    const destination = resolve(kitDirectory, "sources", ...inputSourceName.split("/"));
    if (!destination.startsWith(resolve(kitDirectory, "sources"))) {
      throw new Error(`Compiler source escaped the verification kit: ${inputSourceName}`);
    }
    if (!existsSync(destination)) {
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, source.content, "utf8");
    }
  }

  contracts.push({
    contractName: name,
    address: record.address,
    explorerUrl: `https://saigon-explorer.roninchain.com/address/${record.address}`,
    creationTransactionHash: record.transactionHash,
    blockNumber: record.blockNumber,
    sourceIdentifier: identifier,
    buildInfoId: artifact.buildInfoId,
    constructorTypes: types,
    constructorArgs: record.constructorArgs,
    encodedConstructorArgs: encoded
  });
}

writeJson(resolve(kitDirectory, "deployment-manifest.json"), manifest);
writeJson(resolve(kitDirectory, "contracts.json"), {
  network: "Ronin Saigon",
  chainId: 202601,
  compiler,
  contracts
});
writeJson(resolve(kitDirectory, "compiler-settings.json"), {
  compiler,
  language: "Solidity",
  settings: compilerSettings,
  license: "MIT"
});

const commandLines = [
  "$ErrorActionPreference = \"Stop\"",
  "$contractsDirectory = Resolve-Path (Join-Path $PSScriptRoot \"..\\..\")",
  "Set-Location -LiteralPath $contractsDirectory",
  ""
];
for (const entry of contracts) {
  commandLines.push(`Write-Host \"Verifying ${entry.contractName}...\" -ForegroundColor Cyan`);
  commandLines.push([
    "npx.cmd hardhat --network saigonReadOnly --build-profile production verify sourcify",
    `--contract \"${entry.sourceIdentifier}\"`,
    `--creation-tx-hash \"${entry.creationTransactionHash}\"`,
    `--constructor-args-path \"verification/saigon-nft-v1/constructor-args/${entry.contractName}.js\"`,
    `-- \"${entry.address}\"`
  ].join(" `\n  "));
  commandLines.push("");
}
writeFileSync(resolve(kitDirectory, "verification-commands.ps1"), `${commandLines.join("\n")}\n`, "utf8");

const table = contracts.map((entry) =>
  `| ${entry.contractName} | \`${entry.address}\` | \`${entry.sourceIdentifier}\` |`
).join("\n");
writeFileSync(resolve(kitDirectory, "README.md"), `# MATT Mine NFT v1 — Saigon verification kit

This folder contains the exact local compiler material for the nine contracts deployed to Ronin
Saigon chain \`202601\`. Nothing in this kit is a private key, seed phrase, or keystore password.

## Exact compiler settings

- Compiler: Solidity \`${compiler.longVersion}\`
- EVM version: \`${compilerSettings.evmVersion}\`
- Optimizer: enabled, \`${compilerSettings.optimizer.runs}\` runs
- Via IR: \`${compilerSettings.viaIR}\`
- Metadata bytecode hash: \`${compilerSettings.metadata.bytecodeHash}\`
- License: \`MIT\`

## Contracts

| Contract | Address | Fully qualified source name |
|---|---|---|
${table}

## Manual explorer verification

For each contract, use the matching file in \`standard-json/\` as the Solidity Standard JSON Input.
Select compiler \`${compiler.longVersion}\`, then enter the fully qualified source name from the table.
If the explorer asks for ABI-encoded constructor arguments, paste the matching value from
\`encoded-constructor-args/\` without adding \`0x\`.

The human-readable constructor values and types are in \`contracts.json\`. Standalone Hardhat argument
modules are in \`constructor-args/\`. Exact ABI and bytecode artifacts are in \`artifacts/\`. Every
Solidity and OpenZeppelin source referenced by the compiler inputs is also expanded under \`sources/\`.

To verify using the local Hardhat project instead of the explorer form, review and run:

\`\`\`powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\\verification\\saigon-nft-v1\\verification-commands.ps1
\`\`\`
`, "utf8");

const sumLines = listFiles(kitDirectory)
  .filter((path) => !path.endsWith("SHA256SUMS.txt"))
  .map((path) => {
    const relative = path.slice(kitDirectory.length + 1).replaceAll("\\", "/");
    const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
    return `${hash}  ${relative}`;
  });
writeFileSync(resolve(kitDirectory, "SHA256SUMS.txt"), `${sumLines.join("\n")}\n`, "utf8");

console.log(`Saigon verification kit created: ${kitDirectory}`);
console.log(`${contracts.length} contracts, ${listFiles(resolve(kitDirectory, "sources")).length} expanded source files.`);

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  }).sort();
}
