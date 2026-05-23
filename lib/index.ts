import Fastify, { FastifyInstance, FastifyReply } from "fastify";
import cors from "@fastify/cors";
import proxy from "@fastify/http-proxy";
import path from "path";
import { mkdirSync } from "fs";
import { ClassicLevel } from "classic-level";
import axiosInstance from "./axiosInstance.js";
import semver from "semver";
import { ModifiedPackument } from "types/index.js";
import findVersion from "./find-version.js";
import { createHash } from "crypto";
import { PackumentVersion } from "@npm/types";

// in-flight 请求合并：同一 key 的并发请求共用一个 Promise
function makeInFlight<T>() {
  const pending = new Map<string, Promise<T>>();
  return (key: string, fn: () => Promise<T>): Promise<T> => {
    const existing = pending.get(key);
    if (existing) return existing;
    const p = Promise.resolve()
      .then(fn)
      .finally(() => pending.delete(key));
    pending.set(key, p);
    return p;
  };
}

interface Ioptions {
  remote: string;
  port: number;
  from: "npmjs" | "pelipper"; //npm代表外部网络，pelipper代表内网
  method: "pull" | "push";
  // levelPort: number;
  directory: string;
  url: string;
  logLevel: string;
}



const start = (fastify: FastifyInstance, options: Ioptions) => {
  const FAT_REMOTE = options.remote;
  const port = options.port;
  // const levelPort = options.levelPort;
  const localBase = options.url.replace(/:5080$/, ":" + port); // port is configurable
  fastify.log.info("Welcome");
  fastify.log.info("To start using local-npm, just run: ");
  fastify.log.info(`   $ npm set registry ${localBase}`);
  fastify.log.info("To switch back, you can run: ");
  fastify.log.info(`   $ npm set registry ${FAT_REMOTE}`);
  return new Promise<string>((resolve, reject) => {
    fastify.listen({ port, host: "0.0.0.0" }, (error, address) => {
      if(error) return reject(error);
        resolve(address);
    });
  })
}

