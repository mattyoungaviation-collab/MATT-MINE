import { getAddress, getCreateAddress } from "ethers";

export const NFT_V2_CONTEXT_DEPLOYMENT_GAS_CEILING = 8_000_000n;

const CONTEXT_INDEPENDENT_DEPLOYMENTS = new Set([
  "UpgradeTimelock",
  "Miner",
  "Equipment",
  "ChestRandomness",
  "PassiveRandomness"
]);

export function requiresPriorNftV2Deployments(label) {
  return !CONTEXT_INDEPENDENT_DEPLOYMENTS.has(label);
}

export async function buildNftV2DeploymentPlan(ethers, config, deployerAddress, startingNonce) {
  const planned = {};
  let nonce = Number(startingNonce);
  const steps = [];
  const add = async (label, artifactName, args) => {
    const deploymentNonce = nonce;
    const address = getAddress(getCreateAddress({ from: deployerAddress, nonce: deploymentNonce }));
    nonce += 1;
    planned[label] = address;
    steps.push({ label, artifactName, args, address, nonce: deploymentNonce });
    return address;
  };

  await add("UpgradeTimelock", "MattV2UpgradeTimelock", [config.roles.rootAdmin]);
  await add("Miner", "MattV2Miner", [
    config.roles.rootAdmin, config.roles.treasury,
    config.metadata.minerBaseUri, config.metadata.minerContractUri
  ]);
  await add("Equipment", "MattV2Equipment", [
    config.roles.rootAdmin, config.roles.treasury,
    config.metadata.equipmentBaseUri, config.metadata.equipmentContractUri
  ]);
  const randomnessArgs = [
    config.protocol.vrfCoordinator, config.protocol.vrfSubscriptionId, config.protocol.vrfKeyHash,
    config.roles.rootAdmin, config.vrf.requestConfirmations,
    config.vrf.coordinatorCallbackGasLimit, config.vrf.consumerCallbackGasLimit
  ];
  await add("ChestRandomness", "MattMineVRFV25Adapter", randomnessArgs);
  await add("PassiveRandomness", "MattMineVRFV25Adapter", randomnessArgs);
  await add("Loadout", "MattV2Loadout", [
    config.roles.rootAdmin, planned.Miner, planned.Equipment, config.protocol.mattToken,
    config.roles.treasury, config.economy.repairPriceMattWei
  ]);
  await add("CrystalBankImplementation", "MattV2CrystalBank", [planned.UpgradeTimelock]);
  const bankFactory = await ethers.getContractFactory("MattV2CrystalBank");
  const bankInit = bankFactory.interface.encodeFunctionData("initialize", [
    config.roles.rootAdmin, config.roles.emergencyPauser, config.roles.rootAdmin,
    config.roles.rootAdmin, config.protocol.crystalToken
  ]);
  await add("CrystalBankProxy", "MattV2ERC1967Proxy", [planned.CrystalBankImplementation, bankInit]);
  await add("PassiveRewardsImplementation", "MattV2PassiveRewards", [planned.UpgradeTimelock]);
  const passiveFactory = await ethers.getContractFactory("MattV2PassiveRewards");
  const passiveInit = passiveFactory.interface.encodeFunctionData("initialize", [
    config.roles.rootAdmin, config.roles.emergencyPauser, config.roles.rootAdmin,
    config.roles.keeper, planned.Miner, config.protocol.crystalToken, planned.PassiveRandomness
  ]);
  await add("PassiveRewardsProxy", "MattV2ERC1967Proxy", [planned.PassiveRewardsImplementation, passiveInit]);
  await add("GameSettlementImplementation", "MattV2GameSettlement", [planned.UpgradeTimelock]);
  const settlementFactory = await ethers.getContractFactory("MattV2GameSettlement");
  const settlementInit = settlementFactory.interface.encodeFunctionData("initialize", [
    config.roles.rootAdmin, config.roles.emergencyPauser, config.roles.gameOperator,
    config.roles.rootAdmin, config.roles.rewardSigner, planned.Miner, planned.Loadout,
    planned.CrystalBankProxy, planned.PassiveRewardsProxy
  ]);
  await add("GameSettlementProxy", "MattV2ERC1967Proxy", [planned.GameSettlementImplementation, settlementInit]);
  await add("ChestImplementation", "MattV2Chest", [planned.UpgradeTimelock]);
  const chestFactory = await ethers.getContractFactory("MattV2Chest");
  const chestInit = chestFactory.interface.encodeFunctionData("initialize", [
    config.roles.rootAdmin, config.roles.emergencyPauser, config.roles.rootAdmin,
    config.protocol.mattToken, planned.Equipment, planned.ChestRandomness, config.roles.treasury
  ]);
  await add("ChestProxy", "MattV2ERC1967Proxy", [planned.ChestImplementation, chestInit]);
  return { steps, planned, endingNonce: nonce };
}
