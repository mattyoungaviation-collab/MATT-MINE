import { createHash } from 'node:crypto';

export async function persistEndlessConfig(client, record, active = false) {
  if (!record?.version || !record.config) return false;
  if (active) {
    await client.query('UPDATE matt_mine_endless.config_versions SET active=FALSE WHERE active=TRUE');
  }
  const configJson = stableJson(record.config);
  await client.query(
    `INSERT INTO matt_mine_endless.config_versions
     (config_version,active,content_hash,config,published_at_ms,published_by,reason)
     VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)
     ON CONFLICT(config_version) DO UPDATE SET
       active=EXCLUDED.active,content_hash=EXCLUDED.content_hash,config=EXCLUDED.config,
       published_at_ms=EXCLUDED.published_at_ms,published_by=EXCLUDED.published_by,reason=EXCLUDED.reason`,
    [record.version, active, sha256(configJson), configJson, record.publishedAt || 0,
      record.publishedBy || 'SYSTEM', record.reason || '']
  );
  return true;
}

export async function persistEndlessRun(client, run) {
  if (!run?.id || run.mode !== 'endless') return false;
  const paymentHash = transactionHash(run.payment?.transactionHash) || null;
  await client.query(
    `INSERT INTO matt_mine_endless.runs
     (run_id,address,miner_id,status,verification_status,config_version,token_hash,run_seed,
      current_phase,completed_phases,score,crystals_carried,crystals_banked,miner_xp_banked,
      integrity_score,rolling_digest,payment_transaction_hash,started_at_ms,phase_started_at_ms,
      updated_at_ms,expires_at_ms,finished_at_ms,run_payload)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb)
     ON CONFLICT(run_id) DO UPDATE SET
       status=EXCLUDED.status,verification_status=EXCLUDED.verification_status,
       current_phase=EXCLUDED.current_phase,completed_phases=EXCLUDED.completed_phases,
       score=EXCLUDED.score,crystals_carried=EXCLUDED.crystals_carried,
       crystals_banked=EXCLUDED.crystals_banked,miner_xp_banked=EXCLUDED.miner_xp_banked,
       integrity_score=EXCLUDED.integrity_score,rolling_digest=EXCLUDED.rolling_digest,
       phase_started_at_ms=EXCLUDED.phase_started_at_ms,updated_at_ms=EXCLUDED.updated_at_ms,
       expires_at_ms=EXCLUDED.expires_at_ms,finished_at_ms=EXCLUDED.finished_at_ms,
       run_payload=EXCLUDED.run_payload`,
    [run.id, String(run.address || '').toLowerCase(), number(run.minerId), runStatus(run.status),
      verificationStatus(run.status), number(run.configVersion), run.tokenHash || '', run.runSeed || '',
      number(run.currentPhase), number(run.completedPhases), number(run.score),
      number(run.crystalsCarried), numeric(run.crystalsBanked), number(run.minerXpBanked),
      bounded(number(run.integrityScore, 100), 0, 100), run.rollingDigest || '', paymentHash,
      number(run.startedAt), number(run.phaseStartedAt), number(run.updatedAt), number(run.expiresAt),
      run.finishedAt ? number(run.finishedAt) : null, JSON.stringify(run)]
  );
  await persistEndlessIntegrityEvents(client, run);
  await persistEndlessSettlementTransactions(client, run);
  return true;
}

export async function persistEndlessCheckpoint(client, run, verification) {
  if (!run?.id || !verification?.phase || !verification.digest) return false;
  await client.query(
    `INSERT INTO matt_mine_endless.phase_checkpoints
     (run_id,phase,phase_attempt,checkpoint_sequence,manifest_fingerprint,phase_seed,
      previous_digest,digest,verification_status,score,crystals_earned,crystals_carried,
      miner_xp,phase_started_at_ms,phase_completed_at_ms,checkpoint_payload)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'verified',$9,$10,$11,$12,$13,$14,$15::jsonb)
     ON CONFLICT(run_id,phase) DO NOTHING`,
    [run.id, number(verification.phase), number(verification.integrityState?.phaseAttempt, 1),
      number(verification.checkpointSequence || verification.phase), verification.manifestFingerprint || '', verification.phaseSeed || '',
      verification.previousCheckpoint || '', verification.digest, number(verification.score),
      numeric(verification.grossCrystalsEarned), number(verification.crystalsCarried),
      number(verification.minerXp), number(verification.phaseStartedAt),
      number(verification.phaseCompletedAt || verification.verifiedAt), JSON.stringify(verification)]
  );
  return true;
}

