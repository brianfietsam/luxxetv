'use strict';
// Headless mode: `npm run serve`. Data dir can be overridden with LUXXETV_DATA, port with PORT.
const path = require('path');
const os = require('os');
const { start } = require('./index');

const dataDir = process.env.LUXXETV_DATA || path.join(process.env.APPDATA || os.homedir(), 'LuxxeTV');
start({ dataDir, port: process.env.PORT ? +process.env.PORT : undefined }).then((s) => {
  console.log(`LuxxeTV listening on port ${s.port}  (data: ${dataDir})`);
  const nets = Object.values(os.networkInterfaces()).flat().filter((n) => n.family === 'IPv4' && !n.internal);
  nets.forEach((n) => console.log(`  http://${n.address}:${s.port}/`));
  const quit = async () => { await s.shutdown(); process.exit(0); };
  process.on('SIGINT', quit); process.on('SIGTERM', quit);
}).catch((e) => { console.error(e); process.exit(1); });
