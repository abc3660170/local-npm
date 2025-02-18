#!/usr/bin/env ts-node
import localNpm from "../lib/index.js";

const { start } = await localNpm({
    port: 18000,
    logLevel: 'debug',
    remote: 'https://registry.npmjs.org',
    from: 'npm',
    directory: './db',
    url: "http://192.168.2.99:18000"
});

try {
  const addr = await start()
  console.log(`启动成功：${addr}`)
} catch (error) {
  console.log('启动失败',error)
}