export async function persistEndlessPayment(client, run, paymentRecord = null) {
  const payment = run?.payment;
  const hash = transactionHash(payment?.transactionHash);
  if (!hash) return false;
  await client.query(
    `INSERT INTO matt_mine_endless.entry_payments
     (transaction_hash,run_id,address,recipient,config_version,amount_raw,block_number,
      confirmations,confirmed_at_ms,consumed_at_ms,payment_payload)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
     ON CONFLICT(transaction_hash) DO UPDATE SET payment_payload=EXCLUDED.payment_payload`,
    [hash, run.id, payment.payer || run.address, payment.recipient, number(run.configVersion),
      numeric(payment.amountRaw), numeric(payment.blockNumber), number(payment.confirmations),
      number(payment.transactionBlockAt), number(paymentRecord?.consumedAt || run.startedAt),
      JSON.stringify(paymentRecord || payment)]
  );
  return true;
}

export async function persistEndlessLeaderboardEntry(client, entry, run = null) {
  if (!entry?.runId) return false;
  await client.query(
    `INSERT INTO matt_mine_endless.leaderboard_entries
     (run_id,address,miner_id,config_version,verification_status,deepest_phase,score,
      crystals_banked,survival_ms,finished_at_ms)
     VALUES($1,$2,$3,$4,'verified',$5,$6,$7,$8,$9)
     ON CONFLICT(run_id) DO UPDATE SET
       verification_status=EXCLUDED.verification_status,deepest_phase=EXCLUDED.deepest_phase,
       score=EXCLUDED.score,crystals_banked=EXCLUDED.crystals_banked,
       survival_ms=EXCLUDED.survival_ms,finished_at_ms=EXCLUDED.finished_at_ms`,
    [entry.runId, entry.address, number(entry.minerId || run?.minerId),
      number(entry.configVersion || run?.configVersion), number(entry.deepestPhase),
      number(entry.score), numeric(entry.crystalsBanked), number(entry.survivalMs),
      number(entry.finishedAt)]
  );
  return true;
}

export async function backfillEndlessState(client, store = {}) {
  const versions = Object.values(store.configVersions || {}).sort((left, right) => left.version - right.version);
  for (const record of versions) {
    await persistEndlessConfig(client, record, record.version === store.activeConfigVersion);
  }
  for (const run of Object.values(store.runs || {})) {
    await persistEndlessRun(client, run);
    const paymentRecord = store.paymentTransactions?.[String(run.payment?.transactionHash || '').toLowerCase()];
    await persistEndlessPayment(client, run, paymentRecord);
    for (const verification of run.phaseHistory || []) {
      await persistEndlessCheckpoint(client, run, verification);
    }
  }
  for (const entry of store.leaderboardEntries || []) {
    await persistEndlessLeaderboardEntry(client, entry, store.runs?.[entry.runId]);
  }
  await client.query(
    `UPDATE matt_mine_endless.projection_state
     SET legacy_backfill_complete=TRUE,last_backfill_at=NOW(),updated_at=NOW()
     WHERE singleton=TRUE`
  );
}

export async function backfillEndlessStateOnce(client, store = {}) {
  const selected = await client.query(
    `SELECT legacy_backfill_complete FROM matt_mine_endless.projection_state
     WHERE singleton=TRUE FOR UPDATE`
  );
  if (selected.rows[0]?.legacy_backfill_complete === true) return false;
  await backfillEndlessState(client, store);
  return true;
}

