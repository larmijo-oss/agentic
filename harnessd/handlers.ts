import HttpStatus from 'http-status-codes'
import { type Dispatcher } from 'undici'
import * as readline from 'readline/promises'
import { Readable } from "stream"
import { pipeline } from 'stream/promises'
import { z as zod } from 'zod'
import type { FastifyHttp2Instance, FastifyHttp2Reply, FastifyHttp2Request, Http2RouteHandler } from './main.js'
import { Capture, CompletionLexer, LexTarget, structuredResponseFormat } from './structured.js'
import { recallBlock, recallMessage, promptPlaintext, capRunes, MAX_RECALL_ITEM_CHARS, embedText, blobFromUnit } from './pensieve.js'

const MAX_HISTORY_BYTES = 64_000    // replayed-window budget in JSON bytes (~16K tokens); recall rides on top
const MAX_EMBED_ITEM_CHARS = 4000   // caps the completion fallback in end-of-stream outcome triage

const EMBED_CONCURRENCY = 4                 // max number of outstanding embeddings
let freeEmbedSlots = EMBED_CONCURRENCY
const embedWaiters: Array<() => void> = []  // for shutdown cleanup

const RawMessage = zod.object({
    role: zod.string(),
    content: zod.string().nullish(),
})
export type Message = zod.infer<typeof RawMessage>

const RawRequest = zod.object({
    appID: zod.string(),
    model: zod.string(),
    stream: zod.boolean(),
    max_tokens: zod.number().optional(),
    messages: zod.unknown(), // UPDATE to allow for raw body
    response_format: zod.unknown().nullish(),
})
// the messages array is validated by RawRequest, then replaced 
// wholesale (by retrieveHistory) before routing, so only the 
// server-assembled replacement is ever an object list
export type OpenAIRequest = Omit<zod.infer<typeof RawRequest>, 'messages'> & { messages: object[] }

export async function top(request: any, reply: any) {
    return reply.code(200).send({
        message: "UM EECS agentic harnessd"
    });
}

const pendingEmbeds = new Set<Promise<void>>() // for shutdown cleanup

function embedTurnText(app: FastifyHttp2Instance, turnID: number, text: string): void {
    // fire off async embedText(), paced out by embedSlot()
    const task = embedSlot(async () => {
        try {
            const embedding = await embedText(app, text)
            app.sql.updateEmbedding.run(blobFromUnit(embedding), turnID)
            app.snapshotDirty.value = true
        } catch (err: any) {
            console.error(`turn embedding failed for turn ${turnID}: ${err.message}`)
        }
    })
    pendingEmbeds.add(task)
    // must handle task rejection, else Node's default kills the process
    task.finally(() => { pendingEmbeds.delete(task) }).catch(() => { })
}

export async function drainEmbeds(timeoutMs: number): Promise<void> {
    await Promise.race([
        Promise.allSettled([...pendingEmbeds]),
        new Promise<void>(done => setTimeout(done, timeoutMs).unref()),
    ])
}

async function embedSlot(run: () => Promise<void>): Promise<void> {
    while (freeEmbedSlots === 0) await new Promise<void>(wakeup => embedWaiters.push(wakeup))
    freeEmbedSlots--
    try { await run() } finally {
        freeEmbedSlots++
        embedWaiters.shift()?.()
    }
}


