#!/usr/bin/env ts-node
import localNpm from "../dist/index.js";
import { Command }  from "commander";
import packageJson from "../package.json" assert  { type: "json" };

const program = new Command();
program
  .version(packageJson.version)
  .option('-p, --port [port]', 'The port to run local-npm on', '18000')
  .option('-l, --log-level [level]', 'The level to log information to the console from local-npm', 'debug')
  .option('-r, --remote [url]', 'The registry to fallback information gathering and tars on', 'https://registry.npmjs.org')
  .option('-rs, --remote-skim [url]', 'The remote skimdb to sync couchdb information from', 'https://replicate.npmjs.com')
  .option('-u, --url [url]', 'The default access url that local-npm will be hosted on', 'http://0.0.0.0:5080')
  .option('-d, --directory [directory]', 'directory to store data', './db')
  .parse(process.argv);

const options = program.opts();

const { start } = await localNpm({
    port: options.port,
    levelPort: options.port,
    logLevel: options.logLevel,
    remote: options.remote,
    url: options.url,
    from: 'npmjs',
    directory: options.directory
});

try {
  const addr = await start()
  console.log(`启动成功：${addr}`)
} catch (error) {
  console.log('启动失败',error)
}
