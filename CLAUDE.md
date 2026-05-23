# CLAUDE.md

给后续 Claude Code 会话用的工程说明（**当前分支：`2.x`，但里面装的是 3.x 源码**）。

## 这是什么

`fee-local-npm@3.0.8` —— Fastify + TypeScript 重写的本地 npm 代理。让 `npm install` 走本地缓存：
- manifest + tarball 都存到**同一个** classic-level 实例（`./db`）
- 客户端 cache miss 时回上游（默认 `registry.npmjs.org`）拉一次，落本地，后续走缓存

是 `master` 分支上 2.x CommonJS 版本的彻底重写。entei 项目（`@fee/entei`）依赖的就是这个 3.x 包。

## ⚠️ 分支命名陷阱（最容易踩的坑）

| 分支 | package.json 版本 | 实际代码架构 |
|---|---|---|
| `master` | 2.2.x | **2.x**：CommonJS + Express + PouchDB + Webpack UI |
| `2.x`（当前分支） | 3.0.x | **3.x**：ESM + Fastify + classic-level + TS + Rollup |

**分支名和版本号是反的，是历史遗留**。改 3.x 代码请在 `2.x` 分支上做，不要被名字迷惑去 master。

两个分支不要互相 cherry-pick —— 架构差异太大，函数名、文件结构、模块系统都不一样。

## 架构核心（`lib/index.ts`）

核心函数（中文路由的注释和日志保留，方便排错）：

| 函数 | 作用 |
|---|---|
| `getDocument(name)` | manifest 查询：local-first，未命中且非 noUplink 模式则回上游 + 入库。**有 in-flight 去重** |
| `handleTarball(reply, {pkgFullName, pkgVersion, from})` | tgz 路由主入口：查 manifest → 查缓存（带 sha1 校验，坏数据自愈）→ miss 则下载 |
| `downloadTar(id, tarball, expectedShasum?)` | 上游 tgz 下载：**空 body 拒、shasum 校验、in-flight 去重**，全通过才落盘 |
| `getTarLocation(versionMeta, from)` | 解析真实 tgz URL：`from === 'pelipper'` 时直接用 dist.tarball，否则走 dist.info 二跳 |
| `massageMetadata(urlBase, doc)` | 改写 `dist.tarball` 指向本地；用 `semver.valid()` 清掉非法 version |
| `safeError(reply, error)` | 用 `reply.sent` 守卫，已发响应时只记日志，避免 "reply already sent" |

**路由表**（fastify）：
- `GET /-/*` → proxy 给 FAT_REMOTE（npm 的元数据路径）
- `GET /:name` → manifest
- `GET /:name/:version` → 特定 version metadata
- `GET /tarballs/:name/:version.tgz` → tgz
- `GET /tarballs/:user/:name/:version.tgz` → scoped tgz
- `PUT /*` → proxy 给 FAT_REMOTE（npm publish）

## 上游请求（`lib/axiosInstance.ts`）

所有调用上游都走这个共享 axios 实例：

- **重试拦截器**：网络错误 / 5xx / 408 / 429 → 指数退避 300ms / 600ms / 1200ms，最多 3 次
- 4xx（除 408/429）直接返回，不重试（避免对真 404 浪费上游配额）
- **共享 keep-alive 连接池**：`http.Agent` + `https.Agent`，`maxSockets: 64`
- timeout 60s

配合 `getDocument` / `downloadTar` 的 in-flight 去重，**一次重试可惠及 N 个并发客户端**。

## 跑起来

```bash
npm install                                        # 必须装：rollup / tsup 都在 devDeps
npm run dev                                        # nodemon + ts-node 直接跑 src/dev.ts (默认 18000)
npm run build                                      # rollup → dist/index.js + tsup → dist/index.d.ts + sourcemap
npm start                                          # 生产入口：bin/index.js 从 dist/index.js 加载
node ./bin/index.js -p 5080 -r https://registry.npmjs.org -d ./db -u http://127.0.0.1:5080
```

CLI 参数（`bin/index.js`，commander）：
- `-p, --port` 主端口（默认 18000）
- `-r, --remote` 上游 registry（默认 npmjs.org）
- `-u, --url` 对外暴露 URL（影响 tarball 链接改写）
- `-d, --directory` 数据存储目录（默认 `./db`）
- `-l, --log-level` 日志级别（默认 `debug`）

## 设计要点（容易踩的坑）

### dist/ 不入 git 但要入 npm tarball
- `.gitignore` 包含 `dist`
- `package.json` `files: ["dist", "bin"]` 把 dist 打进发布包
- **结论：每次发布前必须 `npm run build`**，否则发出去的包没有 `dist/index.js`，安装方启动会挂