export default async (
  options: Ioptions,
) => {
  const from = options.from || "npmjs";
  const noUplink = from === "pelipper" && options.method === 'push';
  const FAT_REMOTE = noUplink ? 'http://127.0.0.1' : options.remote;
  const port = options.port;
  
  // const levelPort = options.levelPort;
  const localBase = options.url.replace(/:5080$/, ":" + port); // port is configurable
  const directory = path.resolve(options.directory);
  mkdirSync(directory, { recursive: true });
  const fastify = Fastify({
    requestTimeout: 0,
    keepAliveTimeout: 0,
    connectionTimeout: 0,
    disableRequestLogging: true,
    logger: {
      level: options.logLevel,
      transport: {
        target: "pino-pretty", // 使用 pino-pretty 格式化输出
        options: {
          colorize: true, // 彩色输出
          translateTime: true, // 显示时间
          ignore: "pid,hostname,reqId", // 忽略特定字段
        },
      },
    },
  });
  await fastify.register(cors);

  await fastify.register(import("@fastify/compress"), { global: false});

  // 清除旧数据
  // if (existsSync(directory)) {
  //   rmSync(directory, { recursive: true, force: true });
  // }

  const db = new ClassicLevel<string, Record<string, any>>(directory, {
    valueEncoding: "json",
  });

  // 同名 manifest / 同 id tarball 的并发请求共享结果，避免 N 个并发触发 N 次上游下载 + 写竞争
  const inFlightDoc = makeInFlight<ModifiedPackument>();
  const inFlightTar = makeInFlight<ArrayBuffer>();
  // fastify.register(import("@fastify/leveldb"), { name: "db", path: directory });

  // fastify.log.info("Welcome");
  // fastify.log.info("To start using local-npm, just run: ");
  // fastify.log.info(`   $ npm set registry ${localBase}`);
  // fastify.log.info("To switch back, you can run: ");
  // fastify.log.info(`   $ npm set registry ${FAT_REMOTE}`);

  fastify.get("/", (_, res) => {
    res.send("welcome");
  });

  fastify.register(proxy, {
    upstream: FAT_REMOTE,
    prefix: "/-/", // optional
    http2: false, // optional
    httpMethods: ["GET"],
  });

  fastify.get<{
    Params: {
      name: string;
    };
  }>(
    "/:name",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { name } = request.params;
      try {
        const doc = await getDocument(name);
        return reply.send(massageMetadata(localBase, doc));
      } catch (error) {
        return reply.status(500).send({
          error,
        });
      }
    }
  );

  fastify.get<{
    Params: {
      name: string;
      version: string;
    };
  }>(
    "/:name/:version",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            name: { type: "string" },
            version: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, version } = request.params;
      request.log.debug(`请求的包信息：${name}:${version}`);
      try {
        const doc = await getDocument(name);
        const packageMetadata = massageMetadata(localBase, doc);
        const versionMetadata = findVersion(packageMetadata, version);
        if (versionMetadata) {
          request.log.debug(`找到的版本信息：${name}:${version}`);
          cacheResponse(reply, doc._rev);
          return reply.send(versionMetadata);
        }
        return reply.status(404).send({
          error: `version not found:${version}`,
        });
      } catch (error) {
        return reply.status(500).send({
          error,
        });
      }
      
    }
  );

  fastify.get<{
    Params: {
      name: string;
      version: string;
    };
  }>(
    "/tarballs/:name/:version.tgz",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            name: { type: "string" },
            version: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, version } = request.params;
      handleTarball(reply, {
        pkgFullName: name,
        pkgVersion: version,
        from
      });
      return reply;
    }
  );

  fastify.get<{
    Params: {
      name: string;
      version: string;
      user: string;
    };
  }>(
    "/tarballs/:user/:name/:version.tgz",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            user: { type: "string" },
            name: { type: "string" },
            version: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, version, user } = request.params;
      return await handleTarball(reply, {
        pkgFullName: `${user}/${name}`,
        pkgVersion: version,
        from
      });
    }
  );

  fastify.register(proxy, {
    upstream: FAT_REMOTE,
    prefix: "/", // optional
    http2: false, // optional
    httpMethods: ["PUT"],
  });
  
  const safeError = (reply: FastifyReply, error: any) => {
    if (reply.sent) {
      fastify.log.warn(`error after reply sent: ${error?.message ?? error}`);
      return reply;
    }
    return reply.status(500).send(error);
  };

  const handleTarball = async (
    reply: FastifyReply,
    options: {
      pkgFullName: string;
      pkgVersion: string;
      from: 'npmjs' | 'pelipper'
    }
  ) => {
    const { pkgFullName: pkgName, pkgVersion } = options;
    const id = `${pkgName}-${pkgVersion}`;
    let versionMeta: PackumentVersion | undefined;

    try {
      const doc = await getDocument(pkgName);
      versionMeta = doc.versions[pkgVersion];
      if (!versionMeta) {
        return reply.status(404).send({
          error: `version not found: ${pkgVersion}`,
        });
      }
    } catch (error) {
      return safeError(reply, error);
    }

    const dist = versionMeta.dist;

    // 先查缓存
    try {
      const buffer = await db.get<string, ArrayBuffer>(id, {
        valueEncoding: "binary",
      });
      const actual = createHash("sha1").update(Buffer.from(buffer)).digest("hex");
      if (dist?.shasum && dist.shasum !== actual) {
        // 缓存里是坏数据（上一次写入了垃圾），清掉走重新下载，不再直接 500
        fastify.log.warn(`cached tgz shasum mismatch, refetching: ${id}`);
        await db.del(id).catch(() => {});
      } else {
        loggerHit(pkgName, pkgVersion);
        sendBinary(reply, buffer);
        return reply;
      }
    } catch (_e) {
      // LEVEL_NOT_FOUND -- 走下载流程
    }

    loggerMiss(pkgName, pkgVersion);
    if (noUplink) {
      const errorMsg = `内网竟然没有这个包：${pkgName}@${pkgVersion}`;
      fastify.log.error(errorMsg);
      return reply.status(404).send({ error: errorMsg });
    }

    try {
      const location = await getTarLocation(versionMeta, options.from);
      const buffer = await downloadTar(id, location, dist?.shasum);
      if (!reply.sent) sendBinary(reply, buffer);
      return reply;
    } catch (error) {
      return safeError(reply, error);
    }
  };
  
  const loggerHit = (name: string, version: string) => {
    fastify.log.info(`tgz:${name}-${version} is exist!`);
  };
  
  const loggerMiss = (name: string, version: string) => {
    fastify.log.info(`tgz:${name}-${version} is not exist!`);
  };
  
  const getTarLocation = async (versionMeta: PackumentVersion, from: 'npmjs' | 'pelipper') => {
    if (versionMeta.info && from !== "pelipper") {
      const res = await axiosInstance.get<PackumentVersion>(
        versionMeta.info as string
      );
      return res.data.dist.tarball;
    } else {
      return versionMeta.dist.tarball;
    }
  };
  
  // 严格校验：空 body / shasum 不匹配都不落盘；同 id 并发请求合并为一次下载
  const downloadTar = async (
    id: string,
    tarball: string,
    expectedShasum?: string
  ): Promise<ArrayBuffer> => {
    return inFlightTar(id, async () => {
      const response = await axiosInstance.get(tarball, {
        responseType: "arraybuffer",
      });
      const buf = response.data as ArrayBuffer;
      if (!buf || buf.byteLength === 0) {
        throw new Error(`empty body from upstream for ${tarball}`);
      }
      if (expectedShasum) {
        const actual = createHash("sha1").update(Buffer.from(buf)).digest("hex");
        if (actual !== expectedShasum) {
          throw new Error(
            `shasum mismatch for ${id}: expected ${expectedShasum} got ${actual}`
          );
        }
      }
      await db.put(id, buf, { valueEncoding: "binary" });
      fastify.log.debug(`下载并入库了包：${id}`);
      return buf;
    });
  };
  
  const sendBinary = (reply: FastifyReply, buffer: ArrayBuffer) => {
    reply.header("Content-Type", "application/octet-stream");
    reply.header("content-length", buffer.byteLength);
    reply.send(buffer);
  };
  
  // 同名 manifest 并发请求合并为一次，避免雪崩
  const getDocument = async (name: string): Promise<ModifiedPackument> => {
    return inFlightDoc(name, async () => {
      try {
        const data = await db.get(name);
        fastify.log.debug(`从本地库获取到包信息：${name}`);
        return data as ModifiedPackument;
      } catch (error: any) {
        if (error?.code === "LEVEL_NOT_FOUND" && !noUplink) {
          const url = `${FAT_REMOTE}/${name}`;
          const res = await axiosInstance.get(url);
          const modifiedPackument: ModifiedPackument = res.data;
          delete modifiedPackument._rev;
          await db.put(name, modifiedPackument);
          fastify.log.debug(`从上游成功入库了包信息：${name}`);
          return modifiedPackument;
        }
        fastify.log.error(`这是内网不应该没这个包信息：${name}`);
        throw error;
      }
    });
  };
  
  const cacheResponse = (reply: FastifyReply, etag: string | undefined) => {
    // do this to be more like registry.npmjs.com. not sure if it
    // actually has a benefit, though
    reply.header("ETag", '"' + etag + '"');
    reply.header("Cache-Control", "max-age=300");
  };
  
  /**
   * 本地化 npmjs包 的一些字段
   * @param urlBase
   * @param doc
   * @returns
   */
  const massageMetadata = (urlBase: string, doc: ModifiedPackument) => {
    var name = doc.name;
    var versions = Object.keys(doc.versions);
    for (var i = 0, len = versions.length; i < len; i++) {
      const version = versions[i]!;
      if (!semver.valid(version)) {
        // apparently some npm modules like handlebars
        // have invalid semver ranges, and npm deletes them
        // on-the-fly
        fastify.log.warn(`这是一个无效版本: ${name}@${version}`);
        delete doc.versions[version];
      } else {
        const versionValue = doc.versions[version];
        if (versionValue) {
          const tgzUrl = urlBase + "/" + "tarballs/" + name + "/" + version + ".tgz";
          versionValue.dist.tarball = tgzUrl;
          // versionValue.dist['info'] = urlBase + "/" + name + "/" + version;
          versionValue["info"] = urlBase + "/" + name + "/" + version;
        }
      }
    }
    return doc;
  };

  return {
    server: fastify,
    start: async () => {
      return await start(fastify, options)
    },
    shutdown: async () => {
      await fastify.close()
    },
  };
};


// fastify.register(require('@fastify/static'), {
//     root: path.join(__dirname, 'public'),
//     prefix: '/public/', // optional: default '/'
// })
