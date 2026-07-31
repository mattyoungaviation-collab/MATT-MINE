import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { MAX_REQUEST_BYTES } from './constants.js';
import { ApiError, assertApi } from './errors.js';
import { normalizeOrigin } from './auth-message.js';

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg'
});

export function createMattMineHttpServer({ root, service, maxRequestBytes = MAX_REQUEST_BYTES }) {
  const staticRoot = resolve(root);
  const rateLimiter = createRateLimiter();

  return http.createServer(async (request, response) => {
    applySecurityHeaders(response);
    try {
      const requestUrl = new URL(request.url || '/', requestOrigin(request, service.publicOrigin));
      if (requestUrl.pathname.startsWith('/api/')) {
        await handleApiRequest({
          request,
          response,
          requestUrl,
          service,
          rateLimiter,
          maxRequestBytes
        });
        return;
      }
      await serveStatic(request, response, requestUrl.pathname, staticRoot);
    } catch (error) {
      sendError(response, error);
    }
  });
}

async function handleApiRequest({
  request,
  response,
  requestUrl,
  service,
  rateLimiter,
  maxRequestBytes
}) {
  const clientKey = request.socket.remoteAddress || 'unknown';
  const stricter = requestUrl.pathname === '/api/auth/challenge';
  rateLimiter.consume(`${clientKey}:${stricter ? 'challenge' : 'api'}`, stricter ? 12 : 240, stricter ? 10 * 60_000 : 60_000);
  if (requestUrl.pathname === '/api/profile/identity' || requestUrl.pathname === '/api/profile/avatar') {
    rateLimiter.consume(`${clientKey}:profile-media`, 12, 10 * 60_000);
  }
  enforceSameOrigin(request, service.publicOrigin);

  const method = request.method || 'GET';
  const path = requestUrl.pathname;
  if (method === 'GET' && path === '/api/health') {
    const health = await service.health();
    sendJson(response, 200, { ok: true, service: 'matt-mine', version: 17, ...health });
    return;
  }
  if (method === 'GET' && path === '/api/config') {
    sendJson(response, 200, { ok: true, config: service.config() });
    return;
  }
  if (method === 'GET' && path === '/api/payments/public-status') {
    const status = await service.publicPaymentStatus();
    sendJson(response, 200, { ok: true, status });
    return;
  }
  if (method === 'GET' && path === '/api/mines') {
    const mines = await service.publicMineSlots();
    sendJson(response, 200, { ok: true, ...mines });
    return;
  }
  const publicMineMatch = path.match(/^\/api\/mines\/(practice|arena|daily|pass|weekly|pvp)$/);
  if (method === 'GET' && publicMineMatch) {
    const result = await service.publicMineSlot(
      publicMineMatch[1],
      requestUrl.searchParams.get('period') || ''
    );
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'POST' && path === '/api/auth/challenge') {
    const body = await readJson(request, maxRequestBytes);
    const expectedOrigin = requestOrigin(request, service.publicOrigin);
    assertApi(normalizeOrigin(body.origin) === expectedOrigin, 403, 'origin_mismatch', 'The browser origin does not match this MATT Mine server.');
    const challenge = await service.createChallenge({
      address: body.address,
      chainId: body.chainId,
      origin: expectedOrigin
    });
    sendJson(response, 201, { ok: true, challenge });
    return;
  }
  if (method === 'POST' && path === '/api/auth/verify') {
    const body = await readJson(request, maxRequestBytes);
    const session = await service.verifyChallenge(body);
    sendJson(response, 200, { ok: true, session });
    return;
  }
  if (method === 'POST' && path === '/api/auth/logout') {
    const result = await service.signOut(bearerToken(request));
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'GET' && path === '/api/me') {
    const player = await service.me(bearerToken(request));
    sendJson(response, 200, { ok: true, player });
    return;
  }
  const profileAvatarMatch = path.match(/^\/api\/profiles\/(0x[a-fA-F0-9]{40})\/avatar$/);
  if (method === 'GET' && profileAvatarMatch) {
    const avatar = await service.profileAvatar(profileAvatarMatch[1]);
    response.writeHead(200, {
      'content-type': avatar.contentType,
      'content-length': avatar.body.length,
      'cache-control': 'public, max-age=31536000, immutable'
    });
    response.end(avatar.body);
    return;
  }
  if (method === 'POST' && path === '/api/profile/identity') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.setPlayerIdentity(bearerToken(request), body);
    sendJson(response, 201, { ok: true, ...result });
    return;
  }
  if (method === 'PUT' && path === '/api/profile/avatar') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.updatePlayerAvatar(bearerToken(request), body.avatarDataUrl);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'GET' && path === '/api/payments/status') {
    const status = await service.paymentStatus(bearerToken(request));
    sendJson(response, 200, { ok: true, status });
    return;
  }
  if (method === 'GET' && path === '/api/arena/config') {
    const arena = await service.arenaConfig(requestUrl.searchParams.get('day') || '');
    sendJson(response, 200, { ok: true, arena });
    return;
  }
  if (method === 'POST' && path === '/api/arena/entries/quote') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.quoteArenaEntry(bearerToken(request), body);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'POST' && path === '/api/arena/entries/confirm') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.confirmArenaEntry(
      bearerToken(request),
      body.enterTransactionHash || body.transactionHash
    );
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'GET' && path === '/api/arena/me') {
    const player = await service.arenaMe(
      bearerToken(request),
      requestUrl.searchParams.get('day') || ''
    );
    sendJson(response, 200, { ok: true, player });
    return;
  }
  if (method === 'GET' && path === '/api/arena/leaderboard') {
    const leaderboard = await service.arenaLeaderboard(
      requestUrl.searchParams.get('day') || ''
    );
    sendJson(response, 200, { ok: true, leaderboard });
    return;
  }
  if (method === 'POST' && path === '/api/arena/runs/start') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.startArenaRun(bearerToken(request), body);
    sendJson(response, 201, { ok: true, ...result });
    return;
  }
  if (method === 'POST' && path === '/api/arena/runs/events') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.appendArenaEvents(bearerToken(request), body);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'POST' && path === '/api/arena/runs/finish') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.finishArenaRun(bearerToken(request), body);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  const publicTuningMatch = path.match(/^\/api\/game-tuning\/(practice|free|paid|arena)$/);
  if (method === 'GET' && publicTuningMatch) {
    const result = await service.publicGameTuning(publicTuningMatch[1]);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'PUT' && path === '/api/profile/keybindings') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.updatePlayerKeybindings(bearerToken(request), body.keybindings);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'POST' && path === '/api/arena/runs/abandon') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.abandonArenaRun(bearerToken(request), body);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'POST' && path === '/api/arena/runs/abandon-active') {
    await readJson(request, maxRequestBytes);
    const result = await service.abandonActiveArenaRun(bearerToken(request));
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'POST' && path === '/api/arena/refunds/prepare') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.prepareArenaRefund(
      bearerToken(request),
      body.day || ''
    );
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'POST' && path === '/api/payments/pass/confirm') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.confirmPassPurchase(bearerToken(request), body.transactionHash);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'GET' && path === '/api/pass/rewards') {
    const result = await service.passRewards(bearerToken(request));
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'POST' && path === '/api/pass/rewards/sync') {
    await readJson(request, maxRequestBytes);
    const result = await service.syncPassRewards(bearerToken(request));
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'PUT' && path === '/api/pass/loadout') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.equipPassCosmetic(bearerToken(request), body.slot, body.cosmeticId);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'POST' && path === '/api/pass/chests/open') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.openPassChest(bearerToken(request), body.chestId);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'POST' && path === '/api/payments/paid-run/quote') {
    await readJson(request, maxRequestBytes);
    const quote = await service.quotePaidRun(bearerToken(request));
    sendJson(response, 200, { ok: true, quote });
    return;
  }
  if (method === 'POST' && path === '/api/payments/paid-run/confirm') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.confirmPaidRunPurchase(bearerToken(request), body.transactionHash);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'POST' && path === '/api/runs/start') {
    const body = await readJson(request, maxRequestBytes);
    const run = await service.startRun(bearerToken(request), body.mode);
    sendJson(response, 201, { ok: true, run });
    return;
  }
  if (method === 'POST' && path === '/api/runs/finish') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.finishRun(bearerToken(request), body);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'POST' && path === '/api/runs/practice/claim') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.practiceRunClaim(bearerToken(request), body);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'POST' && path === '/api/runs/abandon') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.abandonRun(bearerToken(request), body);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'GET' && path === '/api/leaderboards') {
    const result = await service.leaderboard(
      bearerToken(request),
      requestUrl.searchParams.get('mode'),
      service.now(),
      requestUrl.searchParams.get('week')
    );
    sendJson(response, 200, { ok: true, leaderboard: result });
    return;
  }
  if (method === 'GET' && path === '/api/rewards/claims') {
    const claims = await service.rewardClaims(bearerToken(request));
    sendJson(response, 200, { ok: true, claims });
    return;
  }
  const claimPrepareMatch = path.match(/^\/api\/rewards\/claims\/(reward_\d{4}-\d{2}-\d{2}_(?:free|paid))\/prepare$/);
  if (method === 'POST' && claimPrepareMatch) {
    await readJson(request, maxRequestBytes);
    const result = await service.prepareRewardClaim(
      bearerToken(request),
      claimPrepareMatch[1]
    );
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'POST' && path === '/api/profile/upgrades') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.purchaseUpgrade(bearerToken(request), body.upgradeId);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }

  const suspensionMatch = path.match(/^\/api\/admin\/wallets\/(0x[a-fA-F0-9]{40})\/suspension$/);
  if (method === 'PUT' && suspensionMatch) {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.setWalletSuspension(
      request.headers['x-matt-admin-key'],
      suspensionMatch[1],
      body.suspended,
      body.reason
    );
    sendJson(response, 200, { ok: true, ...result });
    return;
  }

  if (method === 'GET' && path === '/api/admin/arena') {
    const arena = await service.adminArenaOverview(
      request.headers['x-matt-admin-key'],
      requestUrl.searchParams.get('day') || ''
    );
    sendJson(response, 200, { ok: true, arena });
    return;
  }
  const arenaDayMatch = path.match(/^\/api\/admin\/arena\/days\/(\d{4}-\d{2}-\d{2})$/);
  if (method === 'PUT' && arenaDayMatch) {
    const body = await readJson(request, maxRequestBytes);
    const arena = await service.prepareArenaDay(
      request.headers['x-matt-admin-key'],
      arenaDayMatch[1],
      body
    );
    sendJson(response, 200, { ok: true, arena });
    return;
  }
  const arenaSettlementMatch = path.match(/^\/api\/admin\/arena\/days\/(\d{4}-\d{2}-\d{2})\/settlement$/);
  if (method === 'POST' && arenaSettlementMatch) {
    const body = await readJson(request, maxRequestBytes);
    const settlement = await service.prepareArenaSettlement(
      request.headers['x-matt-admin-key'],
      arenaSettlementMatch[1],
      body
    );
    sendJson(response, 200, { ok: true, settlement });
    return;
  }
  const arenaSeedMatch = path.match(/^\/api\/admin\/arena\/days\/(\d{4}-\d{2}-\d{2})\/seed$/);
  if (method === 'POST' && arenaSeedMatch) {
    const body = await readJson(request, maxRequestBytes);
    const seed = await service.prepareArenaSeedTopUp(
      request.headers['x-matt-admin-key'],
      arenaSeedMatch[1],
      body
    );
    sendJson(response, 200, { ok: true, seed });
    return;
  }
  const arenaCancelMatch = path.match(/^\/api\/admin\/arena\/days\/(\d{4}-\d{2}-\d{2})\/cancel$/);
  if (method === 'POST' && arenaCancelMatch) {
    const body = await readJson(request, maxRequestBytes);
    const cancellation = await service.prepareArenaCancellation(
      request.headers['x-matt-admin-key'],
      arenaCancelMatch[1],
      body
    );
    sendJson(response, 200, { ok: true, cancellation });
    return;
  }
  const arenaControlMatch = path.match(/^\/api\/admin\/arena\/controls\/(pause-entries|unpause-entries|pause-settlement|unpause-settlement)$/);
  if (method === 'POST' && arenaControlMatch) {
    const body = await readJson(request, maxRequestBytes);
    const control = await service.prepareArenaControl(
      request.headers['x-matt-admin-key'],
      arenaControlMatch[1],
      body
    );
    sendJson(response, 200, { ok: true, control });
    return;
  }

  if (method === 'GET' && path === '/api/admin/overview') {
    const result = await service.adminOverview(request.headers['x-matt-admin-key']);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'GET' && path === '/api/admin/wallets') {
    const result = await service.adminWallets(
      request.headers['x-matt-admin-key'],
      requestUrl.searchParams.get('query') || ''
    );
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  const adminWalletMatch = path.match(/^\/api\/admin\/wallets\/(0x[a-fA-F0-9]{40})$/);
  if (method === 'GET' && adminWalletMatch) {
    const result = await service.adminWallet(request.headers['x-matt-admin-key'], adminWalletMatch[1]);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  const walletActionMatch = path.match(/^\/api\/admin\/wallets\/(0x[a-fA-F0-9]{40})\/actions$/);
  if (method === 'POST' && walletActionMatch) {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.adminWalletAction(
      request.headers['x-matt-admin-key'],
      walletActionMatch[1],
      body.action,
      body.reason
    );
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  const walletAwardMatch = path.match(/^\/api\/admin\/wallets\/(0x[a-fA-F0-9]{40})\/awards$/);
  if (method === 'POST' && walletAwardMatch) {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.adminAwardPlayer(
      request.headers['x-matt-admin-key'],
      walletAwardMatch[1],
      body,
      body.reason
    );
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'GET' && path === '/api/admin/game-tuning') {
    const result = await service.adminGameTuning(request.headers['x-matt-admin-key']);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'GET' && path === '/api/admin/competition-studio') {
    const result = await service.adminCompetitionStudio(request.headers['x-matt-admin-key']);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  const competitionDraftMatch = path.match(/^\/api\/admin\/competition-studio\/(practice|arena|daily|pass|weekly)\/draft$/);
  if (method === 'PUT' && competitionDraftMatch) {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.saveCompetitionDraft(
      request.headers['x-matt-admin-key'],
      competitionDraftMatch[1],
      body.draft,
      body.reason
    );
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  const competitionPublishMatch = path.match(/^\/api\/admin\/competition-studio\/(practice|arena|daily|pass|weekly)\/publish$/);
  if (method === 'POST' && competitionPublishMatch) {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.publishCompetitionSnapshot(
      request.headers['x-matt-admin-key'],
      competitionPublishMatch[1],
      body
    );
    sendJson(response, 201, { ok: true, ...result });
    return;
  }
  const competitionActivateMatch = path.match(/^\/api\/admin\/competition-studio\/(practice|arena|daily|pass|weekly)\/versions\/([A-Za-z0-9_-]+)\/activate$/);
  if (method === 'POST' && competitionActivateMatch) {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.activateCompetitionSnapshot(
      request.headers['x-matt-admin-key'],
      competitionActivateMatch[1],
      competitionActivateMatch[2],
      body.reason
    );
    sendJson(response, 201, { ok: true, ...result });
    return;
  }
  const gameTuningMatch = path.match(/^\/api\/admin\/game-tuning\/(practice|free|paid|arena)$/);
  if (method === 'PUT' && gameTuningMatch) {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.updateAdminGameTuning(
      request.headers['x-matt-admin-key'],
      gameTuningMatch[1],
      body.patch,
      body.reason
    );
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'PUT' && path === '/api/admin/operations') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.updateOperations(
      request.headers['x-matt-admin-key'],
      body.patch,
      body.reason
    );
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'GET' && path === '/api/admin/mine-operations') {
    const result = await service.adminMineOperations(
      request.headers['x-matt-admin-key'],
      requestUrl.searchParams.get('week') || ''
    );
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  const mineOperationsMatch = path.match(/^\/api\/admin\/mine-operations\/(practice|arena|daily|pass|weekly)$/);
  if (method === 'PUT' && mineOperationsMatch) {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.updateMineOperations(
      request.headers['x-matt-admin-key'],
      mineOperationsMatch[1],
      body.patch,
      body.reason
    );
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  const terminateMineRunsMatch = path.match(/^\/api\/admin\/mine-operations\/(practice|arena|daily|pass|weekly)\/terminate-runs$/);
  if (method === 'POST' && terminateMineRunsMatch) {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.adminTerminateMineRuns(
      request.headers['x-matt-admin-key'],
      terminateMineRunsMatch[1],
      body.reason
    );
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'GET' && path === '/api/admin/audit') {
    const result = await service.adminAudit(request.headers['x-matt-admin-key'], {
      action: requestUrl.searchParams.get('action'),
      actor: requestUrl.searchParams.get('actor'),
      limit: requestUrl.searchParams.get('limit')
    });
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'POST' && path === '/api/admin/contracts/prepare') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.prepareAdminContractAction(
      request.headers['x-matt-admin-key'],
      body,
      body.reason
    );
    sendJson(response, 200, { ok: true, ...result });
    return;
  }

  if (method === 'GET' && path === '/api/admin/rewards/drafts') {
    const result = await service.listRewardDrafts(request.headers['x-matt-admin-key']);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'POST' && path === '/api/admin/rewards/drafts') {
    const body = await readJson(request, maxRequestBytes);
    const draft = await service.createRewardDraft(
      request.headers['x-matt-admin-key'],
      body
    );
    sendJson(response, 201, { ok: true, draft });
    return;
  }
  const rewardApprovalMatch = path.match(/^\/api\/admin\/rewards\/drafts\/(reward_\d{4}-\d{2}-\d{2}_(?:free|paid))\/approve$/);
  if (method === 'POST' && rewardApprovalMatch) {
    await readJson(request, maxRequestBytes);
    const result = await service.approveRewardDraft(
      request.headers['x-matt-reward-approver-key'],
      rewardApprovalMatch[1]
    );
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  const rewardSyncMatch = path.match(/^\/api\/admin\/rewards\/drafts\/(reward_\d{4}-\d{2}-\d{2}_(?:free|paid))\/sync$/);
  if (method === 'POST' && rewardSyncMatch) {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.syncRewardDraft(
      request.headers['x-matt-admin-key'],
      rewardSyncMatch[1],
      body.transactionHash
    );
    sendJson(response, 200, { ok: true, ...result });
    return;
  }

  throw new ApiError(404, 'api_not_found', 'The requested API route does not exist.');
}

async function serveStatic(request, response, pathname, root) {
  assertApi(['GET', 'HEAD'].includes(request.method || 'GET'), 405, 'method_not_allowed', 'Static files only support GET and HEAD.');
  const decoded = decodeURIComponent(pathname);
  assertApi(!decoded.includes('\0'), 400, 'invalid_path', 'The requested path is invalid.');
  const requestedPath = decoded === '/' ? 'index.html' : decoded.replace(/^[/\\]+/, '');
  let filePath = resolve(root, requestedPath);
  const rootRelativePath = relative(root, filePath);
  assertApi(
    rootRelativePath !== '..' && !rootRelativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rootRelativePath),
    403,
    'path_forbidden',
    'The requested path is outside the application root.'
  );
  const info = await stat(filePath).catch(() => null);
  if (info?.isDirectory()) filePath = resolve(filePath, 'index.html');
  const body = await readFile(filePath).catch(() => null);
  assertApi(body, 404, 'file_not_found', 'Not found.');
  const extension = extname(filePath);
  const cacheControl = requestedPath === 'index.html'
    ? 'no-cache'
    : ['.png', '.svg', '.ico', '.mp3'].includes(extension)
      ? 'public, max-age=86400'
      : 'no-cache';
  response.writeHead(200, {
    'content-type': MIME_TYPES[extension] || 'application/octet-stream',
    'cache-control': cacheControl
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

function requestOrigin(request, configuredOrigin) {
  if (configuredOrigin) return normalizeOrigin(configuredOrigin);
  const host = request.headers.host;
  assertApi(typeof host === 'string' && host.length > 0, 400, 'host_required', 'The HTTP Host header is required.');
  const forwardedProtocol = String(request.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const protocol = forwardedProtocol === 'https' ? 'https' : 'http';
  return normalizeOrigin(`${protocol}://${host}`);
}

function enforceSameOrigin(request, configuredOrigin) {
  const originHeader = request.headers.origin;
  if (!originHeader) return;
  const expected = requestOrigin(request, configuredOrigin);
  assertApi(normalizeOrigin(originHeader) === expected, 403, 'cross_origin_rejected', 'Cross-origin API requests are not allowed.');
}

function bearerToken(request) {
  const authorization = request.headers.authorization;
  assertApi(typeof authorization === 'string' && authorization.startsWith('Bearer '), 401, 'authorization_required', 'A wallet session is required.');
  return authorization.slice('Bearer '.length);
}

async function readJson(request, maxBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    assertApi(size <= maxBytes, 413, 'request_too_large', 'The request body is too large.');
    chunks.push(chunk);
  }
  assertApi(chunks.length > 0, 400, 'json_required', 'A JSON request body is required.');
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assertApi(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 400, 'json_object_required', 'The JSON body must be an object.');
    return parsed;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
}

function sendJson(response, status, body) {
  if (response.headersSent) return;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(body));
}

function sendError(response, error) {
  if (response.headersSent) {
    response.end();
    return;
  }
  const status = error instanceof ApiError ? error.status : 500;
  const code = error instanceof ApiError ? error.code : 'internal_error';
  const message = error instanceof ApiError ? error.message : 'The MATT Mine server encountered an unexpected error.';
  if (!(error instanceof ApiError)) console.error('[MATT Mine server]', error);
  sendJson(response, status, {
    ok: false,
    error: { code, message, ...(error?.details ? { details: error.details } : {}) }
  });
}

function applySecurityHeaders(response) {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'same-origin');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('cross-origin-opener-policy', 'same-origin');
  response.setHeader('cross-origin-resource-policy', 'same-origin');
  response.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader(
    'content-security-policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  );
}

function createRateLimiter() {
  const buckets = new Map();
  return {
    consume(key, limit, windowMs) {
      const timestamp = Date.now();
      const current = buckets.get(key);
      if (!current || current.resetsAt <= timestamp) {
        buckets.set(key, { count: 1, resetsAt: timestamp + windowMs });
        return;
      }
      assertApi(current.count < limit, 429, 'rate_limited', 'Too many requests. Try again shortly.');
      current.count += 1;
      if (buckets.size > 5_000) {
        for (const [bucketKey, bucket] of buckets) {
          if (bucket.resetsAt <= timestamp) buckets.delete(bucketKey);
        }
      }
    }
  };
}