### 缓存命中也要校验 shasum
`handleTarball` 拿到 cached buffer 后会用 `dist.shasum` 验一下，不匹配则 `db.del(id)` 清掉走重新下载流程 —— 上一版本可能因为上游错误返回写入了坏数据，**不直接 500 卡死**。

### in-flight Map 是闭包内实例
`inFlightDoc` / `inFlightTar` 是在 `default export` 工厂函数里 `new Map`，所以**每个 `localNpm()` 实例独立**。测试里多次创建实例不会互相影响，但生产环境一个进程通常只有一个实例。

### `from === 'pelipper'` + `method === 'push'` = noUplink 模式
`lib/index.ts:49` 的 `noUplink` 标志会改变两个行为：
- `getDocument` 本地没有就直接抛错，不回上游
- `handleTarball` 本地没缓存直接 404，不下载

给 entei 的"内网推送"场景用。普通使用不要传 `from: 'pelipper'`。

### `db` 是单 classic-level，key 命名共用
| key 形态 | 内容 |
|---|---|
| `${name}` 或 `${user}/${name}` | manifest（packument JSON） |
| `${name}-${version}` | tgz buffer（valueEncoding: 'binary'） |
| `${user}/${name}-${version}` | scoped tgz buffer |

写代码注意 key 不要冲撞（虽然现有命名约定下不会撞）。

### TypeScript 严格模式
`tsconfig.json` 开了 `strictNullChecks` + `noUncheckedIndexedAccess` + `noImplicitAny`。访问数组/对象索引要先判空，否则编译不过。

### `src/dev.ts` 缺 `method` 参数（预存警告）
rollup 编译时会报 `src/dev.ts:4:34 ... Property 'method' is missing`。这是历史遗留，dev 模式仍可跑，不影响生产构建。

### npm install 不会请求跨平台 optionalDeps
**npm 客户端行为**（不是 local-npm bug）：碰到平台不匹配的 `optionalDependencies`（如 Mac 上装 `@swc/core-linux-x64-gnu`）会完全跳过，manifest / tarball 都不请求。

要让 local-npm 缓存到这些跨平台包，必须用 `npm pack <pkg>@<version>` 手动触发（pack 不检查 os/cpu）。entei 的 `packages/server/src/sync/multiArch.ts` 就是这个套路。

## 测试

**没有真实测试套件** —— `test/fixtures/` 有数据，但 `test/*.js` 都是 2.x 时代的，不适用于 3.x。

冒烟方法：
```bash
node -e "
import('./dist/index.js').then(async ({ default: localNpm }) => {
  const { start, shutdown } = await localNpm({
    port: 18001, logLevel: 'warn', remote: 'https://registry.npmjs.org',
    from: 'npmjs', method: 'pull', directory: './.smoke-db', url: 'http://127.0.0.1:18001'
  });
  await start();
  console.log('OK');
  await shutdown();
  process.exit(0);
});
"
```

并发场景验证推荐用 `ab` / `wrk` 同时请求同一包多次，观察上游请求次数（应该被 in-flight 合并到 1 次）。

## 重要文件位置

| 文件 | 角色 |
|---|---|
| `bin/index.js` | 生产 CLI 入口（commander），从 `dist/index.js` 加载 |
| `src/dev.ts` | 开发入口，ts-node 直接跑 `lib/index.ts` |
| `lib/index.ts` | 主程序：fastify 路由、缓存、下载、上游 fallback |
| `lib/axiosInstance.ts` | 共享 axios（连接池 + 重试拦截器） |
| `lib/find-version.ts` | semver 解析（'latest' / range / exact） |
| `rollup.config.js` | rollup 编译 → `dist/index.js` |
| `tsconfig.json` | TS 严格模式配置 |
| `types/index.d.ts` | `ModifiedPackument` 等共享类型 |

## 发布流程

```bash
# 1. 改代码
# 2. 必须先 build
npm run build
# 3. 提交
git add lib/ && git commit -m "fix: ..."
# 4. bump 版本（patch / minor / major）
npm version patch -m "%s"
# 5. 发到私仓
npm publish --registry http://10.1.230.100:1414
# 6. 推 git
git push origin 2.x && git push origin v3.0.x
```

⚠️ **不要发到 registry.npmjs.org**：
- npmjs.org 上 `fee-local-npm` 的 maintainer 是 `abc3660170`（不是你）
- npmjs.org 的 latest 由这个 fork 占据，**乱发会影响所有走公网的用户**
- 私仓 `http://10.1.230.100:1414` 是唯一发布目标

## 非目标提醒

- ❌ 不要 cherry-pick `master` 分支（2.x CommonJS）的补丁到这里，必须按 3.x 架构重写
- ❌ 不要把 `dist/` 提交进 git
- ❌ 不要忘记 `npm run build` 就发布
- ❌ 不要发到 `registry.npmjs.org`
- ❌ 不要在这个分支上跑 2.x 的 `npm test`（fixtures 不匹配，会乱）
