import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsRoot = resolve(projectRoot, 'migrations');

export async function runNormalizedMigrations(pool) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [20200731]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS matt_mine_normalized;
      CREATE TABLE IF NOT EXISTS matt_mine_normalized.schema_migrations (
        version TEXT PRIMARY KEY, checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    const files = (await readdir(migrationsRoot))
      .filter((name) => /^\d+_[a-z0-9_]+\.up\.sql$/.test(name))
      .sort();
    for (const file of files) {
      const sql = await readFile(resolve(migrationsRoot, file), 'utf8');
      const version = file.split('_', 1)[0];
      const checksum = sha256(sql);
      const existing = await client.query(
        'SELECT checksum FROM matt_mine_normalized.schema_migrations WHERE version=$1',
        [version]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`Migration ${version} checksum changed after application.`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO matt_mine_normalized.schema_migrations(version,checksum) VALUES($1,$2)',
          [version, checksum]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [20200731]).catch(() => undefined);
    client.release();
  }
}

export async function backfillNormalizedState(client, state, options = {}) {
  const timestamp = Number(options.timestamp || Date.now());
  for (const [address, wallet] of Object.entries(state.wallets || {})) {
    await client.query(
      `INSERT INTO matt_mine_normalized.wallets(address,suspended,created_at_ms,updated_at_ms,legacy_payload)
       VALUES($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT(address) DO UPDATE SET suspended=EXCLUDED.suspended,
         created_at_ms=EXCLUDED.created_at_ms,updated_at_ms=EXCLUDED.updated_at_ms,
         legacy_payload=EXCLUDED.legacy_payload`,
      [address, wallet.suspended === true, wallet.createdAt || 0, wallet.updatedAt || 0, JSON.stringify(withoutAvatar(wallet))]
    );
    if (wallet.identity?.name) {
      await client.query(
        `INSERT INTO matt_mine_normalized.player_identities(address,username,updated_at_ms)
         VALUES($1,$2,$3) ON CONFLICT(address) DO UPDATE SET
         username=EXCLUDED.username,updated_at_ms=EXCLUDED.updated_at_ms`,
        [address, wallet.identity.name, wallet.updatedAt || 0]
      );
    }
    if (wallet.identity?.avatarDataUrl) {
      const avatar = parseAvatar(wallet.identity.avatarDataUrl);
      if (avatar) await client.query(
        `INSERT INTO matt_mine_normalized.avatars(address,mime_type,content,content_hash,updated_at_ms)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT(address) DO UPDATE SET
         mime_type=EXCLUDED.mime_type,content=EXCLUDED.content,
         content_hash=EXCLUDED.content_hash,updated_at_ms=EXCLUDED.updated_at_ms`,
        [address, avatar.mime, avatar.content, sha256(avatar.content), wallet.identity.avatarUpdatedAt || 0]
      );
    }
    const ledger = Array.isArray(wallet.nuggetLedger) ? wallet.nuggetLedger : [];
    for (let index = 0; index < ledger.length; index += 1) {
      const entry = ledger[index];
      const amount = Math.abs(Number(entry.amount || 0));
      if (!entry.id || !amount) continue;
      await client.query(
        `INSERT INTO matt_mine_normalized.nugget_ledger
         (entry_id,address,sequence,idempotency_key,transaction_hash,amount,balance_after,entry_type,run_id,created_at_ms,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
         ON CONFLICT(entry_id) DO NOTHING`,
        [entry.id, address, index + 1, entry.idempotencyKey || `legacy:${address}:${entry.id}`,
          entry.transactionHash || null, entry.direction === 'debit' ? -amount : amount,
          Math.max(0, Number(entry.newBalance || 0)), entry.type || 'legacy', entry.runId || null,
          entry.timestamp || 0, JSON.stringify(entry)]
      );
    }
    await client.query(
      `INSERT INTO matt_mine_normalized.nugget_balances(address,balance,ledger_sequence,updated_at_ms)
       VALUES($1,$2,$3,$4) ON CONFLICT(address) DO UPDATE SET
       balance=EXCLUDED.balance,ledger_sequence=EXCLUDED.ledger_sequence,updated_at_ms=EXCLUDED.updated_at_ms`,
      [address, Math.max(0, Number(wallet.profile?.bankedNuggets || 0)), ledger.length, wallet.updatedAt || 0]
    );
    for (const claim of Object.values(wallet.practiceClaims || {})) {
      await client.query(
        `INSERT INTO matt_mine_normalized.practice_claims
         (run_id,address,status,transaction_hash,quote_id,projected_nuggets,created_at_ms,expires_at_ms,settled_at_ms,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
         ON CONFLICT(run_id) DO UPDATE SET status=EXCLUDED.status,
         transaction_hash=EXCLUDED.transaction_hash,quote_id=EXCLUDED.quote_id,
         settled_at_ms=EXCLUDED.settled_at_ms,payload=EXCLUDED.payload`,
        [claim.runId, address, claim.status, claim.transactionHash || null, claim.quoteId || null,
          claim.projectedNuggets || 0, claim.createdAt || 0, claim.expiresAt || 0,
          claim.settledAt || null, JSON.stringify(claim)]
      );
    }
    for (const activity of wallet.activity || []) {
      if (!activity.id) continue;
      await client.query(
        `INSERT INTO matt_mine_normalized.activity_entries(activity_id,address,action,details,created_at_ms)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT(activity_id) DO NOTHING`,
        [activity.id, address, activity.action || 'UNKNOWN', activity.details || '', activity.timestamp || 0]
      );
    }
  }
  for (const session of Object.values(state.sessions || {})) {
    if (!state.wallets?.[session.address]) continue;
    const tokenHash = String(session.tokenHash || session.id || '');
    if (!tokenHash) continue;
    await client.query(
      `INSERT INTO matt_mine_normalized.wallet_sessions
       (token_hash,address,session_type,csrf_hash,created_at_ms,expires_at_ms,revoked_at_ms,last_seen_at_ms)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(token_hash) DO UPDATE SET
       expires_at_ms=EXCLUDED.expires_at_ms,revoked_at_ms=EXCLUDED.revoked_at_ms,last_seen_at_ms=EXCLUDED.last_seen_at_ms`,
      [tokenHash, session.address, session.type || 'player', session.csrfHash || null,
        session.createdAt || 0, session.expiresAt || 0, session.revokedAt || null, session.lastSeenAt || 0]
    );
  }
  for (const challenge of Object.values(state.challenges || {})) {
    await client.query(
      `INSERT INTO matt_mine_normalized.authentication_challenges
       (nonce,address,chain_id,origin,message,purpose,created_at_ms,expires_at_ms,consumed_at_ms)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(nonce) DO UPDATE SET consumed_at_ms=EXCLUDED.consumed_at_ms`,
      [challenge.nonce, challenge.address, challenge.chainId || 2020, challenge.origin || '', challenge.message || '',
        challenge.purpose || 'player_login', challenge.createdAt || 0, challenge.expiresAt || 0, challenge.consumedAt || null]
    );
  }
  for (const run of Object.values(state.runs || {})) await upsertRun(client, run);
  for (const [hash, revive] of Object.entries(state.revivePayments || {})) {
    if (!state.wallets?.[revive.address]) continue;
    const run = state.runs?.[revive.runId];
    await client.query(
      `INSERT INTO matt_mine_normalized.paid_revives
       (transaction_hash,address,run_id,quote_id,amount_wei,transaction_block_at_ms,authoritative_checkpoint,completed_response,confirmed_at_ms,resumed_at_ms)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)
       ON CONFLICT(transaction_hash) DO NOTHING`,
      [hash, revive.address, revive.runId, revive.quoteId || run?.pendingRevive?.id || `legacy:${revive.runId}`,
        revive.amountWei || '1', revive.transactionBlockAt || revive.confirmedAt || 0,
        JSON.stringify(revive.authoritativeCheckpoint || run?.playerState || {}),
        JSON.stringify(revive.completedResponse || revive), revive.confirmedAt || 0, revive.resumedAt || null]
    );
  }
  for (const purchase of Object.values(state.passPurchases || {})) {
    if (!state.wallets?.[purchase.address]) continue;
    await client.query(
      `INSERT INTO matt_mine_normalized.pass_purchases(payment_key,address,transaction_hash,log_index,confirmed_at_ms,payload)
       VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(payment_key) DO NOTHING`,
      [purchase.key, purchase.address, purchase.transactionHash, purchase.logIndex || 0, purchase.confirmedAt || 0, JSON.stringify(purchase)]
    );
  }
  for (const entitlement of Object.values(state.paidEntitlements || {})) {
    if (!state.wallets?.[entitlement.address]) continue;
    await client.query(
      `INSERT INTO matt_mine_normalized.entitlements
       (entitlement_key,address,kind,transaction_hash,log_index,consumed_run_id,payload)
       VALUES($1,$2,'paid_run',$3,$4,$5,$6::jsonb) ON CONFLICT(entitlement_key) DO NOTHING`,
      [entitlement.key, entitlement.address, entitlement.transactionHash, entitlement.logIndex || 0,
        entitlement.usedRunId || null, JSON.stringify(entitlement)]
    );
  }
  for (const [mine, controls] of Object.entries(state.operations?.mines || {})) {
    await client.query(
      `INSERT INTO matt_mine_normalized.mine_operations(mine,controls,updated_at_ms,updated_by)
       VALUES($1,$2::jsonb,$3,$4) ON CONFLICT(mine) DO UPDATE SET
       controls=EXCLUDED.controls,updated_at_ms=EXCLUDED.updated_at_ms,updated_by=EXCLUDED.updated_by`,
      [mine, JSON.stringify(controls), controls.updatedAt || 0, controls.updatedBy || 'SYSTEM']
    );
  }
  for (const [lobby, tuning] of Object.entries(state.gameTuning || {})) {
    if (!tuning || typeof tuning !== 'object') continue;
    const contentHash = sha256(stableJson(tuning));
    await client.query(
      `INSERT INTO matt_mine_normalized.tuning_versions(version_id,lobby,content_hash,tuning,created_at_ms,created_by)
       VALUES($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT(lobby,content_hash) DO NOTHING`,
      [`${lobby}:${contentHash}`, lobby, contentHash, JSON.stringify(tuning), timestamp, 'DUAL_WRITE']
    );
  }
  for (const [slotId, slot] of Object.entries(state.competitionStudio?.slots || {})) {
    const contentHash = sha256(stableJson(slot.draft || {}));
    await client.query(
      `INSERT INTO matt_mine_normalized.competition_studio_drafts(slot_id,draft,content_hash,updated_at_ms,updated_by)
       VALUES($1,$2::jsonb,$3,$4,$5) ON CONFLICT(slot_id) DO UPDATE SET
       draft=EXCLUDED.draft,content_hash=EXCLUDED.content_hash,updated_at_ms=EXCLUDED.updated_at_ms,updated_by=EXCLUDED.updated_by`,
      [slotId, JSON.stringify(slot.draft || {}), contentHash, slot.updatedAt || 0, 'DUAL_WRITE']
    );
  }
  for (const snapshot of Object.values(state.competitionStudio?.snapshots || {})) {
    const contentHash = snapshot.fingerprint || sha256(stableJson(snapshot));
    await client.query(
      `INSERT INTO matt_mine_normalized.competition_published_snapshots
       (snapshot_id,slot_id,content_hash,effective_at_ms,expires_at_ms,snapshot,published_at_ms,published_by)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT(snapshot_id) DO NOTHING`,
      [snapshot.id, snapshot.slotId, contentHash, snapshot.effectiveAt || 0, snapshot.expiresAt || null,
        JSON.stringify(snapshot), snapshot.publishedAt || 0, snapshot.publishedBy || 'SYSTEM']
    );
  }
  for (const audit of state.audit || []) {
    if (!audit.id) continue;
    await client.query(
      `INSERT INTO matt_mine_normalized.audit_entries
       (audit_id,actor_address,action,target,details,request_id,created_at_ms)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(audit_id) DO NOTHING`,
      [audit.id, audit.actor || 'SYSTEM', audit.action || 'UNKNOWN', audit.target || null,
        audit.details || '', audit.requestId || null, audit.timestamp || 0]
    );
  }
  await client.query(
    `UPDATE matt_mine_normalized.cutover_state SET last_backfill_at=NOW(),updated_at=NOW() WHERE singleton=TRUE`
  );
}

