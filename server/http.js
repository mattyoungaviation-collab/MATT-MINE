import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { MAX_COMPETITION_DRAFT_REQUEST_BYTES, MAX_REQUEST_BYTES } from './constants.js';
import { ApiError, assertApi } from './errors.js';
import { normalizeOrigin } from './auth-message.js';
import { isTransientPostgresError } from './postgres-resilience.js';
import { observeHttpRequest } from './observability.js';
import { requestClientKey } from './request-client-key.js';
import { nftRpcUrlFromEnvironment } from './nft-rpc-url.js';

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8'
});

const PUBLIC_ROOT_FILES = new Set([
  'index.html',
  'admin.html',
  'admin.css',
  'nft-lab.html',
  'robots.txt'
]);
const PUBLIC_SOURCE_EXTENSIONS = new Set(['.js', '.css']);
const PUBLIC_ASSET_EXTENSIONS = new Set(['.png', '.webp', '.svg', '.ico', '.mp3']);
const PUBLIC_LEGAL_FILES = new Set(['legal/matt-mine-arena-rules-v0.01.txt']);

const RETIRED_ARENA_RULES_PATH = 'legal/matt-mine-arena-rules-v0.01.pdf';
const PUBLIC_ARENA_RULES_PATH = '/legal/matt-mine-arena-rules-v0.01.txt';
const NFT_LAB_MAINNET_RPC_URL = nftRpcUrlFromEnvironment();
const NFT_LAB_RPC_METHODS = new Set(['eth_call', 'eth_getTransactionReceipt']);
const NFT_LAB_RPC_CONTRACTS = new Set([
  '0xbbabe35b943e3ba911b53c2b39447cf181fe565a',
  '0x415cf1dea47f3d4bab830f78b82e12d6eeced612',
  '0xb88c219c792cfa07749e0e5d939dbbbf1e62c7b5',
  '0x693525e7fd76949834cad56d67d469baad6687f6',
  '0x21bee81adc4c87e3ea4686dd8a38a64c8ea5b95c',
  '0x8c640cd91ea6616cdd07b8323492e76e5c9ffe78',
  '0x2d2034e55900d285dc05d30a0c14846d7a30285b',
  '0xa5450417bdca0bdfb058ffe41205400ffda1174d'
]);

