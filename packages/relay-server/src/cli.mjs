#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelayServer } from './server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultWebDist = path.resolve(__dirname, '../../../apps/web/dist');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) out.port = Number(argv[++i]);
    else if (arg === '--host' && argv[i + 1]) out.host = argv[++i];
    else if (arg === '--secret' && argv[i + 1]) out.relaySecret = argv[++i];
    else if (arg === '--web-dist' && argv[i + 1]) out.webDistDir = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const port = args.port ?? Number(process.env.RELAY_PORT || 9600);
const host = args.host ?? process.env.RELAY_HOST ?? '0.0.0.0';
const relaySecret = args.relaySecret ?? process.env.RELAY_SECRET ?? '';
const webDistDir = args.webDistDir ?? process.env.WEB_DIST_DIR ?? defaultWebDist;

const server = createRelayServer({ port, host, relaySecret, webDistDir });
const bound = await server.start();
console.log(`[RemoteDeck Relay] Listening on http://${bound.host}:${bound.port}`);
console.log(`[RemoteDeck Relay] Web UI root: ${webDistDir}`);

const shutdown = async () => {
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
