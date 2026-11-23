#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostAgent } from './agent.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultWebDist = path.resolve(__dirname, '../../../apps/web/dist');
const defaultConfigPath = path.join(os.homedir(), '.remote-deck', 'agent.json');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) out.lanPort = Number(argv[++i]);
    else if (arg === '--relay' && argv[i + 1]) out.relayUrl = argv[++i];
    else if (arg === '--relay-secret' && argv[i + 1]) out.relaySecret = argv[++i];
    else if (arg === '--name' && argv[i + 1]) out.deviceName = argv[++i];
    else if (arg === '--pin' && argv[i + 1]) out.pin = argv[++i];
    else if (arg === '--tunnel') out.quickTunnel = true;
    else if (arg === '--view-only') out.viewOnly = true;
    else if (arg === '--config' && argv[i + 1]) out.configPath = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const agent = new HostAgent({
  lanPort: args.lanPort ?? Number(process.env.AGENT_PORT || 9601),
  relayUrl: args.relayUrl ?? process.env.RELAY_URL ?? '',
  relaySecret: args.relaySecret ?? process.env.RELAY_SECRET ?? '',
  deviceName: args.deviceName ?? process.env.DEVICE_NAME,
  pin: args.pin ?? process.env.DEVICE_PIN,
  quickTunnel: args.quickTunnel ?? process.env.QUICK_TUNNEL === '1',
  configPath: args.configPath ?? defaultConfigPath,
  webDistDir: defaultWebDist,
  permissions: args.viewOnly
    ? { view: true, control: false, terminal: false, files: false }
    : undefined,
});

const info = await agent.start();

console.log('====================================================');
console.log(' RemoteDeck Host Agent Ready');
console.log('----------------------------------------------------');
console.log(` Device Name : ${info.deviceName}`);
console.log(` Device ID   : ${info.deviceId}`);
console.log(` Pairing PIN : ${info.pin}`);
console.log(` Displays    : ${info.displays.map((d) => `${d.width}x${d.height}`).join(', ')}`);
for (const ep of info.lanEndpoints) {
  const tag = ep.kind === 'tailscale' ? 'Tailscale' : 'LAN';
  console.log(` ${tag.padEnd(11)} : ${ep.httpUrl}`);
}
if (agent.relayUrl) {
  console.log(` Relay       : ${agent.relayUrl}`);
}
if (agent.enableQuickTunnel) {
  console.log(' QuickTunnel : starting cloudflared...');
}
console.log('====================================================');

const shutdown = async () => {
  await agent.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