export async function validateEndlessState(client, store = {}) {
  const [configs, runs, phases, payments, leaderboard] = await Promise.all([
    client.query('SELECT COUNT(*)::integer AS count FROM matt_mine_endless.config_versions'),
    client.query('SELECT COUNT(*)::integer AS count FROM matt_mine_endless.runs'),
    client.query('SELECT COUNT(*)::integer AS count FROM matt_mine_endless.phase_checkpoints'),
    client.query('SELECT COUNT(*)::integer AS count FROM matt_mine_endless.entry_payments'),
    client.query('SELECT COUNT(*)::integer AS count FROM matt_mine_endless.leaderboard_entries')
  ]);
  const legacy = {
    configs: Object.keys(store.configVersions || {}).length,
    runs: Object.keys(store.runs || {}).length,
    hotPhases: Object.values(store.runs || {}).reduce(
      (total, run) => total + (Array.isArray(run.phaseHistory) ? run.phaseHistory.length : 0),
      0
    ),
    payments: Object.keys(store.paymentTransactions || {}).length,
    leaderboard: Array.isArray(store.leaderboardEntries) ? store.leaderboardEntries.length : 0
  };
  const durable = {
    configs: count(configs),
    runs: count(runs),
    phases: count(phases),
    payments: count(payments),
    leaderboard: count(leaderboard)
  };
  const discrepancies = [];
  for (const key of ['configs', 'runs', 'payments', 'leaderboard']) {
    if (durable[key] < legacy[key]) discrepancies.push(`${key}: durable ${durable[key]} < compatibility ${legacy[key]}`);
  }
  if (durable.phases < legacy.hotPhases) {
    discrepancies.push(`phases: durable ${durable.phases} < hot compatibility tail ${legacy.hotPhases}`);
  }
  return { ok: discrepancies.length === 0, legacy, durable, discrepancies };
}

async function persistEndlessIntegrityEvents(client, run) {
  for (const event of run.integrityFlags || []) {
    const eventId = sha256(`${run.id}|${event.code || 'unknown'}|${event.phase || 0}|${event.timestamp || 0}|${stableJson(event)}`);
    await client.query(
      `INSERT INTO matt_mine_endless.integrity_events
       (event_id,run_id,phase,code,integrity_score,created_at_ms,event_payload)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(event_id) DO NOTHING`,
      [eventId, run.id, number(event.phase), String(event.code || 'unknown').slice(0, 100),
        bounded(number(run.integrityScore, 100), 0, 100), number(event.timestamp), JSON.stringify(event)]
    );
  }
}

async function persistEndlessSettlementTransactions(client, run) {
  for (const item of run.chainTransactions || []) {
    const hash = transactionHash(item.hash);
    if (!hash) continue;
    await client.query(
      `INSERT INTO matt_mine_endless.settlement_transactions
       (transaction_hash,run_id,phase,transaction_type,recorded_at_ms)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT(transaction_hash) DO NOTHING`,
      [hash, run.id, number(item.phase), String(item.type || 'unknown').slice(0, 100), number(item.recordedAt)]
    );
  }
}

function runStatus(value) {
  return ['active', 'banked', 'knocked_out', 'abandoned', 'rejected', 'pending_review', 'expired'].includes(value)
    ? value
    : 'expired';
}

function verificationStatus(status) {
  return ({
    active: 'active', banked: 'banked', knocked_out: 'completed', abandoned: 'abandoned',
    rejected: 'rejected', pending_review: 'pending_review', expired: 'disconnected'
  })[status] || 'rejected';
}

function transactionHash(value) {
  const normalized = String(value || '').toLowerCase();
  return /^0x[a-f0-9]{64}$/.test(normalized) ? normalized : '';
}

function numeric(value) {
  const normalized = String(value ?? '0');
  return /^\d+$/.test(normalized) ? normalized : '0';
}

function number(value, fallback = 0) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : fallback;
}

function count(result) {
  return Number(result.rows[0]?.count || 0);
}

function bounded(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}
