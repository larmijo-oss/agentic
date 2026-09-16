import Fastify from "fastify"
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteGenericInterface, RouteHandlerMethod } from "fastify"
import type { Http2SecureServer, Http2ServerRequest, Http2ServerResponse } from "node:http2"
import { readFileSync } from 'node:fs'       // import function
import type { AddressInfo } from 'node:net'  // import type
import { Agent, type Dispatcher } from 'undici'

import * as handlers from './handlers.js'    // import namespace
import { LlmRunners } from './runners.js'
import { llmprompt, top } from "./handlers.js";
import Database from 'better-sqlite3' 
import type BetterSqlite3 from 'better-sqlite3'



declare module 'fastify' {
    interface FastifyInstance {
        client: Dispatcher        
        logRequest: () => this        
        runners: LlmRunners
	sql: ReturnType<typeof initDB>['sqlStatements']
    }
    interface FastifyRequest {
      clientIP: string;
    }    
}

const HARNESS_DB_PATH = "/home/ubuntu/agentic/harnessd/harnessd.db" as const

export type Http2RouteHandler = RouteHandlerMethod<Http2SecureServer>
export type FastifyHttp2Instance = FastifyInstance<
    Http2SecureServer,
    Http2ServerRequest,
    Http2ServerResponse
>
export type FastifyHttp2Request = FastifyRequest<
    RouteGenericInterface,
    Http2SecureServer,
    Http2ServerRequest
>
export type FastifyHttp2Reply = FastifyReply<
    RouteGenericInterface,
    Http2SecureServer,
    Http2ServerRequest,
    Http2ServerResponse
>
function initDB() {
    const rwdb = new Database(HARNESS_DB_PATH, {
        fileMustExist: true, // SQLite errors out instead of creating a db if it doesn't exist.
    })
    const waldb = new Database(HARNESS_DB_PATH, { // dedicated db connection just for the background worker
        fileMustExist: true, // SQLite errors out instead of creating a db if it doesn't exist.
    })

    // for a 1GB GCP/AWS micro instance running on bare-metal Ubuntu, no containerization.
    rwdb.exec(`
        PRAGMA busy_timeout = 5000; -- 5 secs
        PRAGMA cache_size = -32000; -- 32 MB
        PRAGMA mmap_size = 0;
        PRAGMA synchronous = NORMAL;
        PRAGMA journal_size_limit = 104857600; -- 100 MB
        PRAGMA temp_store = MEMORY;
        PRAGMA wal_autocheckpoint = 0;
    `)

    // a dedicated maintenance connection
    waldb.exec(`
        PRAGMA busy_timeout = 5000; -- 5 secs
        PRAGMA synchronous = NORMAL;
        PRAGMA journal_size_limit = 104857600; -- 100 MB
        PRAGMA wal_autocheckpoint = 0;
    `)

    waloop(waldb)

    // precompiled SQL statements
    const sqlStatements = {
        insertTurn: rwdb.prepare(
            `INSERT INTO turns (appID, prompt) VALUES (?, ?)`
        ),
        updateTurn: rwdb.prepare(
            `UPDATE turns SET completion = NULLIF(?, ''), reasoning = CASE WHEN ? = '' THEN reasoning ELSE COALESCE(reasoning || ' ', '') || ? END WHERE turnID = ?`
        ),
        selectTurns: rwdb.prepare(
            `SELECT turnID, CAST(prompt AS TEXT) AS prompt, reasoning, completion FROM turns WHERE appID = ? ORDER BY turnID ASC`
        ),
    }

    return { rwdb, waldb, sqlStatements }
}
function waloop(waldb: BetterSqlite3.Database) {
    setInterval(() => {
        try {
            // query plan analyzer optimization
            waldb.pragma('optimize=0x10002')

            // PASSIVE reuses flushed WAL blocks, file grows to high-water mark
            // PRAGMA journal_size_limit handles automatic OS file truncation
            waldb.pragma('wal_checkpoint(PASSIVE)')

            // gate incremental vacuum by actual db freelist
            const freePages = waldb.pragma('freelist_count', { simple: true }) as number

            if (freePages > 25600) {
                // 100 MB for HDD, can lower to 20 MB (5120 pages) for SDD
                // reclaim unused pages in batches (of 256) so as not to freeze the db
                waldb.pragma('incremental_vacuum(256)')
            }

        } catch (error) {
            console.error("SQLite checkpointing or optimization failed:", error)
        }
    }, 60000).unref()
    // runs every minute, unref() unlinks this timer from current process:
    // let node.js kill process without waiting for timer to end.
}

