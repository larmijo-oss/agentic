import HttpStatus from 'http-status-codes'
import { type Dispatcher } from 'undici'

import type { FastifyHttp2Instance, FastifyHttp2Reply, FastifyHttp2Request, Http2RouteHandler } from './main.js'

export type Message = {
    role: string
    content: string | null
}

type OpenAIRequest = {
    model: string
    messages: Message[]
    stream: boolean
}  
const logOk = (request: FastifyHttp2Request, runner: string, model: string) => {
    console.info(`runner: ${runner}:${model}`)
}

const logInfo = (request: FastifyHttp2Request, runner: string, model: string, errcode: number, msg: string) => {
    console.info(`${errcode} |${request.ip} | ${runner}:${model} | ${msg}`)
}

const logErr = (request: FastifyHttp2Request, reply: FastifyHttp2Reply, errcode: number, errmsg: string): FastifyHttp2Reply => {
    console.warn(`${errcode} | ${request.ip} | ${errmsg}`) 
    return reply.status(errcode).send(errmsg)
} 
export const llmprompt: Http2RouteHandler = async function (request, reply) {
    const response = await routePrompt(this, request, reply, request.body as OpenAIRequest)
    if (response === null) return

    return reply    // must have `return` so that Fastify will not close the connection before the stream is done
        .header('Content-Type', 'text/event-stream')
        .send(response.body) // Fastify natively streams Undici's raw IncomingMessage body stream    
}
async function routePrompt(
    app: FastifyHttp2Instance,
    request: FastifyHttp2Request,
    reply: FastifyHttp2Reply,
    openAIRequest: OpenAIRequest
): Promise<Dispatcher.ResponseData | null> {

    const requestBody = { ...openAIRequest }

    const client = app.client
    const runners = app.runners

    for (const runner of runners) {
        requestBody.model = runner.model || openAIRequest.model

        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            'User-Agent': 'harnessd/1.0 (Node.js/Undici)',
        }

        if (runner.api.key) {
            headers["Authorization"] = `Bearer ${runner.api.key}`
        }

        try {
            const fullUrl = new URL(`${runner.api.url}/v1/chat/completions`)

            const response = await client.request({
                origin: fullUrl.origin,
                path: fullUrl.pathname + fullUrl.search,
                method: request.method as Dispatcher.HttpMethod,
                headers,
                body: JSON.stringify(requestBody),
            })

            if (response.statusCode < 200 || response.statusCode >= 300) {
                logInfo(
                    request,
                    runner.api.url,
                    runner.model,
                    response.statusCode,
                    "Server error. Trying another one."
                )

                if (response.body) {
                    response.body.destroy()
                }

                continue
            }

            logOk(request, runner.api.url, runner.model)
            return response

        } catch (error: any) {
            logInfo(
                request,
                runner.api.url,
                runner.model,
                HttpStatus.PROCESSING,
                `Connection error: ${error.message}. Trying another one.`
            )
            continue
        }
    }

    return logErr(
        request,
        reply,
        HttpStatus.SERVICE_UNAVAILABLE,
        "All available LLM providers are rate limited or offline."
    )
}