export async function validateNormalizedState(client, state) {
  const [wallets, runs, ledger] = await Promise.all([
    client.query('SELECT COUNT(*)::integer AS count FROM matt_mine_normalized.wallets'),
    client.query('SELECT COUNT(*)::integer AS count FROM matt_mine_normalized.runs'),
    client.query(`SELECT address,balance,ledger_sequence FROM matt_mine_normalized.nugget_balances ORDER BY address`)
  ]);
  const discrepancies = [];
  for (const row of ledger.rows) {
    const legacy = state.wallets?.[row.address];
    if (!legacy) discrepancies.push({ type: 'normalized_wallet_missing_in_legacy', address: row.address });
    else if (Number(row.balance) !== Number(legacy.profile?.bankedNuggets || 0)) {
      discrepancies.push({ type: 'nugget_balance_mismatch', address: row.address, normalized: Number(row.balance), legacy: Number(legacy.profile?.bankedNuggets || 0) });
    }
  }
  await client.query(`UPDATE matt_mine_normalized.cutover_state SET last_validation_at=NOW(),updated_at=NOW() WHERE singleton=TRUE`);
  return {
    ok: discrepancies.length === 0,
    legacy: { wallets: Object.keys(state.wallets || {}).length, runs: Object.keys(state.runs || {}).length },
    normalized: { wallets: wallets.rows[0].count, runs: runs.rows[0].count },
    discrepancies
  };
}