try {
    // share a fetch dispatcher to the same destination to avoid
    // subsequent connection establishment handshake
const { rwdb, waldb, sqlStatements } = initDB()
    onShutdown(rwdb, waldb)
    const client = new Agent({
        connect: { timeout: 5_000 }, // dead destination
        headersTimeout: 10_000,      // stalled upstream
        bodyTimeout: 0,              // keep SSE streams open indefinitely
        keepAliveTimeout: 90_000,    // reuse socket for the same destination
    })

    const app = Fastify({
        http2: true,
        https: {
            key: readFileSync("/home/ubuntu/agentic/harnessd.key"),
            cert: readFileSync("/home/ubuntu/agentic/harnessd.crt"),
            allowHTTP1: true,
        },
        routerOptions: {
            ignoreTrailingSlash: true,
        },
        trustProxy: true,            // accept proxy-reported client IP (X-Forwarded-For)
        logger: { level: "error" },  // log only if server crashes
    })
        // log request
        .decorate('logRequest', logRequest)
        .logRequest()
        // add global states
        .decorate('client', client)
        .decorate('runners', new LlmRunners())
        .decorate('sql', sqlStatements)
        // Routes follow
        .post("/llmprompt", handlers.llmprompt)
	.post("/llmchat", handlers.llmchat)
        .post("/", handlers.top)

	app.listen({ host: "0.0.0.0", port: 443 }, (err, addr) => {
        if (err) {
            console.error(err)
            process.exit(1)
        }
        const address = app.server.address() as AddressInfo
        console.log(`harnessd on https://${address.address}:${address.port}`)
    })

} catch (error) {
    console.error(error) 
    process.exit(1) 
}

function logRequest(this: FastifyHttp2Instance) {
  this
    .addHook("onRequest", (request: FastifyHttp2Request, reply: FastifyHttp2Reply, done: any) => {
      request.clientIP = request.ip || request.raw.socket.remoteAddress || "127.0.0.1";
      done();
    })
    .addHook("onResponse", (request: FastifyHttp2Request, reply: FastifyHttp2Reply, done: any) => {
      const time = new Date().toISOString().replace("T", " ").substring(0, 19);
      console.log(
        `${time} [Fastify] | ${reply.statusCode} | ${request.clientIP} | ${request.method} ${request.url} HTTP/${request.raw.httpVersion}`,
      );
      done();
    });

  return this;
}

let isShuttingDown = false  // guard against successive ^C's

function onShutdown(
    rwdb: BetterSqlite3.Database,
    waldb: BetterSqlite3.Database
) {
    const signalHandler = (signal: string | Error, exitCode: number = 0) => {
        if (isShuttingDown) return
        isShuttingDown = true

        // force exit if cleanup below fails
        const cleanupTimeout = setTimeout(() => {
            console.error(`Shutting down ungracefully!`)
            process.exit(1)
        }, 3000)
        cleanupTimeout.unref()

        // cleaning up
        try {
            rwdb.close()    // closes DB (flushes WAL)
            waldb.close()
        } catch (dbErr) {
            console.error(`Error closing dbs: ${dbErr}`)
        } finally {
            clearTimeout(cleanupTimeout)
            process.exit(exitCode)
        }
    }

    // register signal handler with process
    process.on('SIGINT', signalHandler)
    process.on('SIGTERM', signalHandler)

    return
}
