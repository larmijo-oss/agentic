import HttpStatus from "http-status-codes"
import { request } from 'undici'
import { z as zod } from 'zod'

import type { FastifyHttp2Instance } from './main.js'
import { type OpenAIFunction } from './handlers.js'

import WEATHER_SCHEMA from './tools/get_weather.json' with { type: 'json' }
import WEATHER_AUTH_SCHEMA from './tools/get_weather_auth.json' with { type: 'json' }

export const RawToolSchema = zod.object({
    type: zod.literal("function"),
    function: zod.object({
        name: zod.string(),
        description: zod.string(),
        parameters: zod.object({
            type: zod.string(),
            properties: zod.record(
                zod.string(),
                zod.object({
                    type: zod.string(),
                    description: zod.string(),
                    enum: zod.array(zod.string()).optional()
                })
            ),
            required: zod.array(zod.string()).optional() // parameters MUST be in function-signature order
        }).optional()
    })
})
export type OpenAIToolSchema = zod.infer<typeof RawToolSchema>

type OMeteoResponse = {
    latitude: number
    longitude: number
    current: {
        temperature_2m: number
    }
}

export async function getWeather(app: FastifyHttp2Instance, argv: string[]): Promise<[string?, string?]> {
    // Open-Meteo API doc: https://open-meteo.com/en/docs#api_documentation
    let response
    try {
        response = await request(`https://api.open-meteo.com/v1/forecast?latitude=${argv[0]}&longitude=${argv[1]}&current=temperature_2m&temperature_unit=fahrenheit`, {
            method: "GET", signal: AbortSignal.timeout(5000),
        })
        if (response.statusCode !== HttpStatus.OK) {
            return [undefined, `Open-meteo: ${response.statusCode}: ${response.statusText}`]
        }
    } catch (error) {
        return [undefined, "Cannot connect to Open Meteo"]
    }
    const ometeoResponse = await response.body.json() as OMeteoResponse

    return [`Weather at latitude ${ometeoResponse.latitude} and longitude ${ometeoResponse.longitude} is ${ometeoResponse.current.temperature_2m}ºF`, undefined]
}

type ToolFunction = (app: FastifyHttp2Instance, args: string[]) => Promise<[string?, string?]>

type Tool = {
    schema:   OpenAIToolSchema
    function: ToolFunction
}


export class Toolbox {
    readonly tools: Map<string, Tool>

    constructor() {
        this.tools = new Map<string, Tool>([
            [ "get_weather_auth", { schema: WEATHER_AUTH_SCHEMA as OpenAIToolSchema, function: getWeatherAuth } ],
            //["ollama_cli",  { schema: OLLAMACLI_SCHEMA as OpenAIToolSchema, function: ollamaCli  }],
        ])
    }

    schemas(): OpenAIToolSchema[] {
        return [...this.tools.values()].map(tool => tool.schema)
    }

   async invoke(app: FastifyHttp2Instance, fn: OpenAIFunction): Promise<[string?, string?]> {
        if (!fn.name) return [undefined, undefined]
        const tool = this.tools.get(fn.name)
        if (!tool) return [undefined, undefined]
    
        let args: Record<string, unknown>
        try {
            // parses JSON arguments string: stringifies each required argument into args
            args = JSON.parse(fn.arguments ?? '{}')
        } catch (err: any) {
            return [undefined, `bad tool arguments JSON: ${err.message}`]
        }

        try {
            // get args in parameters.required order, they may arrive out of order from the back end
            const argv = (tool.schema.function.parameters?.required ?? [])
                .map(label => {
                    const value = args[label]
                    if (value == null) {
                        throw new Error(`422 UnprocessableEntity: Missing required argument '${label}'`)
                    }                
                    return typeof value === 'string' ? value : (value == null ? '' : String(value)) // retains 0 and 'false'
                })
            return tool.function(app, argv)
        } catch (err: any) {
            return [undefined, err.message]
        }        
    }
    
}

export async function getWeatherAuth(app: FastifyHttp2Instance, argv: string[]): Promise<[string?, string?]> {
    const [ticket, ...args] = argv
    if (!ticket) return [undefined, "No authorization ticket"]
    const err = checkAuth(app.sql, ticket)
    if (err instanceof Error) return [undefined, err.message]

    return getWeather(app, args)
}

function checkAuth(sql: FastifyHttp2Instance['sql'], ticket: string): Error | null {
    try {
        const row = sql.selectTicket.get(ticket) as [number] | undefined
        return !row || Math.floor(Date.now() / 1000) > row[0]
            ? Error("401 Unauthorized: The ticket is invalid or expired. Ask the user if they want to try again. If so, you **MUST** call the get_auth tool again to get a fresh new ticket and retry the operation. DO NOT reuse any ticket in context/history that came before this message.")
            : null
    } catch (error) {
        return error as Error
    }
}


