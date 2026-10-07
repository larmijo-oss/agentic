import HttpStatus from 'http-status-codes'
import { type Dispatcher } from 'undici'
import * as readline from 'readline/promises'
import { Readable } from "stream"
import { pipeline } from 'stream/promises'
import { z as zod } from 'zod'
import type { FastifyHttp2Instance, FastifyHttp2Reply, FastifyHttp2Request, Http2RouteHandler } from './main.js'
import { getWeather, type OpenAIToolSchema, RawToolSchema } from './toolbox.js'

const RawFunction = zod.object({
    name: zod.string().nullish(),
    arguments: zod.string().nullish() // arguments are streamed as tokens across deltas
})
export type OpenAIFunction = zod.infer<typeof RawFunction>

const RawToolCall = zod.object({
    id: zod.string(),
    type: zod.literal("function"),
    function: RawFunction
})
export type OpenAIToolCall = zod.infer<typeof RawToolCall>

const RawMessage = zod.object({
    role: zod.string(),
    content: zod.string().nullish(),
    tool_calls: zod.array(RawToolCall).nullish(),
    tool_call_id: zod.string().nullish() // must match result with call 
})
.refine(msg => !(msg.role === 'tool' && !msg.tool_call_id), {
    message: "tool_call_id is explicitly required when role is 'tool'",
    path: ["tool_call_id"]
})
.transform(msg => {
    // Cross-field strict API rule
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        msg.content = undefined
    }
    return msg
})
export type Message = zod.infer<typeof RawMessage>

const RawRequest = zod.object({
    appID: zod.string(),
    model: zod.string(),
    messages: zod.array(RawMessage),
    stream: zod.boolean(),
    turnID: zod.number().nullish(),     // NULL/0 or must match tool result with turnID of call
    max_tokens: zod.number().optional(),
    tools: zod.array(RawToolSchema).nullish(),
})
export type OpenAIRequest = zod.infer<typeof RawRequest>


type ToolCallDelta = {
    index: number
    id: string | null
    function?: Partial<OpenAIFunction> | null
}
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
	    tool_calls?: ToolCallDelta[] | null                     
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

export const weather: Http2RouteHandler = async function (request, reply) {
    const body = request.body as {
        lat: string
        lon: string
    }

    const [result, error] = await getWeather(this, [body.lat, body.lon])

    if (error) {
        return reply
            .code(HttpStatus.INTERNAL_SERVER_ERROR)
            .type('text/plain')
            .send(error)
    }

    return reply
        .type('text/plain')
        .send(result)
}

function upsertAgentTools(sql: FastifyHttp2Instance['sql'], appID: string, tools: OpenAIToolSchema[] | null | undefined): OpenAIToolSchema[] {
    // REQUIREMENT 1: "tools != None, UPSERT the current tool set"
    if (tools) {
        // REQUIREMENT 2: "map [] to NULL (stale marker), see REQ 4.2 below"        
        const toolSchemas = tools.length > 0 ? JSON.stringify(tools) : null

        // upsert current tool set (maybe [], used to clear tools)       
        sql.upsertTools.run(appID, toolSchemas)

        // returns current set of tools (maybe [], to clear tools)        
        return tools
    }

    // REQUIREMENT 3: "if (tools == None), return the existing row, 
    // if one exists, else set row to undefined, which will return `[]` 
    const row = sql.selectTools.get(appID) as { schemas: string | null } | undefined

    // REQUIREMENT 4: "Returns [] if appID has never registered."
    // 1. If the row doesn't exist, returns `[]`.
    // 2. If the row exists but `schemas` is NULL, returns `[]`.
    if (!row || row.schemas === null) return []
    // 3. Otherwise, it parses the JSON string back into an `OpenAIToolSchema[]`.    
    try { return JSON.parse(row.schemas) as OpenAIToolSchema[] } catch { return [] }
}

