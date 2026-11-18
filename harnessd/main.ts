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
import { createRequire as createNodeRequire } from 'node:module'

const requireCJS = createNodeRequire(import.meta.url)
const { getExtensionPath } = requireCJS('@sqliteai/sqlite-vector') as {
    getExtensionPath: () => string
}	


declare module 'fastify' {
    interface FastifyInstance {
        client: Dispatcher        
        logRequest: () => this        
        runners: LlmRunners
	snapshotDirty: { value: boolean } // whether to rerun vector_quantize()
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
function initDB(vectorDim: number) {
    const rwdb = new Database(HARNESS_DB_PATH, {
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
	PRAGMA read_uncommitted = TRUE;
    `)

    // a dedicated maintenance connection
  
    let vectorOptions: string | null = null
    if (vectorDim > 0) {
        vectorOptions = `type=FLOAT32,dimension=${vectorDim},distance=COSINE,normalized=1,qtype=TURBO,qbits=4`
        try {
            const extensionPath = getExtensionPath()
            rwdb.loadExtension(extensionPath)
            rwdb.prepare(`SELECT vector_init('turns','embedding', ?)`).get(vectorOptions)
        } catch (error) {
            // a connection that cannot be registered must not be used:
            // recall would fail later at query time, silently
            console.error("sqlite-vector unavailable, semantic recall disabled:", error)
            vectorOptions = null
        }
    }
    // precompiled SQL statements
    const sqlStatements = {
        insertTurn: rwdb.prepare(
            `INSERT INTO turns (appID, prompt) VALUES (?, ?)`
        ),
        selectTurnSizes: rwdb.prepare(
            `SELECT turnID, length(prompt) + COALESCE(length(reasoning), 0) + COALESCE(length(completion), 0) AS bytes FROM turns WHERE appID = ? AND turnID >= ? AND (turnID = ? OR completed = 1) ORDER BY turnID ASC`
        ),
        selectTurnsByID: rwdb.prepare(
            `SELECT turnID, prompt, reasoning, completion FROM turns WHERE turnID IN (SELECT value FROM json_each(?)) ORDER BY turnID ASC`
        ),
        // updated updateTurn to include summary
        updateTurn: rwdb.prepare(
            `UPDATE turns SET completion = NULLIF(?, ''), summary = NULLIF(?, ''), reasoning = NULLIF(?, ''), completed = ? WHERE turnID = ?`
        ),
        updateDegrade: rwdb.prepare(
            `UPDATE turns SET completed = 0 WHERE turnID = ?`
        ),
        recallGate: rwdb.prepare(
            `WITH last AS (
                 SELECT turnID, ROW_NUMBER() OVER (ORDER BY turnID DESC) AS rn
                 FROM turns WHERE appID = ? AND completed = 1 ORDER BY turnID DESC LIMIT ?
             )
             SELECT COUNT(*) AS count, COALESCE(MIN(CASE WHEN rn <= ? THEN turnID END), 0) AS scanFloor FROM last`
        ),
        hydrateRecall: rwdb.prepare(
            `SELECT turnID, prompt FROM turns WHERE turnID IN (SELECT value FROM json_each(?))`
        ),
        updateEmbedding: rwdb.prepare(
            `UPDATE turns SET embedding= ? WHERE turnID = ?`
        ),
        // selectVectorLeg is prepared only when vector_init succeeded
        recall: vectorOptions === null ? null : {
            selectVectorLeg: rwdb.prepare(
                `SELECT v.rowid AS rowid
                 FROM vector_quantize_scan('turns','embedding', ?) AS v
                 JOIN turns t ON t.turnID = v.rowid
                 WHERE t.appID = ? AND t.turnID < ?
                 ORDER BY v.distance
                 LIMIT ?`
            ),
        },
    }

    return { rwdb, sqlStatements }
}
function waloop(db: BetterSqlite3.Database, vectorEnabled: boolean, snapshotDirty: { value: boolean }) {
	 // one maintenance job per call; best-effort: a failed statement logs under
    // its label and the tick carries on — every job retries next tick
    function swept(label: string, run:() => unknown) {
        try { run() } catch (error) { console.error(`${label} failed:`, error) }
    } 
    // prepared SQL statement to rebuild sqlite-vector's internal table
    const quantize = vectorEnabled
        ? db.prepare(`SELECT vector_quantize('turns','embedding', ?)`)
        : null
    // startup rebuild is unconditional: embeddings that landed after the
    // previous process exited must enter the first snapshot; later rebuilds
    // only fire if new embedding has been added since the last run
    if (quantize) rebuildVectorSnapshot(quantize, snapshotDirty)

    // prepared stream-end janitor SQL statement: past the grace window, completed = NULL can only

    // included in semantic memory)
    const janitor = db.prepare(
        `UPDATE turns SET completed = 0 WHERE completed IS NULL AND prompt_ts < unixepoch() - 600`
    )
    setInterval(() => {
        if (quantize) rebuildVectorSnapshot(quantize, snapshotDirty)

        // abandoned turns check
        swept('turn janitor sweep', () => janitor.run())

        // query plan analyzer optimization
        swept('PRAGMA optimize', () => db.pragma('optimize=0x10002'))

        // PASSIVE reuses flushed WAL blocks, file grows to high-water mark 
        // PRAGMA journal_size_limit handles automatic OS file truncation
        swept('WAL PASSIVE checkpoint', () => db.pragma('wal_checkpoint(PASSIVE)'))

        swept('PRAGMA freelist_count', () => {
            // gate incremental vacuum by actual db freelist
            const freePages = db.pragma('freelist_count', { simple: true }) as number

            if (freePages > 6400) {
                // 100 MB for HDD, can lower to 20 MB for SSD
                // reclaim unused pages in batches (of 64) so as not to freeze the db
                db.pragma('incremental_vacuum(64)')
            }
        })
    }, 60000).unref()
    // runs every minute, unref() unlinks this timer from current process:
    // let node.js kill process without waiting for timer to end.
}

function rebuildVectorSnapshot(quantize: BetterSqlite3.Statement, dirty: { value: boolean }) {
    if (!dirty.value) return
    dirty.value = false
    try {
        quantize.get('qtype=TURBO,qbits=4')
    } catch (error) {
        dirty.value = true
        console.error("vector_quantize failed:", error)
    }
}

try {
    // share a fetch dispatcher to the same destination to avoid
    // subsequent connection establishment handshake
    const runners = new LlmRunners()
    await runners.loadEmbed()
    const { rwdb, sqlStatements } = initDB(runners.embed?.dim ?? 0)

    const snapshotDirty = { value: true }
    waloop(rwdb, sqlStatements.recall !== null, snapshotDirty)
    onShutdown(rwdb)
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
         .decorate('runners', runners)
        .decorate('snapshotDirty', snapshotDirty)
        .decorate('sql', sqlStatements)
        // Routes follow
        .post("/llmprompt", handlers.llmprompt)
	.post("/llmsearch", handlers.llmsearch)
       

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

async function onShutdown(rwdb: BetterSqlite3.Database) {
    const signalHandler = async (signal: string | Error, exitCode: number = 0) => {
        if (isShuttingDown) return
        isShuttingDown = true

        // force exit if cleanup below fails
        const cleanupTimeout = setTimeout(() => {
            console.error(`Shutting down ungracefully!`)
            process.exit(1)
        }, 3000)
        cleanupTimeout.unref()

	await handlers.drainEmbeds(5_000)
    

        // cleaning up
        try {
            rwdb.close()    // closes DB (flushes WAL)

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
