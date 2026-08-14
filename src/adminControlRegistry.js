export const RETENTION_CONTROL_LINKS = Object.freeze([
  Object.freeze({
    id: 'knockout-retention-practice',
    label: 'Practice knockout retention',
    lobby: 'practice',
    expansionKey: 'deathRetentionPractice'
  }),
  Object.freeze({
    id: 'knockout-retention-free',
    label: 'Free ranked knockout retention',
    lobby: 'free',
    expansionKey: 'deathRetentionFree'
  }),
  Object.freeze({
    id: 'knockout-retention-paid',
    label: 'Pass ranked knockout retention',
    lobby: 'paid',
    expansionKey: 'deathRetentionPaid'
  })
]);

export const CHARACTER_PRICE_CONTROL_LINKS = Object.freeze([
  Object.freeze({ id: 'character-price-ronke', label: 'Ronke nugget price', characterId: 'ronke', economyKey: 'ronke' }),
  Object.freeze({ id: 'character-price-adl-dyno', label: 'ADL Dyno nugget price', characterId: 'adl-dyno', economyKey: 'adlDyno' }),
  Object.freeze({ id: 'character-price-axie', label: 'Axie nugget price', characterId: 'axie', economyKey: 'axie' }),
  Object.freeze({ id: 'character-price-orc', label: 'Orc nugget price', characterId: 'orc', economyKey: 'orc' })
]);

export const LINKED_ADMIN_CONTROL_GROUPS = Object.freeze([
  ...RETENTION_CONTROL_LINKS.map((link) => Object.freeze({
    id: link.id,
    label: link.label,
    canonical: `expansion.settings.${link.expansionKey}`,
    mirrors: Object.freeze([`gameTuning.${link.lobby}.deathKeepFraction`])
  })),
  Object.freeze({
    id: 'advertisement-rewards-enabled',
    label: 'Advertisement rewards enabled',
    canonical: 'expansion.settings.advertisementRewardsEnabled',
    mirrors: Object.freeze(['nuggetEconomy.config.advertisementRewardsEnabled'])
  }),
  ...CHARACTER_PRICE_CONTROL_LINKS.map((link) => Object.freeze({
    id: link.id,
    label: link.label,
    canonical: `expansion.characters.${link.characterId}.nuggetPrice`,
    mirrors: Object.freeze([`nuggetEconomy.config.characterUnlockPrices.${link.economyKey}`])
  }))
]);