function assembleToolCall(parallelCalls: Map<number, OpenAIToolCall>, delta: ToolCallDelta) {
    // look for call in array; if not found, allocate a new entry
    let call = parallelCalls.get(delta.index)
    
    // new entry        
    if (!call) {
        // ensure OpenAI API required type field is set to the required string "function"
        call = { id: delta.id || '', type: 'function' , function: { name: '', arguments: '' } }
        parallelCalls.set(delta.index, call)
    }
    // sometimes the call ID arrives in a later delta, just store it    
    call.id ||= delta.id || ''

    // populate call with the function name
    // allow for this to also be in later deltas
    call.function.name ||= delta.function?.name || ''
    // accumulate arguments across deltas
    delta.function?.arguments && (call.function.arguments += delta.function.arguments)
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

    const { appID, turnID, ...requestBody } = openAIRequest // strips out appID

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
	const acc: SseAccumulator = { completion: '', reasoning: '', parallelCalls: new Map()  }
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

type Call = { turnID: number; id: string; name: string; arguments: string; result: string | null }

function retrieveHistory(sql: FastifyHttp2Instance['sql'], appID: string): Message[] {
    // retrieve full message history by appID, ordered by insertion,
    // push them all into one Message array and return it
    const turns = sql.selectTurns.all(appID) as Turn[]
    const calls = sql.selectCalls.all(appID) as Call[]
    let calls_end_idx = 0

   // create Messages array from prompt messages, parsed and validated by Zod,
   // and, if present, reasoning and completion
    const history: Message[] = []
    for (const turn of turns) {
        if (turn.prompt) history.push(...zod.array(RawMessage).parse(JSON.parse(turn.prompt)) as Message[])
        const calls_start_idx = calls_end_idx 
        while (calls_end_idx < calls.length && calls[calls_end_idx]?.turnID === turn.turnID) calls_end_idx++
        if (calls_end_idx > calls_start_idx) {
            const turnCalls = calls.slice(calls_start_idx, calls_end_idx)
                   
            const toolCalls: OpenAIToolCall[] = turnCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }))

            // push assistant message declaring the tool calls into history (FIRST, by API)
            // collect tool call reasoning if present
            history.push({ role: 'assistant', content: turn.reasoning || undefined, tool_calls: toolCalls })

            // then extract tool results and append them to history
            for (const call of turnCalls) {
                if (call.result != null) history.push({
                    role: 'tool', content: call.result, tool_call_id: call.id
                })
            }
        } 
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
    parallelCalls: Map<number, OpenAIToolCall>    
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
                         if (delta?.tool_calls) {
                            for (const toolCall of delta.tool_calls) assembleToolCall(acc.parallelCalls, toolCall)
                        }
                        // convey LLM completion stream to client:
                        // yield clean SSE event (key:value line)
                        yield `data: ${tagline}\n\
n`

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