async function upsertRun(client, run) {
  if (!run?.id || !run.address) return;
  const snapshot = run.competitionSnapshot || run.tuning?._competitionSnapshot || null;
  const tuning = run.tuning || {};
  await client.query(
    `INSERT INTO matt_mine_normalized.runs
     (run_id,address,mode,status,token_hash,seed,started_at_ms,expires_at_ms,finished_at_ms,
      build_commit,engine_version,replay_schema_version,map_snapshot_id,map_hash,tuning_version,tuning_hash,
      player_profile_snapshot,pass_multipliers,authoritative_state,legacy_payload)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb)
     ON CONFLICT(run_id) DO UPDATE SET status=EXCLUDED.status,finished_at_ms=EXCLUDED.finished_at_ms,
     authoritative_state=EXCLUDED.authoritative_state,legacy_payload=EXCLUDED.legacy_payload`,
    [run.id, run.address, run.mode || 'unknown', run.status || 'unknown', run.tokenHash || null, run.seed || null,
      run.startedAt || 0, run.expiresAt || 0, run.finishedAt || null, run.buildCommit || process.env.RENDER_GIT_COMMIT || 'unknown',
      run.engineVersion || 'game-v4', run.replaySchemaVersion || 'matt-competitive-input-v1', snapshot?.id || null,
      snapshot ? sha256(stableJson(snapshot)) : null, run.tuningVersion || null, sha256(stableJson(tuning)),
      JSON.stringify(run.playerProfile || {}), JSON.stringify(run.passMultipliers || tuning._minePassBenefits || { xp: 1, nuggets: 1 }),
      JSON.stringify(run.authoritativeCheckpoint || run.playerState || {}), JSON.stringify(run)]
  );
}

function withoutAvatar(wallet) {
  const copy = structuredClone(wallet);
  if (copy.identity) delete copy.identity.avatarDataUrl;
  delete copy.nuggetLedger;
  delete copy.activity;
  delete copy.practiceClaims;
  return copy;
}

function parseAvatar(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
  return match ? { mime: match[1], content: match[2] } : null;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}
