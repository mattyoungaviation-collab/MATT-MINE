import { SITE_THEME_CONTROLS, SITE_THEME_GROUPS } from './game/siteTheme.js';

export const RETENTION_CONTROL_LINKS = Object.freeze([
  Object.freeze({
    id: 'knockout-retention-practice',
    label: 'Practice knockout retention',
    lobby: 'practice',
    expansionKey: 'deathRetentionPractice'
  }),
  Object.freeze({
    id: 'knockout-retention-free',
    label: 'Retired Free Mine knockout retention',
    lobby: 'free',
    expansionKey: 'deathRetentionFree',
    legacy: true
  }),
  Object.freeze({
    id: 'knockout-retention-paid',
    label: 'Pass ranked knockout retention',
    lobby: 'paid',
    expansionKey: 'deathRetentionPaid'
  })
]);

export const LINKED_ADMIN_CONTROL_GROUPS = Object.freeze([
  ...RETENTION_CONTROL_LINKS.map((link) => Object.freeze({
    id: link.id,
    label: link.label,
    canonical: `expansion.settings.${link.expansionKey}`,
    mirrors: Object.freeze([`gameTuning.${link.lobby}.deathKeepFraction`])
  }))
]);

const STATIC_CONTROLS = Object.freeze([
  entry('overview', 'overview', 'Live readiness monitors', 'System status, deployment health, verifier gates, and linked-control consistency.', 'Status'),
  entry('studio', 'studio:maps', 'Competition Studio map builder', 'Build exact room layouts, connections, enemy spawns, loot, objectives, and hazards for every playable mine.', 'Competition Studio'),
  entry('studio', 'studio:loadout', 'Competition loadouts', 'Choose the character, starting weapons, health, ammo, drones, upgrades, and attempt rules for a mine.', 'Competition Studio'),
  entry('studio', 'studio:schedule', 'Competition schedule', 'Publish an immutable server-owned mine snapshot for a future start and end time.', 'Competition Studio'),
  entry('studio', 'studio:versions', 'Competition versions', 'Inspect active and scheduled map snapshots without changing competitions already in progress.', 'Competition Studio'),
  entry('operations', 'operations:maintenance', 'Maintenance mode', 'Immediately stop new production play while preserving stored data.', 'Live operations'),
  entry('operations', 'operations:pass-ranked', 'Pass ranked pause', 'Pause or resume Pass ranked entry.', 'Live operations'),
  entry('operations', 'operations:purchases', 'Purchase confirmation pause', 'Emergency gate for verified purchase confirmation.', 'Live operations'),
  entry('operations', 'operations:claims', 'Reward claims pause', 'Emergency gate for MATT reward claims.', 'Live operations'),
  entry('operations', 'operations:mine-practice', 'Practice Mine operations', 'Pause Practice entries or result handling while its Admin-authored maps and balance remain public and rewardless.', 'Mine Operations'),
  entry('operations', 'operations:mine-arena', 'MATT Arena operations', 'Pause Arena entries, result submission, payments, or rewards independently.', 'Mine Operations'),
  entry('operations', 'operations:mine-pass', 'Pass Mine operations', 'Pause Pass Mine entries, result submission, payments, or rewards independently.', 'Mine Operations'),
  entry('players', 'players:search', 'Player and wallet search', 'Find permanent miner names, wallets, activity, balances, and moderation controls.', 'Players'),
  entry('players', 'players:suspension', 'Player suspension', 'Suspend or restore a wallet with a required audit reason.', 'Players'),
  entry('players', 'players:sessions', 'Player session control', 'Sign a wallet out of every active server session.', 'Players'),
  entry('players', 'players:runs', 'Player active run control', 'Expire a wallet’s active runs without editing finished results.', 'Players'),
  entry('players', 'players:award', 'Player award', 'Grant audited Pass XP, chests, or a cosmetic to one wallet.', 'Players'),
  entry('players', 'players:consumables', 'Player Consumables inventory', 'Inspect, grant, or remove wallet-owned Consumables with a required audit reason.', 'Players'),
  entry('consumables', 'consumables:economy', 'Consumables Economy', 'Adjust MATT CRYSTALS prices, availability, checkout limits, loadout size, and per-item run limits.', 'Consumables Economy'),
  entry('consumables', 'consumables:routing', 'Consumables Treasury routing', 'Inspect the locked 100% Treasury payment route and recent confirmed purchases.', 'Consumables Economy'),
  entry('operations', 'rewards:create', 'Create weekly MATT reward obligation', 'Build an immutable Pass payout obligation, or honor a historical retired-mine obligation.', 'Mine Operations · Payout Desk'),
  entry('operations', 'rewards:approve', 'Approve MATT reward obligation', 'Independent review and Safe JSON preparation before publication.', 'Mine Operations · Payout Desk'),
  entry('operations', 'rewards:publish', 'Publish MATT reward epoch', 'Fund and publish the approved Merkle root through the Treasury Safe.', 'Mine Operations · Payout Desk'),
  entry('operations', 'rewards:sync', 'Synchronize MATT reward transaction', 'Confirm the exact onchain epoch after the Safe transaction is mined.', 'Mine Operations · Payout Desk'),
  entry('operations', 'rewards:unpaid', 'Unpaid MATT reward obligations', 'Track every wallet, amount owed, claim status, and outstanding MATT total.', 'Mine Operations · Payout Desk'),
  entry('arena', 'arena:schedule', 'MATT Arena schedule', 'Schedule entry prices, Treasury seed, settlement, and cancellation Safe files.', 'MATT Arena'),
  entry('arena', 'arena:entry-price', 'MATT Arena entry price', 'Set the future UTC day entry fee from 25,000 to 1,000,000 MATT.', 'MATT Arena'),
  entry('arena', 'arena:seed', 'MATT Arena Treasury seed', 'Prepare initial or top-up prize funding up to the daily contract cap.', 'MATT Arena'),
  entry('arena', 'arena:settlement', 'MATT Arena settlement', 'Prepare the full-pool settlement Safe file for verified winners.', 'MATT Arena'),
  entry('arena', 'arena:cancellation', 'MATT Arena cancellation', 'Prepare an atomic cancellation and player refund Safe file.', 'MATT Arena'),
  entry('arena', 'arena:emergency', 'MATT Arena emergency controls', 'Prepare entry and settlement pause calldata.', 'MATT Arena'),
  entry('nft-v2', 'nft-v2:economy', 'NFT V2 economy controls', 'Set repair, withdrawal, and chest prices within the protocol safety limits.', 'NFT V2 Protocol'),
  entry('nft-v2', 'nft-v2:maps', 'NFT V2 map approval', 'Approve and route a Studio-published Arena or Pass Mine version with its onchain economy.', 'NFT V2 Protocol'),
  entry('nft-v2', 'nft-v2:phase-xp', 'NFT V2 phase XP', 'Configure the five phase XP awards for the active Arena or Pass Mine map.', 'NFT V2 Protocol'),
  entry('nft-v2', 'nft-v2:routes', 'NFT V2 active map economics', 'Inspect each active map version, content hash, crystal cap, conversion rate, payout cap, and force-abandon delay.', 'NFT V2 Protocol'),
  entry('contracts', 'contracts:transactions', 'Onchain transaction builder', 'Prepare reviewed Ronin contract calldata and Safe JSON.', 'Chain'),
  entry('theme', 'theme:presets', 'Theme Studio presets', 'Apply a curated MATT Mine visual system to a safe browser draft.', 'Theme Studio'),
  entry('theme', 'theme:preview', 'Full-site theme preview', 'Open the complete public site with this browser’s unpublished theme draft.', 'Theme Studio'),
  entry('theme', 'theme:publish', 'Publish live site theme', 'Apply a versioned, audited visual system to every public page.', 'Theme Studio'),
  entry('audit', 'audit:trail', 'Audit trail', 'Search every server-authoritative admin action and reason.', 'Audit')
]);