export const llmtools: Http2RouteHandler = async function (request, reply) {
    const rawRequest = RawRequest.safeParse(request.body);
    if (!rawRequest.success) {
        return logErr(request, reply, HttpStatus.BAD_REQUEST, rawRequest.error.message);
    }
    const openAIRequest = rawRequest.data as OpenAIRequest;
    
    // insert prompt into database or update existing database with tool result
    let turnID = 0
    try {
        if (openAIRequest.turnID != null && openAIRequest.turnID > 0) {
            // request carries result(s) for non-resident tool call(s) made at turn turnID, 
            // the turnID was forwarded to the agent along with the non-resident tool call(s) 
            // and is now echoed back along with the result(s)
            turnID = openAIRequest.turnID
            for (const msg of openAIRequest.messages) {
                if (msg.role === 'tool') {
                    this.sql.updateCall.run(msg.content ?? null, msg.tool_call_id)    // convert Zod's undefined to SQL null
                }
            }
        } else {
            // a new prompt, not carrying any tool call result
            turnID = Number(this.sql.insertTurn.run(openAIRequest.appID, JSON.stringify(openAIRequest.messages)).lastInsertRowid)
        }
    } catch (err: any) {
        return logErr(request, reply, HttpStatus.INTERNAL_SERVER_ERROR, err.message)
    }
    // save non-resident tools
      let agentTools: OpenAIToolSchema[]
    agentTools = upsertAgentTools(this.sql, openAIRequest.appID, openAIRequest.tools)

    openAIRequest.messages = retrieveHistory(this.sql, openAIRequest.appID)

    openAIRequest.tools = [...this.toolbox.schemas(), ...agentTools]
    // prepare reply to send to client
      reply.hijack()  // tell Fastify to hand over payload serialization,
                    // connection lifecycle, timer management, and connection termination
    reply.raw.setHeader('Content-Type', 'text/event-stream')
    // convey completion
      const app = this;
    async function* conveyCompletion(): AsyncGenerator<string> {
        let sendNewPrompt = true
        const acc: SseAccumulator = { completion: '', reasoning: '', parallelCalls: new Map() }

        while (sendNewPrompt) {
            sendNewPrompt = false

            const response = await routePrompt(app, request, reply, openAIRequest)
            if (response === null) return

            // accumulate completion or tool call (and reasoning) tokens and forward token stream to front-end agent
            yield* yieldSse(response, acc)

            // stream ended
            if (acc.parallelCalls.size > 0) {
                // there's tool call!
                try {
                    // save tool call to db
                    for (const [idx, call] of acc.parallelCalls) {                                         
                        app.sql.insertCall.run(turnID, call.id, idx, call.function.name, call.function.arguments)
                    }
                    
                    // save any reasoning associated with tool call
                    const reasoning = !acc.completion 
                      ? acc.reasoning 
                      : !acc.reasoning 
                        ? acc.completion 
                        : acc.completion + acc.reasoning;
                    if (reasoning) app.sql.updateReasoning.run(acc.reasoning, turnID)
                    
                } catch (err: any) {
                    yield `event: error\ndata: ${JSON.stringify(err.message)}\n\n`
                    return
                }
             
                // handle tool call
                sendNewPrompt = true // assume only resident tool calls
                // **opportunistically** prepare request to be posted
                // to LLM with resident tool result(s)
                const toolCalls: OpenAIToolCall[] = [...acc.parallelCalls.values()]
                const assistantMsg: Message = { role: 'assistant', content: acc.reasoning || undefined, tool_calls: toolCalls }
                openAIRequest.messages.push(assistantMsg)

                // make the tool calls!
                const agentToolCalls: OpenAIToolCall[] = []
                for (const call of acc.parallelCalls.values()) {
                    // invoke individual tool call                    
                    const [toolResult, toolErr] = await app.toolbox.invoke(app, call.function)
                    if (toolResult === undefined && toolErr === undefined) {
                        // tool non-resident, need to forward to front-end agent
                        agentToolCalls.push({
                            id: call.id,
                            type: 'function',
                            function: {
                                name: call.function.name,
                                arguments: call.function.arguments
                            }
                        })
                        sendNewPrompt = false
                        continue
                    }

                    const result = toolErr ?? toolResult ?? undefined
                    if (!result) { // neither null, undefined, nor empty string
                        yield `event: error\ndata: ${JSON.stringify(`${call.function.name}: invalid toolResult: cannot be null or an empty string.`)}\n\n`
                        return                        
                    }
                    try {
                        // save resident tool call result or error                        
                        app.sql.updateCall.run(result, call.id)
                    } catch (err: any) {
                        yield `event: error\ndata: ${JSON.stringify(err.message)}\n\n`
                        return
                    }

                    // if only resident tool calls so far . . .                  
                    if (sendNewPrompt) {
                        // **opportunistically** prepare this resident tool result
                        // and append it to the request to be posted to LLM
                        openAIRequest.messages.push({ role: 'tool', content: result, tool_call_id: call.id })
                    }
                }
                if (!sendNewPrompt) {
                    // Some tools were non-resident, forward to front-end agent, along
                    // with the current turn's turnID. Earlier we stored resident tool 
                    // results in db, they just stay there for now. All **opportunistic** 
                    // work to prepare posting response to LLM wasted, oh well.
                    // 
                    // At some point, the agent will post non-resident tool results, tagged with the
                    // turnID of the current turn. At that point, we look up current turn's resident
                    // tool results and append them to the incoming request before posting it to the
                    // LLM. 
                    yield `event: tool_calls\ndata: ${JSON.stringify({turnID: turnID, calls:
                    agentToolCalls})}\n\n`
                }
                // else: all tools resident — **opportunistic** work paid off.
                // loop continues and sends resident tool results, with the current turnID
                acc.reasoning = ''; acc.completion = ''; acc.parallelCalls.clear()

            } else {
                // there's no tool call
                if (acc.completion || acc.reasoning) try {
                    // save the accumulated completion
                    app.sql.updateTurn.run(acc.completion, acc.reasoning, acc.reasoning, turnID)
                } catch (err: any) {
                    yield `event: error\ndata: ${JSON.stringify(err.message)}\n\n`
                }             
            }
        }
    }
    // start the pipeline to send the SSE stream to agent
    try {
        await pipeline(Readable.from(conveyCompletion()), reply.raw)
    } catch (err: any) {
        if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE' && !reply.raw.writableEnded) {
            request.log.error(`llmTools Pipeline Error: ${err.message}`)
            reply.raw.destroy(err)
        }
    }
}