const STATIC_CONTROLS = Object.freeze([
  entry('overview', 'overview', 'Live readiness monitors', 'System status, deployment health, verifier gates, and linked-control consistency.', 'Status'),
  entry('studio', 'studio:maps', 'Competition Studio map builder', 'Build exact room layouts, connections, enemy spawns, loot, objectives, and hazards for every playable mine.', 'Competition Studio'),
  entry('studio', 'studio:loadout', 'Competition loadouts', 'Choose the character, starting weapons, health, ammo, drones, upgrades, and attempt rules for a mine.', 'Competition Studio'),
  entry('studio', 'studio:schedule', 'Competition schedule', 'Publish an immutable server-owned mine snapshot for a future start and end time.', 'Competition Studio'),
  entry('studio', 'studio:versions', 'Competition versions', 'Inspect active and scheduled map snapshots without changing competitions already in progress.', 'Competition Studio'),
  entry('operations', 'operations:maintenance', 'Maintenance mode', 'Immediately stop new production play while preserving stored data.', 'Live operations'),
  entry('operations', 'operations:free-ranked', 'Free ranked pause', 'Pause or resume Free ranked entry.', 'Live operations'),
  entry('operations', 'operations:pass-ranked', 'Pass ranked pause', 'Pause or resume Pass ranked entry.', 'Live operations'),
  entry('operations', 'operations:purchases', 'Purchase confirmation pause', 'Emergency gate for verified purchase confirmation.', 'Live operations'),
  entry('operations', 'operations:claims', 'Reward claims pause', 'Emergency gate for MATT reward claims.', 'Live operations'),
  entry('operations', 'operations:mine-practice', 'Practice Mine operations', 'Pause Practice entries or result handling while its Admin-authored maps and balance remain public and rewardless.', 'Mine Operations'),
  entry('operations', 'operations:mine-arena', 'MATT Arena operations', 'Pause Arena entries, result submission, payments, or rewards independently.', 'Mine Operations'),
  entry('operations', 'operations:mine-daily', 'Daily Mine operations', 'Pause Daily Mine entries, result submission, payments, or rewards independently.', 'Mine Operations'),
  entry('operations', 'operations:mine-pass', 'Pass Mine operations', 'Pause Pass Mine entries, result submission, payments, or rewards independently.', 'Mine Operations'),
  entry('operations', 'operations:mine-weekly', 'Seven-Day Mine operations', 'Pause Seven-Day Mine entries, result submission, payments, or rewards independently.', 'Mine Operations'),
  entry('players', 'players:search', 'Player and wallet search', 'Find permanent miner names, wallets, activity, balances, and moderation controls.', 'Players'),
  entry('players', 'players:suspension', 'Player suspension', 'Suspend or restore a wallet with a required audit reason.', 'Players'),
  entry('players', 'players:sessions', 'Player session control', 'Sign a wallet out of every active server session.', 'Players'),
  entry('players', 'players:runs', 'Player active run control', 'Expire a wallet’s active runs without editing finished results.', 'Players'),
  entry('players', 'players:free-run', 'Restore daily free run', 'Restore today’s Free ranked entitlement for one audited wallet.', 'Players'),
  entry('players', 'players:award', 'Player award', 'Grant audited nuggets, Pass XP, chests, or a cosmetic to one wallet.', 'Players'),
  entry('nugget-economy', 'economy:purchases', 'Nugget purchases', 'Enable exact verified MATT or RON nugget packages.', 'Nugget economy'),
  entry('nugget-economy', 'economy:advertisements', 'Advertisement rewards', 'Enable or pause verified advertisement nugget rewards.', 'Nugget economy'),
  entry('nugget-economy', 'economy:matt-payments', 'Accept MATT payments', 'Allow verified MATT payments for enabled nugget packages.', 'Nugget economy'),
  entry('nugget-economy', 'economy:ron-payments', 'Accept RON payments', 'Allow verified RON payments for enabled nugget packages.', 'Nugget economy'),
  entry('nugget-economy', 'economy:conversion', 'Nugget conversion', 'Canonical nuggets-per-MATT value and displayed reference.', 'Nugget economy'),
  entry('nugget-economy', 'economy:daily-cap', 'UTC daily purchase cap', 'Maximum verified nuggets one wallet may purchase in a UTC day.', 'Nugget economy'),
  entry('nugget-economy', 'economy:quote-lifetime', 'Payment quote lifetime', 'How long an exact verified purchase quote remains valid.', 'Nugget economy'),
  entry('nugget-economy', 'economy:recipient', 'Approved payment recipient', 'Canonical Ronin recipient allowed by the receipt verifier.', 'Nugget economy'),
  entry('nugget-economy', 'economy:packages', 'Purchase packages', 'Add, price, enable, and remove verified nugget packages.', 'Nugget economy'),
  entry('nugget-economy', 'economy:character-prices', 'Character unlock prices', 'Permanent nugget prices linked to the playable roster.', 'Nugget economy'),
  entry('operations', 'rewards:create', 'Create weekly MATT reward obligation', 'Build an immutable Free or Pass payout obligation from a finalized week.', 'Mine Operations · Payout Desk'),
  entry('operations', 'rewards:approve', 'Approve MATT reward obligation', 'Independent review and Safe JSON preparation before publication.', 'Mine Operations · Payout Desk'),
  entry('operations', 'rewards:publish', 'Publish MATT reward epoch', 'Fund and publish the approved Merkle root through the Treasury Safe.', 'Mine Operations · Payout Desk'),
  entry('operations', 'rewards:sync', 'Synchronize MATT reward transaction', 'Confirm the exact onchain epoch after the Safe transaction is mined.', 'Mine Operations · Payout Desk'),
  entry('operations', 'rewards:unpaid', 'Unpaid MATT reward obligations', 'Track every wallet, amount owed, claim status, and outstanding MATT total.', 'Mine Operations · Payout Desk'),
  entry('arena', 'arena:schedule', 'Daily Arena schedule', 'Schedule entry prices, Treasury seed, settlement, and cancellation Safe files.', 'Daily Arena'),
  entry('arena', 'arena:entry-price', 'Daily Arena entry price', 'Set the future UTC day entry fee from 25,000 to 1,000,000 MATT.', 'Daily Arena'),
  entry('arena', 'arena:seed', 'Daily Arena Treasury seed', 'Prepare initial or top-up prize funding up to the daily contract cap.', 'Daily Arena'),
  entry('arena', 'arena:settlement', 'Daily Arena settlement', 'Prepare the full-pool settlement Safe file for verified winners.', 'Daily Arena'),
  entry('arena', 'arena:cancellation', 'Daily Arena cancellation', 'Prepare an atomic cancellation and player refund Safe file.', 'Daily Arena'),
  entry('arena', 'arena:emergency', 'Daily Arena emergency controls', 'Prepare entry and settlement pause calldata.', 'Daily Arena'),
  entry('contracts', 'contracts:transactions', 'Onchain transaction builder', 'Prepare reviewed Ronin contract calldata and Safe JSON.', 'Chain'),
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
      `Modes & Characters · ${definition.category}`
    ),
    search: definition.label
  }));
  const roster = Object.entries(characters).flatMap(([characterId, character]) =>
    Object.keys(character || {}).map((field) => ({
      ...entry(
        'expansion',
        `character:${characterId}:${field}`,
        `${character.name || words(characterId)} · ${words(field)}`,
        `Playable roster setting for ${character.name || words(characterId)}.`,
        'Modes & Characters · Playable roster'
      ),
      search: character.name || words(characterId)
    }))
  );
  return [...STATIC_CONTROLS, ...tuning, ...expansion, ...roster]
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
  return link ? { id: link.id, label: link.label, linkedTo: 'Modes & Characters' } : null;
}

export function linkedControlForExpansion(settingId) {
  const retention = RETENTION_CONTROL_LINKS.find((entry) => entry.expansionKey === settingId);
  if (retention) return { id: retention.id, label: retention.label, linkedTo: 'Game Balance' };
  if (settingId === 'advertisementRewardsEnabled') {
    return { id: 'advertisement-rewards-enabled', label: 'Advertisement rewards enabled', linkedTo: 'Nugget Economy' };
  }
  return null;
}

export function linkedControlForCharacter(characterId, field) {
  if (field !== 'nuggetPrice') return null;
  const link = CHARACTER_PRICE_CONTROL_LINKS.find((entry) => entry.characterId === characterId);
  return link ? { id: link.id, label: link.label, linkedTo: 'Nugget Economy' } : null;
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
