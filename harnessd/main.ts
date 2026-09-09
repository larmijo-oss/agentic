import Fastify from "fastify"
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteGenericInterface, RouteHandlerMethod } from "fastify"
import type { Http2SecureServer, Http2ServerRequest, Http2ServerResponse } from "node:http2"
import { readFileSync } from 'node:fs'       // import function
import type { AddressInfo } from 'node:net'  // import type
import { Agent, type Dispatcher } from 'undici'

import * as handlers from './handlers.js'    // import namespace
import { LlmRunners } from './runners.js'

declare module 'fastify' {
    interface FastifyInstance {
        client: Dispatcher        
        logRequest: () => this        
        runners: LlmRunners
    }
    interface FastifyRequest {
      clientIP: string;
    }    
}

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
try {
    // share a fetch dispatcher to the same destination to avoid
    // subsequent connection establishment handshake
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

        // Routes follow
        .post("/llmprompt", handlers.llmprompt)

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
