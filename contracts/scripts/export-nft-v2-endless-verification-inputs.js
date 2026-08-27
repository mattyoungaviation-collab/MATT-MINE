import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const contractsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = path.join(contractsRoot, "artifacts");
const outputRoot = path.join(contractsRoot, "deployments", "manual-verification");

const exports = [
  {
    label: "proxy",
    artifactPath: path.join(
      artifactRoot,
      "src",
      "nftv2",
      "MattV2ERC1967Proxy.sol",
      "MattV2ERC1967Proxy.json"
    )
  },
  {
    label: "implementation",
    artifactPath: path.join(
      artifactRoot,
      "src",
      "nftv2",
      "MattV2EndlessSettlement.sol",
      "MattV2EndlessSettlement.json"
    )
  }
];

await fs.mkdir(outputRoot, { recursive: true });

for (const item of exports) {
  const artifact = JSON.parse(await fs.readFile(item.artifactPath, "utf8"));
  const buildInfoPath = path.join(artifactRoot, "build-info", `${artifact.buildInfoId}.json`);
  const buildInfo = JSON.parse(await fs.readFile(buildInfoPath, "utf8"));
  const outputPath = path.join(
    outputRoot,
    `matt-mine-endless-${item.label}-standard-input.json`
  );

  await fs.writeFile(outputPath, `${JSON.stringify(buildInfo.input, null, 2)}\n`, "utf8");
  console.log(`${item.label}: ${outputPath}`);
  console.log(`compiler: ${buildInfo.solcLongVersion}`);
  console.log(`artifact: ${artifact.inputSourceName}:${artifact.contractName}`);
}