export function buildAdminControlIndex({ tuningSchema = [], expansionSchema = [], characters = {} } = {}) {
  const tuning = tuningSchema.map((definition) => ({
    ...entry(
      'tuning',
      `tuning:${definition.id}`,
      definition.label,
      definition.description || `${definition.category} game balance control.`,
      `Game Balance · ${definition.category}`
    ),
    search: definition.label
  }));
  const expansion = expansionSchema.map((definition) => ({
    ...entry(
      'expansion',
      `expansion:${definition.id}`,
      definition.label,
      definition.description || `${definition.category} feature control.`,
      `Features & Practice · ${definition.category}`
    ),
    search: definition.label
  }));
  const roster = Object.entries(characters).flatMap(([characterId, character]) =>
    Object.keys(character || {}).filter((field) => field !== 'passive').map((field) => ({
      ...entry(
        'expansion',
        `character:${characterId}:${field}`,
        `${character.name || words(characterId)} · ${words(field)}`,
        `Playable roster setting for ${character.name || words(characterId)}.`,
        'Features & Practice · Playable roster'
      ),
      search: character.name || words(characterId)
    }))
  );
  const theme = SITE_THEME_CONTROLS.map((definition) => {
    const group = SITE_THEME_GROUPS.find((candidate) => candidate.id === definition.group);
    return entry(
      'theme',
      `theme:${definition.id}`,
      definition.label,
      definition.description,
      `Theme Studio · ${group?.label || 'Design system'}`
    );
  });
  return [...STATIC_CONTROLS, ...theme, ...tuning, ...expansion, ...roster]
    .map((item, index) => Object.freeze({
      ...item,
      order: index,
      haystack: normalize(`${item.label} ${item.description} ${item.group} ${item.search || ''}`)
    }));
}

export function searchAdminControls(index, query, limit = 12) {
  const normalized = normalize(query);
  if (!normalized) return [];
  const tokens = normalized.split(' ').filter(Boolean);
  return index
    .flatMap((item) => {
      if (!tokens.every((token) => item.haystack.includes(token))) return [];
      const label = normalize(item.label);
      const score =
        (label === normalized ? 100 : 0) +
        (label.startsWith(normalized) ? 40 : 0) +
        (label.includes(normalized) ? 20 : 0) +
        tokens.reduce((sum, token) => sum + (label.includes(token) ? 4 : 1), 0);
      return [{ ...item, score }];
    })
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, Math.max(1, limit));
}

export function linkedControlForTuning(lobby, settingId) {
  if (settingId !== 'deathKeepFraction') return null;
  const link = RETENTION_CONTROL_LINKS.find((entry) => entry.lobby === lobby);
  return link ? { id: link.id, label: link.label, linkedTo: 'Features & Practice' } : null;
}

export function linkedControlForExpansion(settingId) {
  const retention = RETENTION_CONTROL_LINKS.find((entry) => entry.expansionKey === settingId);
  if (retention) return { id: retention.id, label: retention.label, linkedTo: 'Game Balance' };
  return null;
}

export function linkedControlForCharacter(characterId, field) {
  return null;
}

function entry(tab, id, label, description, group) {
  return { tab, id, label, description, group };
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function words(value) {
  return String(value || '')
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