type OpenAIResponse = {
    model?: string      // echoed to front-end when creating the synthetic OpenAIResponse
                        // wrapper for structured output completion
    choices?: {         // optional so as to automatically skip control messages
        delta: {
            content?: string | null
            reasoning?: string | null
            reasoning_content?: string | null
        }
        finish_reason?: string | null
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

export const llmsearch: Http2RouteHandler = async function (request, reply) {

    // llmChat's request validation
    const rawRequest = RawRequest.safeParse(request.body)
    if (!rawRequest.success) {
        // failed zod validation
        return logErr(request, reply, HttpStatus.UNPROCESSABLE_ENTITY, rawRequest.error.message)
    }
    const openAIRequest = rawRequest.data as OpenAIRequest
    if (openAIRequest.messages === undefined) {
        // raw messages must be present
        return logErr(request, reply, HttpStatus.UNPROCESSABLE_ENTITY, 'messages must be set')
    }

    // handler only works with SSE stream
    if (openAIRequest.stream !== true) {
        return logErr(request, reply, HttpStatus.UNPROCESSABLE_ENTITY, 'stream must be true')
    }

    // insert prompt
   let turnID = 0
    try {
        // save prompt to db    
        // use null for appID to test SSE error event  
        turnID = Number(this.sql.insertTurn.run(openAIRequest.appID, Buffer.from(JSON.stringify(openAIRequest.messages))).lastInsertRowid)
    } catch (err: any) {
        return logErr(request, reply, HttpStatus.INTERNAL_SERVER_ERROR, err.message)
    }

    // the snapshot is captured pre-zod (raw request.body, not the parsed
    // openAIRequest)
    const snapshotJson = JSON.stringify((request.body as { messages: unknown }).messages)
    const [prompt] = capRunes(promptPlaintext(snapshotJson), MAX_RECALL_ITEM_CHARS)

    // convet prompt to plaintext

    const isStructured = openAIRequest.response_format == null
    try {

        // context assembly
	   // create recall block with the prompt for semantic search
        const { recall, historyFloor } = await recallBlock(this, openAIRequest.appID, prompt)

        // attach recall+history as context+prompt to openAIRequest
        // reconstruct history, with the current prompt appended
        openAIRequest.messages = retrieveHistory(this.sql, openAIRequest.appID, historyFloor, turnID)

        // add recall block to the front of history, recallMessage() will set "role: system" on the message
        if (recall.length > 0) openAIRequest.messages.unshift(recallMessage(recall))
        // one memmove of N pointers for dense (not holey) array, not dictionary

    } catch (err: any) {
        this.sql.updateDegrade.run(turnID)
        return logErr(request, reply, HttpStatus.INTERNAL_SERVER_ERROR, err.message)
    }

    // retrieve JSON schema to be used with response_format
    if (isStructured) openAIRequest.response_format = structuredResponseFormat
    // forward prompt to LLM runner (with response_format specified)
    const response = await routePrompt(this, request, reply, openAIRequest)
    if (response === null) {
        this.sql.updateDegrade.run(turnID)
        return
    }

    // handle SSE stream
    // prepare reply to send to client
    reply.hijack()  // tell Fastify to hand over payload serialization,
                    // connection lifecycle, timer management, and connection termination
    reply.raw.setHeader('Content-Type', 'text/event-stream')

    const acc: SseAccumulator = {
        completion: new Capture(), summary: new Capture(), reasoning: '', finishReason: null, model: null, lexer: new CompletionLexer(),
    }
    let streamError: unknown = null
    try {
        await pipeline(
            Readable.from(yieldSse(response, acc, isStructured)),
            reply.raw,
            // end: false keeps the socket open through the stream-end write, so
            // a failed write can still yield a final SSE error event
            { end: false },
        )
    } catch (err: any) {
        response.body.destroy()
        streamError = err
        // if client disconnects early, pipeline automatically throws an AbortError
        // and correctly destroys the underlying fetch body and readline interface.
        if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE' && !reply.raw.writableEnded) {
            // may not be able to send to client anymore
            console.error(`Pipeline Error: ${err.message}`)
            // forcibly destroy the raw response stream to stop it hanging.
            reply.raw.destroy(err)
        }
    }

    // stream-end write
     acc.completion.flushPending()
    acc.summary.flushPending()
    const completion = acc.completion.text.join('')
    const summary = acc.summary.text.join('')
    const completed = acc.finishReason === 'stop' ? 1 : 0
    try {
        this.sql.updateTurn.run(completion, summary, acc.reasoning, completed, turnID)

        // end-of-stream summary embedding
	if (completed === 1 && this.runners.embed) {
            const trimmed = summary.trim()
            if (!trimmed) {
                const completionRunes = [...completion].length
                if (completionRunes > MAX_EMBED_ITEM_CHARS)
                    console.warn(`turn ${turnID}: no summary; embedding the first ${MAX_EMBED_ITEM_CHARS} of ${completionRunes} chars`)
            }
            const text = trimmed || capRunes(completion, MAX_EMBED_ITEM_CHARS)[0]
            // do the embedding
            if (text && prompt) void embedTurnText(this, turnID, text)
        }

    } catch (err: any) {
        console.error(`SQLite turn result update error: ${err.message}`)
        // the write is detached from the relay pipeline, so only a client
        // still connected can be told
        if (streamError === null && !reply.raw.writableEnded) {
            reply.raw.write(`event: error\ndata: ${JSON.stringify(err.message)}\n\n`)
        }
    }
    if (streamError === null && !reply.raw.writableEnded) reply.raw.end()

    return
}


type Turn = { turnID: number; prompt: string; reasoning: string | null; completion: string | null }

function retrieveHistory(sql: FastifyHttp2Instance['sql'], appID: string, minTurnID: number, currentTurnID: number): object[] {
	const sizes = sql.selectTurnSizes.all(appID, minTurnID, currentTurnID) as { turnID: number, bytes: number }[]
	let total = sizes.reduce((sum, { bytes }) => sum + bytes, 0)
    let drop = 0
    while (drop + 1 < sizes.length && total > MAX_HISTORY_BYTES) {
        total -= sizes[drop]!.bytes
        drop++
    }

	const survivors = sizes.slice(drop).map(({ turnID }) => turnID)
    const turns = sql.selectTurnsByID.all(JSON.stringify(survivors)) as Turn[]

    // estimate sum total of qualified turns of appID

    // select qualified turns and fit history budget

    // retrieve qualified turns, ordered by insertion

    const history: object[] = []
    for (const turn of turns) {

        // append turn's messages array to history

        // re-construct assistant's completion and append to history
	  if (turn.prompt) {
            try {
                // no spread: a prompt with >~100k messages would overflow V8's
                // spread-argument limit
                const parsed = JSON.parse(turn.prompt.toString())
                if (!Array.isArray(parsed)) throw new Error('snapshot is not a message list')
                for (const message of parsed) history.push(message)
            } catch { }
        }
	        if (turn.completion || turn.reasoning) {
            const content = turn.completion && turn.reasoning
                ? turn.reasoning + '\n\n' + turn.completion
                : (turn.completion ?? turn.reasoning)
            history.push({ role: 'assistant', content: content })
        }
    }
    return history
}
type SseAccumulator = {
    completion: Capture
    summary: Capture
    reasoning: string
    finishReason: string | null
    model: string | null
    lexer: CompletionLexer
}

function textPacket(frame: string, model: string | null): string | null {
    if (!frame) return null
    const packet = JSON.stringify({
        choices: [{ delta: { content: frame } }],
        ...(model ? { model } : {}),
    })
    return `data: ${packet}\n\n`
}

async function* yieldSse(
    response: Dispatcher.ResponseData,
    acc: SseAccumulator,
    isStructured: boolean,
): AsyncGenerator<string> {
    // so that we can emit upstream read fail as an SSE error event
    let upstreamReadFailure: string | null = null

    const sink = (target: LexTarget, data: string) => {
        if (target === LexTarget.Completion) acc.completion.push(data)
        else acc.summary.push(data)
    }
    const reader = readline.createInterface({
    input: response.body,
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
                        const openAIResponse: OpenAIResponse = JSON.parse(tagline)
                        if (openAIResponse.model) acc.model = openAIResponse.model
                        const choice = openAIResponse.choices?.[0]
                        if (choice?.finish_reason) {
                            // terminal signal: providers send it on the final content
                            // chunk or a trailing empty-delta chunk; last write wins
                            acc.finishReason = choice.finish_reason
                        }
                        const delta = choice?.delta
                        let suppressTagline = false
                        if (isStructured && delta?.content) {

                            // parse structured output
				 suppressTagline = true
                            if (acc.lexer.fallback) {
                                acc.completion.text.push(delta.content)
                                const rawEvent = textPacket(delta.content, acc.model)
                                if (rawEvent !== null) yield rawEvent
                            } else {
                                const mark = acc.completion.text.length
                                const fell = acc.lexer.feed(delta.content, sink)

                                const mainEvent = textPacket(acc.completion.text.slice(mark).join(''), acc.model)
                                if (mainEvent !== null) yield mainEvent

                                if (fell !== null) {
                                    if (acc.completion.flushPending()) yield textPacket('\\', acc.model)!
                                    acc.summary.flushPending()
                                    acc.completion.text.push(fell)
                                    yield `event: error\ndata: ${JSON.stringify('structured output schema violation; passing raw text through')}\n\n`
                                    const restEvent = textPacket(fell, acc.model)
                                    if (restEvent !== null) yield restEvent
                                }
                            }

                        } else {

                            // parse non-structured output
				// the following three fields usage should be mutually exclusive
                            // assemble response tokens into full completion
                            if (delta?.content) acc.completion.text.push(delta.content)
                            // some models (e.g., Qwen, Deepseek) stream their reasoning
                            else if (delta?.reasoning_content) acc.reasoning += delta.reasoning_content
                            else if (delta?.reasoning) acc.reasoning += delta.reasoning
                        }
                        if (!suppressTagline) yield `data: ${tagline}\n\n`
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
	} catch (err: any) {
        if (err.code === 'ERR_STREAM_PREMATURE_CLOSE') throw err
        // only upstream failure becomes an error frame
        upstreamReadFailure = err.message
        response.body.destroy()

    } finally {
        reader.close()
    }

        // withheld backslash from any split escape flushes when the stream ends
    if (acc.completion.flushPending()) {
        const flushEvent = textPacket('\\', acc.model)
        if (flushEvent !== null) yield flushEvent
    }

    // yield upstream read fail as SSE error event
    if (upstreamReadFailure !== null) {
        yield `event: error\ndata: ${JSON.stringify(`upstream read failed: ${upstreamReadFailure}`)}\n\n`
    }
}
