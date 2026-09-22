import HttpStatus from 'http-status-codes'
import { type Dispatcher } from 'undici'
import * as readline from 'readline/promises'
import { Readable } from "stream"
import { pipeline } from 'stream/promises'
import { z as zod } from 'zod'
import type { FastifyHttp2Instance, FastifyHttp2Reply, FastifyHttp2Request, Http2RouteHandler } from './main.js'

const RawMessage = zod.object({
    role: zod.string(),
    content: zod.string().nullish(),
})
export type Message = zod.infer<typeof RawMessage>

const RawRequest = zod.object({
    appID: zod.string(),
    model: zod.string(),
    messages: zod.array(RawMessage),
    stream: zod.boolean(),
})
export type OpenAIRequest = zod.infer<typeof RawRequest>

export async function top(request: any, reply: any) {
    return reply.code(200).send({
        message: "UM EECS agentic harnessd"
    });
}

type OpenAIResponse = {
    choices?: {  // guaranteed only one completion choice
        delta: {
            content?: string
            reasoning?: string
            reasoning_content?: string            
        }
    }[]
}

type SseEvent = 'Message' | (string & {})

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

    const { appID, ...requestBody } = openAIRequest // strips out appID

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
export const llmchat: Http2RouteHandler = async function (request, reply) {
    const rawRequest = RawRequest.safeParse(request.body);
    if (!rawRequest.success) {
        return logErr(request, reply, HttpStatus.BAD_REQUEST, rawRequest.error.message);
    }
    const openAIRequest = rawRequest.data as OpenAIRequest

    let turnID = 0
    try {
        // save prompt to db
        // use null for appID to test SSE error event
        turnID = Number(this.sql.insertTurn.run(openAIRequest.appID, Buffer.from(JSON.stringify(openAIRequest.messages))).lastInsertRowid)
    } catch (err: any) {
        return logErr(request, reply, HttpStatus.INTERNAL_SERVER_ERROR, err.message)
    }

    try {
        // reconstruct openAIRequest to be sent to LLM runner--add context:
        // retrieve all messages belonging to appID and
        // insert them as one Messages array of openAIRequest.messages
        openAIRequest.messages = retrieveHistory(this.sql, openAIRequest.appID)
    } catch (err: any) {
        return logErr(request, reply, HttpStatus.INTERNAL_SERVER_ERROR, err.message)
    }

   	// prepare reply to send to client
    reply.hijack()  // tell Fastify to hand over payload serialization,
                    // connection lifecycle, timer management, and connection termination
    reply.raw.setHeader('Content-Type', 'text/event-stream')

    // forward prompt to LLM runner
    const response = await routePrompt(this, request, reply, openAIRequest)
    if (response === null) { return }

    try {

        // accumulate completion (and reasoning) tokens and forward token stream to front-end agent
	const acc: SseAccumulator = { completion: '', reasoning: '' }
        await pipeline( // pipeline() will take care of all of the above.
            Readable.from(yieldSse(response, acc)),
            reply.raw,
        )
        // after the stream ends, save the accumulated completion
        this.sql.updateTurn.run(
        acc.completion,
        acc.reasoning,
        acc.reasoning,
        turnID
)
    } catch (err: any) {
        // If the client disconnects early, pipeline automatically throws an AbortError
        // and correctly destroys the underlying fetch body and readline interface.
        if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE' && !reply.raw.writableEnded) {
            logErr(request, reply, err.code, `Pipeline Error: ${err.message}`)
            // may not be able to send to client anymore
            console.error(`Pipeline Error: ${err.message}`)

            // forcibly destroy the raw response stream to stop it hanging.
            reply.raw.destroy(err)
        }
    }
    return
}
type Turn = { turnID: number; prompt: string; reasoning: string | null; completion: string | null }

function retrieveHistory(sql: FastifyHttp2Instance['sql'], appID: string): Message[] {
    // retrieve full message history by appID, ordered by insertion,
    // push them all into one Message array and return it
    const turns = sql.selectTurns.all(appID) as Turn[]

   // create Messages array from prompt messages, parsed and validated by Zod,
   // and, if present, reasoning and completion
    const history: Message[] = []
    for (const turn of turns) {
        if (turn.prompt) history.push(...zod.array(RawMessage).parse(JSON.parse(turn.prompt)) as Message[])

        if (turn.completion) {
            // if reasoning present, prepend it to completion
            const content = turn.reasoning ? turn.reasoning + '\n\n' + turn.completion : turn.completion
            history.push({ role: 'assistant', content })
        } // else, current turn, no assistant reply yet, not an error
    }
    return history
}
type SseAccumulator = {
    completion: string
    reasoning: string
}

async function* yieldSse(
    response: Dispatcher.ResponseData,
    acc: SseAccumulator,
): AsyncGenerator<string> {
    const reader = readline.createInterface({
        input: response.body as any,
        crlfDelay: Infinity,
    })

    try {
        let sseEvent: SseEvent = 'Message'

        for await (const line of reader) {
            // SSE events are delimited by "\n\n"
            // new SSE event, default to Message
            if (line === '') {
                sseEvent = 'Message'
                continue
            }

            // parse SSE line
            const splitAt = line.indexOf(':')
            if (splitAt === -1) continue

            // separate out `tag: tagline` from the SSE line
            const tag = line.substring(0, splitAt)
            let tagline = line.substring(splitAt + 1)

            // drop the first leading space (per SSE spec)
            if (tagline && tagline[0] === ' ') {
                tagline = tagline.substring(1)
            }

            // "tag" can only be "data" or "event"
            if (tag === 'data') {

                // OpenAI's `/v1/chat/completions` uses "data: [DONE]"
                // to indicate end of stream
                if (tagline === '[DONE]') continue

                // multiple data lines can belong to the same event
                if (sseEvent === 'Message') {

                    // handle Message (default) data line
                    try {
                        // OpenAI's `/v1/chat/completions` API requires that
                        // a serialized JSON object follows a `data:` tag.
                        const openAIResponse: OpenAIResponse = JSON.parse(tagline)

                        // OpenAI defaults to generating only one completion choice
                        // when the 'n' parameter is not included in OpenAIRequest
                        const choice = openAIResponse.choices?.[0]
                        const delta = choice?.delta

                        // the following three fields usage should be mutually exclusive
                        // assemble response tokens into full completion
                        if (delta?.content) {
                            acc.completion += delta.content
                        }
                        // some models (e.g., Qwen, Deepseek) stream their reasoning
                        else if (delta?.reasoning_content) {
                            acc.reasoning += delta.reasoning_content
                        }
                        else if (delta?.reasoning) {
                            acc.reasoning += delta.reasoning
                        }

                        // convey LLM completion stream to client:
                        // yield clean SSE event (key:value line)
                        yield `data: ${tagline}\n\n`

                    } catch (err: any) {
                        yield `event: error\ndata: ${JSON.stringify(err.message)}\n\n`
                    }

                } else {
                    // silent passthrough non-Message events, should not happen with
                    // /v1/chat/completions API; support for other APIs will likely
                    // require more extensive support for non-Message events.
                    yield `event: ${sseEvent}\ndata: ${tagline}\n\n`
                }

            } else if (tag === 'event') {
                sseEvent = tagline as SseEvent
            }
        }

    } finally {
        reader.close()
    }
}
