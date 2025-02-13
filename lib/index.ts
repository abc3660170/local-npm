import Fastify, { FastifyInstance, FastifyReply } from "fastify";
import cors from "@fastify/cors";
import proxy from "@fastify/http-proxy";
import path from "path";
import { rmSync, existsSync, mkdirSync } from "fs";
import { ClassicLevel } from "classic-level";
import axiosInstance from "./axiosInstance.js";
import semver from "semver";
import { ModifiedPackument } from "types/index.js";
import findVersion from "./find-version.js";
import { createHash } from "crypto";
import { PackumentVersion } from "@npm/types";

interface Ioptions {
  remote: string;
  port: number;
  from: "npm" | "pelipper"; //npm代表外部网络，pelipper代表内网
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
  const FAT_REMOTE = options.remote;
  const port = options.port;
  const from = options.from || "npm";
  // const levelPort = options.levelPort;
  const localBase = options.url.replace(/:5080$/, ":" + port); // port is configurable
  const directory = path.resolve(options.directory);
  mkdirSync(directory, { recursive: true });
  const fastify = Fastify({
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

  await fastify.register(import("@fastify/compress"));

  // 清除旧数据
  if (existsSync(directory)) {
    rmSync(directory, { recursive: true, force: true });
  }

  const db = new ClassicLevel<string, Record<string, any>>(directory, {
    valueEncoding: "json",
  });
  // fastify.register(import("@fastify/leveldb"), { name: "db", path: directory });

  fastify.log.info("Welcome");
  fastify.log.info("To start using local-npm, just run: ");
  fastify.log.info(`   $ npm set registry ${localBase}`);
  fastify.log.info("To switch back, you can run: ");
  fastify.log.info(`   $ npm set registry ${FAT_REMOTE}`);

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
        reply.status(500).send({
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
      const doc = await getDocument(name);
      const packageMetadata = massageMetadata(localBase, doc);
      const versionMetadata = findVersion(packageMetadata, version);
      if (versionMetadata) {
        cacheResponse(reply, doc._rev);
        return reply.send(versionMetadata);
      }
      return reply.status(404).send({
        error: `version not found:${version}`,
      });
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
      return handleTarball(reply, {
        pkgFullName: name,
        pkgVersion: version,
        from
      });
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
      return handleTarball(reply, {
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
  
  const handleTarball = async (
    reply: FastifyReply,
    options: {
      pkgFullName: string;
      pkgVersion: string;
      from: 'npm' | 'pelipper'
    }
  ) => {
    const { pkgFullName: pkgName, pkgVersion } = options;
    const id = `${pkgName}-${pkgVersion}`;
    const doc = await getDocument(pkgName);
    const versionMeta = doc.versions[pkgVersion];
    const dist = versionMeta?.dist;
    try {
      const buffer = await db.get<string, ArrayBuffer>(id, {
        valueEncoding: "binary",
      });
      const hash = createHash("sha1");
      hash.update(Buffer.from(buffer));
      if (dist?.shasum !== hash.digest("hex")) {
        // 验证防止文件流出现异常，产生垃圾
        return reply.status(500).send({
          error: "tgz哈希值不匹配，不返回结果！",
        });
      } else {
        loggerHit(pkgName, pkgVersion);
        return sendBinary(reply, buffer);
      }
    } catch (error) {
      loggerMiss(pkgName, pkgVersion);
      try {
        const location = await getTarLocation(versionMeta!, options.from);
        const buffer = await downloadTar(id, location);
        return sendBinary(reply, buffer);
      } catch (error) {
        return reply.status(500).send(error);
      }
    }
  };
  
  const loggerHit = (name: string, version: string) => {
    fastify.log.info(`tgz:${name}-${version} is exist!`);
  };
  
  const loggerMiss = (name: string, version: string) => {
    fastify.log.info(`tgz:${name}-${version} is not exist!`);
  };
  
  const getTarLocation = async (versionMeta: PackumentVersion, from: 'npm' | 'pelipper') => {
    if (versionMeta.info && from !== "pelipper") {
      const res = await axiosInstance.get<PackumentVersion>(
        versionMeta.info as string
      );
      return res.data.dist.tarball;
    } else {
      return versionMeta.dist.tarball;
    }
  };
  
  const downloadTar = async (id: string, tarball: string) => {
    try {
      const response = await axiosInstance.get(tarball, {
        responseType: "arraybuffer",
      });
      await db.put(id, response.data, {
        valueEncoding: "binary",
      });
      return response.data;
    } catch (error) {
      throw error;
    }
  };
  
  const sendBinary = (reply: FastifyReply, buffer: ArrayBuffer) => {
    reply.header("Content-Type", "application/octet-stream");
    reply.header("content-length", buffer.byteLength);
    return reply.send(buffer);
  };
  
  const getDocument = async (name: string) => {
    const data = await db.get(name);
    if (data) {
      // 本地库有 packument 数据直接返回
      return data as ModifiedPackument;
    }
  
    // 本地库没有 packument， 从uplink上获取
    const url = `${FAT_REMOTE}/${name}`;
    const res = await axiosInstance.get(url);
    const modifiedPackument: ModifiedPackument = res.data;
    delete modifiedPackument._rev;
    await db.put(name, modifiedPackument);
    return (await db.get(name)) as ModifiedPackument;
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
        delete doc.versions[version];
      } else {
        const versionValue = doc.versions[version];
        if (versionValue) {
          versionValue.dist.tarball =
            urlBase + "/" + "tarballs/" + name + "/" + version + ".tgz";
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
