#!/usr/bin/env ts-node
import localNpm from "../lib/index.js";

const { start } = await localNpm({
    port: 18000,
    logLevel: 'debug',
    remote: 'https://registry.npmjs.org',
    from: 'npm',
    directory: './db',
    url: ""
});

try {
  const addr = await start()
  console.log(`启动成功：${addr}`)
} catch (error) {
  console.log('启动失败',error)
}
