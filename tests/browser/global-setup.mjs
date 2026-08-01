import { spawn } from 'node:child_process';
import { once } from 'node:events';

export default async function globalSetup() {
  const server = spawn(process.execPath, ['scripts/dev-server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: 'ignore',
    windowsHide: true
  });
  await waitForServer(server);
  return async () => {
    if (server.exitCode !== null) return;
    server.kill('SIGTERM');
    await Promise.race([
      once(server, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 2_000))
    ]);
    if (server.exitCode === null) server.kill('SIGKILL');
  };
}

async function waitForServer(server) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Browser test server exited with code ${server.exitCode}.`);
    try {
      const response = await fetch('http://127.0.0.1:4173/api/live');
      if (response.ok) return;
    } catch {
      // Startup is intentionally polled without treating connection refusal as
      // a failure until the bounded deadline expires.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  server.kill('SIGKILL');
  throw new Error('Browser test server did not become live within 60 seconds.');
}