export function createMattMineHttpServer({ root, service, maxRequestBytes = MAX_REQUEST_BYTES }) {
  const staticRoot = resolve(root);
  const rateLimiter = createRateLimiter();

  return http.createServer(async (request, response) => {
    observeHttpRequest(request, response);
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
  const clientKey = requestClientKey(request);
  const stricter = requestUrl.pathname === '/api/auth/challenge';
  const nftLabRpc = requestUrl.pathname === '/api/nft-lab/rpc';
  const limiterName = stricter ? 'challenge' : nftLabRpc ? 'nft-lab-rpc' : 'api';
  const limiterCount = stricter ? 12 : nftLabRpc ? 1_500 : 240;
  const limiterWindow = stricter ? 10 * 60_000 : 60_000;
  rateLimiter.consume(`${clientKey}:${limiterName}`, limiterCount, limiterWindow);
  if (requestUrl.pathname === '/api/profile/identity' || requestUrl.pathname === '/api/profile/avatar') {
    rateLimiter.consume(`${clientKey}:profile-media`, 12, 10 * 60_000);
  }
  const method = request.method || 'GET';
  const path = requestUrl.pathname;
  enforceSameOrigin(request, service.publicOrigin, method);
  if (method === 'GET' && path === '/api/live') {
    sendJson(response, 200, { ok: true, service: 'matt-mine', version: service.appVersion, commit: service.buildCommit });
    return;
  }
  if (method === 'GET' && path === '/api/ready') {
    const health = await service.health();
    sendJson(response, health.degraded ? 503 : 200, { ok: !health.degraded, service: 'matt-mine', ...health });
    return;
  }
  if (method === 'GET' && path === '/api/health') {
    const health = await service.health();
    sendJson(response, 200, { ok: true, service: 'matt-mine', ...health, version: 17 });
    return;
  }
  if (method === 'POST' && path === '/api/nft-lab/rpc') {
    const body = await readJson(request, Math.min(maxRequestBytes, 16 * 1024));
    const rpcRequest = validatedNftLabRpcRequest(body);
    let upstream;
    try {
      upstream = await fetch(NFT_LAB_MAINNET_RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(rpcRequest),
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw new ApiError(502, 'nft_rpc_upstream_unreachable', 'The Ronin Mainnet RPC could not be reached.');
    }
    assertApi(upstream.ok, 502, 'nft_rpc_upstream_failed', `Ronin Mainnet RPC returned HTTP ${upstream.status}.`);
    let payload;
    try {
      payload = await upstream.json();
    } catch {
      throw new ApiError(502, 'nft_rpc_invalid_json', 'The Ronin Mainnet RPC returned invalid JSON.');
    }
    assertApi(payload && typeof payload === 'object' && !Array.isArray(payload), 502, 'nft_rpc_invalid_response', 'The Ronin Mainnet RPC returned an invalid response.');
    sendJson(response, 200, { jsonrpc: '2.0', id: rpcRequest.id, ...(payload.error ? { error: payload.error } : { result: payload.result }) });
    return;
  }
  if (method === 'GET' && path === '/api/nft-lab/metadata') {
    const metadataUrl = validatedNftLabMetadataUrl(requestUrl.searchParams.get('url'));
    let upstream;
    try {
      upstream = await fetch(metadataUrl, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw new ApiError(502, 'nft_metadata_upstream_unreachable', 'The public NFT metadata host could not be reached.');
    }
    assertApi(upstream.ok, 502, 'nft_metadata_upstream_failed', `NFT metadata returned HTTP ${upstream.status}.`);
    const contentLength = Number(upstream.headers.get('content-length') || 0);
    assertApi(!contentLength || contentLength <= 256 * 1024, 502, 'nft_metadata_too_large', 'NFT metadata exceeds 256 KB.');
    const text = await upstream.text();
    assertApi(Buffer.byteLength(text) <= 256 * 1024, 502, 'nft_metadata_too_large', 'NFT metadata exceeds 256 KB.');
    let metadata;
    try {
      metadata = JSON.parse(text);
    } catch {
      throw new ApiError(502, 'nft_metadata_invalid_json', 'NFT metadata did not return valid JSON.');
    }
    sendPublicJson(response, 200, metadata);
    return;
  }
  if (method === 'GET' && path === '/api/nft-lab/image') {
    const imageUrl = validatedNftLabImageUrl(requestUrl.searchParams.get('url'));
    let upstream;
    try {
      upstream = await fetch(imageUrl, {
        headers: { accept: 'image/png' },
        signal: AbortSignal.timeout(20_000)
      });
    } catch {
      throw new ApiError(502, 'nft_image_upstream_unreachable', 'The public NFT image host could not be reached.');
    }
    assertApi(upstream.ok, 502, 'nft_image_upstream_failed', `NFT image returned HTTP ${upstream.status}.`);
    assertApi(
      String(upstream.headers.get('content-type') || '').toLowerCase().startsWith('image/png'),
      502,
      'nft_image_type_invalid',
      'NFT image did not return a PNG.'
    );
    const contentLength = Number(upstream.headers.get('content-length') || 0);
    assertApi(!contentLength || contentLength <= 1024 * 1024, 502, 'nft_image_too_large', 'NFT image exceeds 1 MB.');
    const body = Buffer.from(await upstream.arrayBuffer());
    assertApi(body.length <= 1024 * 1024, 502, 'nft_image_too_large', 'NFT image exceeds 1 MB.');
    response.writeHead(200, {
      'content-type': 'image/png',
      'content-length': body.length,
      'cache-control': 'public, max-age=300',
      'cross-origin-resource-policy': 'same-origin'
    });
    response.end(body);
    return;
  }
  if (method === 'POST' && path === '/api/admin/auth/session') {
    const session = await service.createAdminSession(bearerToken(request));
    setAdminCookie(response, session.token, session.expiresAt);
    sendJson(response, 201, { ok: true, admin: { address: session.address, expiresAt: session.expiresAt }, csrfToken: session.csrfToken });
    return;
  }
  if (method === 'POST' && path === '/api/admin/auth/logout') {
    const token = adminCookie(request);
    await service.authenticateAdminSession(token, { mutation: true, csrfToken: request.headers['x-matt-csrf'] });
    await service.revokeAdminSession(token);
    clearAdminCookie(response);
    sendJson(response, 200, { ok: true, signedOut: true });
    return;
  }
  if (method === 'GET' && path === '/api/admin/auth/status') {
    const admin = await service.authenticateAdminSession(adminCookie(request));
    sendJson(response, 200, { ok: true, admin });
    return;
  }
  if (method === 'POST' && path === '/api/admin/auth/step-up/challenge') {
    const token = adminCookie(request);
    await service.authenticateAdminSession(token, { mutation: true, csrfToken: request.headers['x-matt-csrf'] });
    sendJson(response, 201, { ok: true, challenge: await service.createAdminStepUp(token) });
    return;
  }
  if (method === 'POST' && path === '/api/admin/auth/step-up/verify') {
    const token = adminCookie(request);
    await service.authenticateAdminSession(token, { mutation: true, csrfToken: request.headers['x-matt-csrf'] });
    const body = await readJson(request, maxRequestBytes);
    sendJson(response, 200, { ok: true, admin: await service.verifyAdminStepUp(token, body.nonce, body.signature) });
    return;
  }
  if (path.startsWith('/api/admin/')) {
    const mutation = !['GET', 'HEAD'].includes(method);
    const emergencyKey = request.headers['x-matt-admin-key'];
    const independentRewardApproval = /\/api\/admin\/rewards\/drafts\/[^/]+\/approve$/.test(path) && request.headers['x-matt-reward-approver-key'];
    if (independentRewardApproval) {
      // The reward manager independently validates its server-side approver secret.
    } else if (emergencyKey) service.assertAdminKey(emergencyKey);
    else await service.authenticateAdminSession(adminCookie(request), {
        mutation,
        csrfToken: request.headers['x-matt-csrf'],
        stepUp: mutation && requiresAdminStepUp(path)
      });
    // Existing service methods retain a server-only emergency credential. It
    // is injected after wallet-cookie authorization and never reaches JS.
    request.headers['x-matt-admin-key'] = service.adminKey;
    if (path.includes('/rewards/') && path.endsWith('/approve')) {
      request.headers['x-matt-reward-approver-key'] = service.rewardManager?.approverKey || '';
    }
  }
  if (method === 'GET' && path === '/api/config') {
    sendJson(response, 200, { ok: true, config: service.config() });
    return;
  }
  const minerMetadataMatch = path.match(/^\/api\/nft\/(?:v2\/)?miners\/(\d+)\.json$/);
  if (method === 'GET' && minerMetadataMatch) {
    sendPublicJson(response, 200, await nftService(service).minerMetadata(minerMetadataMatch[1]));
    return;
  }
  const minerImageMatch = path.match(/^\/api\/nft\/(?:v2\/)?miners\/(\d+)\/image\.png$/);
  if (['GET', 'HEAD'].includes(method) && minerImageMatch) {
    const image = await nftService(service).minerImage(minerImageMatch[1]);
    sendPublicImage(request, response, image);
    return;
  }
  const minerSpriteMatch = path.match(/^\/api\/nft\/(?:v2\/)?miners\/(\d+)\/sprite\.png$/);
  if (['GET', 'HEAD'].includes(method) && minerSpriteMatch) {
    const image = await nftService(service).minerSprite(minerSpriteMatch[1]);
    sendPublicImage(request, response, image);
    return;
  }
  const equipmentMetadataMatch = path.match(/^\/api\/nft\/(?:v2\/)?equipment\/(\d+)\.json$/);
  if (method === 'GET' && equipmentMetadataMatch) {
    sendPublicJson(response, 200, await nftService(service).equipmentMetadata(equipmentMetadataMatch[1]));
    return;
  }
  if (method === 'GET' && ['/api/nft/contracts/miners.json', '/api/nft/v2/contracts/miners.json'].includes(path)) {
    sendPublicJson(response, 200, nftService(service).minerContractMetadata());
    return;
  }
  if (method === 'GET' && ['/api/nft/contracts/equipment.json', '/api/nft/v2/contracts/equipment.json'].includes(path)) {
    sendPublicJson(response, 200, nftService(service).equipmentContractMetadata());
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
  const publicMineMatch = path.match(/^\/api\/mines\/(practice|arena|pass|endless)$/);
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
  const ownedMinerMatch = path.match(/^\/api\/me\/miners\/(\d+)$/);
  if (method === 'GET' && ownedMinerMatch) {
    const miner = await service.ownedMiner(bearerToken(request), ownedMinerMatch[1]);
    sendJson(response, 200, { ok: true, miner });
    return;
  }
  if (method === 'GET' && path === '/api/me/equipment') {
    const inventory = await service.equipmentInventory(bearerToken(request), {
      cursor: requestUrl.searchParams.get('cursor') || '',
      limit: requestUrl.searchParams.get('limit') || '',
      priorityTokenIds: requestUrl.searchParams.get('priority') || ''
    });
    sendJson(response, 200, { ok: true, inventory });
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
    const result = await service.confirmArenaEntry(bearerToken(request), body);
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
    const run = await service.startRun(bearerToken(request), body.mode, {
      minerId: body.minerId,
      authorization: body.authorization,
      playerSignature: body.playerSignature
    });
    sendJson(response, 201, { ok: true, run });
    return;
  }
  if (method === 'POST' && path === '/api/nft/v2/runs/authorization') {
    const body = await readJson(request, maxRequestBytes);
    const authorization = await service.prepareNftRunAuthorization(bearerToken(request), body);
    sendJson(response, 200, { ok: true, authorization });
    return;
  }
  if (method === 'POST' && path === '/api/runs/nft-practice/restart') {
    await readJson(request, maxRequestBytes);
    const run = await service.restartInterruptedNftPractice(bearerToken(request));
    sendJson(response, 201, { ok: true, run });
    return;
  }
  if (method === 'POST' && path === '/api/nft/v2/runs/recover') {
    const body = await readJson(request, maxRequestBytes);
    const recovery = await service.recoverLockedMinerRun(bearerToken(request), body);
    sendJson(response, 200, { ok: true, recovery });
    return;
  }
  if (method === 'POST' && path === '/api/runs/finish') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.finishRun(bearerToken(request), body);
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
  if (method === 'GET' && path === '/api/admin/operations-health') {
    const result = await service.adminOperationsHealth(
      request.headers['x-matt-admin-key'],
      { force: requestUrl.searchParams.get('refresh') === 'true' }
    );
    sendJson(response, 200, { ok: true, report: result });
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
  if (method === 'GET' && path === '/api/admin/nft-v2/protocol') {
    const result = await service.adminNftV2Protocol(request.headers['x-matt-admin-key']);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'PUT' && path === '/api/admin/nft-v2/economy') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.updateAdminNftV2Economy(request.headers['x-matt-admin-key'], body);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'PUT' && path === '/api/admin/nft-v2/phase-xp') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.updateAdminNftV2PhaseXp(request.headers['x-matt-admin-key'], body);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'POST' && path === '/api/admin/nft-v2/maps/approve') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.approveAdminNftV2Map(request.headers['x-matt-admin-key'], body);
    sendJson(response, 201, { ok: true, ...result });
    return;
  }
  if (method === 'POST' && path === '/api/admin/nft-v2/maps/retire') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.retireAdminNftV2Map(request.headers['x-matt-admin-key'], body);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'GET' && path === '/api/admin/competition-studio') {
    const result = await service.adminCompetitionStudio(request.headers['x-matt-admin-key']);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  const competitionDraftMatch = path.match(/^\/api\/admin\/competition-studio\/(practice|arena|pass)\/draft$/);
  if (method === 'PUT' && competitionDraftMatch) {
    const body = await readJson(request, Math.max(maxRequestBytes, MAX_COMPETITION_DRAFT_REQUEST_BYTES));
    const result = await service.saveCompetitionDraft(
      request.headers['x-matt-admin-key'],
      competitionDraftMatch[1],
      body.draft,
      body.reason
    );
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  const competitionPublishMatch = path.match(/^\/api\/admin\/competition-studio\/(practice|arena|pass)\/publish$/);
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
  const competitionActivateMatch = path.match(/^\/api\/admin\/competition-studio\/(practice|arena|pass)\/versions\/([A-Za-z0-9_-]+)\/activate$/);
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
  const mineOperationsMatch = path.match(/^\/api\/admin\/mine-operations\/(practice|arena|pass)$/);
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
  const terminateMineRunsMatch = path.match(/^\/api\/admin\/mine-operations\/(practice|arena|pass)\/terminate-runs$/);
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

export function validatedNftLabRpcRequest(value) {
  const method = String(value?.method || '');
  const id = Number(value?.id);
  const params = value?.params;
  assertApi(NFT_LAB_RPC_METHODS.has(method), 400, 'nft_rpc_method_forbidden', 'Only approved Ronin Mainnet NFT read methods may be proxied.');
  assertApi(Number.isSafeInteger(id) && id >= 0, 400, 'nft_rpc_id_invalid', 'The Ronin Mainnet RPC request ID is invalid.');
  assertApi(Array.isArray(params), 400, 'nft_rpc_params_invalid', 'The Ronin Mainnet RPC parameters are invalid.');

  if (method === 'eth_call') {
    const call = params[0];
    assertApi(params.length === 2 && params[1] === 'latest', 400, 'nft_rpc_block_invalid', 'NFT contract reads must use the latest Ronin Mainnet block.');
    assertApi(call && typeof call === 'object' && !Array.isArray(call), 400, 'nft_rpc_call_invalid', 'The NFT contract read is invalid.');
    const to = String(call.to || '').toLowerCase();
    const data = String(call.data || '');
    assertApi(NFT_LAB_RPC_CONTRACTS.has(to), 400, 'nft_rpc_contract_forbidden', 'Only the activated MATT Mine Mainnet NFT contracts may be read.');
    assertApi(/^0x[0-9a-f]+$/i.test(data) && data.length % 2 === 0 && data.length <= 8_194, 400, 'nft_rpc_data_invalid', 'The NFT contract calldata is invalid.');
    return { jsonrpc: '2.0', id, method, params: [{ to, data }, 'latest'] };
  }

  const hash = String(params[0] || '').toLowerCase();
  assertApi(params.length === 1 && /^0x[0-9a-f]{64}$/.test(hash), 400, 'nft_rpc_hash_invalid', 'The Ronin Mainnet transaction hash is invalid.');
  return { jsonrpc: '2.0', id, method, params: [hash] };
}

export function validatedNftLabMetadataUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new ApiError(400, 'nft_metadata_url_invalid', 'NFT metadata URL is invalid.');
  }
  assertApi(
    url.origin === 'https://matt-mine.onrender.com'
      && /^\/api\/nft\/(?:v2\/)?(miners|equipment)\/[1-9][0-9]*\.json$/.test(url.pathname),
    400,
    'nft_metadata_url_forbidden',
    'Only public MATT Mine Miner and Equipment metadata may be proxied.'
  );
  const revision = url.searchParams.get('v');
  assertApi(!revision || /^[1-9][0-9]*$/.test(revision), 400, 'nft_metadata_revision_invalid', 'NFT metadata revision is invalid.');
  url.search = revision ? `?v=${revision}` : '';
  return url.href;
}

export function validatedNftLabImageUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new ApiError(400, 'nft_image_url_invalid', 'NFT image URL is invalid.');
  }
  const dynamicImage = /^\/api\/nft\/(?:v2\/)?(miners|equipment)\/[1-9][0-9]*\/image\.png$/.test(url.pathname);
  const staticLayer = /^\/assets\/nft\/[a-z0-9/_-]+\.png$/i.test(url.pathname);
  assertApi(
    url.origin === 'https://matt-mine.onrender.com' && (dynamicImage || staticLayer),
    400,
    'nft_image_url_forbidden',
    'Only public MATT Mine NFT PNGs may be proxied.'
  );
  const revision = url.searchParams.get('v');
  assertApi(!revision || /^[a-f0-9]{8,64}$/i.test(revision), 400, 'nft_image_revision_invalid', 'NFT image revision is invalid.');
  url.search = revision ? `?v=${revision}` : '';
  return url.href;
}

async function serveStatic(request, response, pathname, root) {
  assertApi(['GET', 'HEAD'].includes(request.method || 'GET'), 405, 'method_not_allowed', 'Static files only support GET and HEAD.');
  const decoded = decodeURIComponent(pathname);
  assertApi(!decoded.includes('\0'), 400, 'invalid_path', 'The requested path is invalid.');
  const requestedPath = decoded === '/' ? 'index.html' : decoded.replace(/^[/\\]+/, '');
  const normalizedRequestedPath = requestedPath.replace(/\\/g, '/').toLowerCase();
  if (requestedPath === RETIRED_ARENA_RULES_PATH) {
    response.writeHead(302, {
      location: PUBLIC_ARENA_RULES_PATH,
      'cache-control': 'no-store'
    });
    response.end();
    return;
  }
  assertApi(isPublicStaticPath(normalizedRequestedPath), 404, 'file_not_found', 'Not found.');
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
    : ['.png', '.svg', '.ico', '.mp3', '.pdf'].includes(extension)
      ? 'public, max-age=86400'
      : 'no-cache';
  const publicNftAsset = requestedPath.replace(/\\/g, '/').startsWith('assets/nft/');
  response.writeHead(200, {
    'content-type': MIME_TYPES[extension] || 'application/octet-stream',
    'cache-control': cacheControl,
    ...(publicNftAsset ? {
      'access-control-allow-origin': '*',
      'cross-origin-resource-policy': 'cross-origin'
    } : {})
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

function isPublicStaticPath(pathname) {
  if (!pathname || pathname.split('/').some((segment) => !segment || segment.startsWith('.'))) return false;
  if (PUBLIC_ROOT_FILES.has(pathname) || PUBLIC_LEGAL_FILES.has(pathname)) return true;
  const extension = extname(pathname);
  if (pathname.startsWith('src/')) return PUBLIC_SOURCE_EXTENSIONS.has(extension);
  if (pathname.startsWith('assets/')) return PUBLIC_ASSET_EXTENSIONS.has(extension);
  if (pathname.startsWith('generated/walletconnect/')) return extension === '.js';
  return false;
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

function enforceSameOrigin(request, configuredOrigin, method = 'GET') {
  const originHeader = request.headers.origin;
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  if (!originHeader) {
    const serverCredential = request.headers['x-matt-admin-key'] || request.headers['x-matt-reward-approver-key'];
    assertApi(!mutation || !configuredOrigin || Boolean(serverCredential), 403, 'origin_required', 'Browser mutations require an exact Origin header.');
    return;
  }
  const expected = requestOrigin(request, configuredOrigin);
  assertApi(normalizeOrigin(originHeader) === expected, 403, 'cross_origin_rejected', 'Cross-origin API requests are not allowed.');
  const fetchSite = String(request.headers['sec-fetch-site'] || '').toLowerCase();
  assertApi(!mutation || !fetchSite || fetchSite === 'same-origin', 403, 'cross_site_mutation_rejected', 'Cross-site browser mutations are not allowed.');
}

function adminCookie(request) {
  const cookies = String(request.headers.cookie || '').split(';').map((value) => value.trim());
  const value = cookies.find((entry) => entry.startsWith('__Host-matt_admin='))?.slice('__Host-matt_admin='.length) || '';
  assertApi(/^[a-f0-9]{64}$/.test(value), 401, 'admin_session_missing', 'Sign in with an authorized Admin wallet.');
  return value;
}

function setAdminCookie(response, token, expiresAt) {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  response.setHeader('set-cookie', `__Host-matt_admin=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`);
}

function clearAdminCookie(response) {
  response.setHeader('set-cookie', '__Host-matt_admin=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
}

function requiresAdminStepUp(path) {
  return /\/suspension$|\/awards$|\/contracts\/prepare$|\/nft-v2\/(economy|phase-xp|maps\/(approve|retire))$|\/rewards\/drafts\/[^/]+\/approve$|\/competition-studio\/[^/]+\/(publish|versions\/[^/]+\/activate)$/.test(path);
}

function bearerToken(request) {
  const authorization = request.headers.authorization;
  assertApi(typeof authorization === 'string' && authorization.startsWith('Bearer '), 401, 'authorization_required', 'A wallet session is required.');
  return authorization.slice('Bearer '.length);
}

function nftService(service) {
  if (!service.nftMetadataService) {
    throw new ApiError(503, 'nft_metadata_disabled', 'NFT metadata is not enabled on this server.');
  }
  return service.nftMetadataService;
}

function sendPublicJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, max-age=30, s-maxage=30, stale-while-revalidate=300',
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin'
  });
  response.end(JSON.stringify(body));
}

function sendPublicImage(request, response, image) {
  if (request.headers['if-none-match'] === image.etag) {
    response.writeHead(304, { etag: image.etag, 'cache-control': 'public, max-age=300' });
    response.end();
    return;
  }
  response.writeHead(200, {
    'content-type': image.contentType,
    'content-length': image.body.length,
    'cache-control': 'public, max-age=300, stale-while-revalidate=3600',
    etag: image.etag,
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin'
  });
  response.end(request.method === 'HEAD' ? undefined : image.body);
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
  const databaseUnavailable = !(error instanceof ApiError) && isTransientPostgresError(error);
  const status = error instanceof ApiError ? error.status : databaseUnavailable ? 503 : 500;
  const code = error instanceof ApiError
    ? error.code
    : databaseUnavailable
      ? 'database_temporarily_unavailable'
      : 'internal_error';
  const message = error instanceof ApiError
    ? error.message
    : databaseUnavailable
      ? 'MATT Mine is reconnecting to its database. Please retry in a moment.'
      : 'The MATT Mine server encountered an unexpected error.';
  if (Number.isFinite(error?.retryAfter)) {
    response.setHeader('retry-after', String(Math.max(1, Math.ceil(error.retryAfter))));
  } else if (status === 429) {
    response.setHeader('retry-after', '60');
  }
  if (databaseUnavailable) {
    response.setHeader('retry-after', '2');
    console.warn('[MATT Mine server] PostgreSQL temporarily unavailable.', error?.code || error?.message || error);
  } else if (!(error instanceof ApiError)) {
    console.error('[MATT Mine server]', error);
  }
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
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; img-src 'self' data: blob: https:; font-src 'self' data: https://fonts.gstatic.com https://fonts.reown.com; connect-src 'self' https://matt-mine.onrender.com https://saigon-testnet.roninchain.com https://ipfs.io https://rpc.walletconnect.com https://rpc.walletconnect.org https://relay.walletconnect.com https://relay.walletconnect.org wss://relay.walletconnect.com wss://relay.walletconnect.org https://pulse.walletconnect.com https://pulse.walletconnect.org https://api.web3modal.com https://api.web3modal.org https://keys.walletconnect.com https://keys.walletconnect.org https://notify.walletconnect.com https://notify.walletconnect.org https://echo.walletconnect.com https://echo.walletconnect.org https://push.walletconnect.com https://push.walletconnect.org wss://www.walletlink.org https://cca-lite.coinbase.com; frame-src 'self' https://verify.walletconnect.com https://verify.walletconnect.org https://secure.walletconnect.com https://secure.walletconnect.org; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
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
      if (current.count >= limit) {
        const error = new ApiError(429, 'rate_limited', 'Too many requests. Try again shortly.');
        error.retryAfter = Math.max(1, Math.ceil((current.resetsAt - timestamp) / 1000));
        throw error;
      }
      current.count += 1;
      if (buckets.size > 5_000) {
        for (const [bucketKey, bucket] of buckets) {
          if (bucket.resetsAt <= timestamp) buckets.delete(bucketKey);
        }
      }
    }
  };
}
