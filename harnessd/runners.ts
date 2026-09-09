import * as fs from 'fs'
import { parse } from "smol-toml"
import { z as zod } from "zod"
const RUNNERS_CONFIG = "/home/ubuntu/agentic/runners.toml"

const RawRunnerAPI = zod.object({
    url: zod.string(),
    key: zod.string()
})

type LlmRunnerAPI = zod.infer<typeof RawRunnerAPI>

const RawRunner = zod.object({
    api: zod.string(),
    model: zod.string(),
    weight: zod.number()
    })

interface LlmRunner {
    api: LlmRunnerAPI
    model: string
    weight: number
} 
const RawRunners = zod.object({
    apis: zod.record(zod.string(), RawRunnerAPI).default({}),
    runners: zod.array(RawRunner).default([])
    })

export class LlmRunners implements Iterable<LlmRunner> {
    private runners: LlmRunner[] = []
    private local: LlmRunner | null = null; // ';' required to avoid enjambment

    // The iterator that powers the `for (const runner of runners)` loop:
    // Implemented using the Schwartzian Transform (Decorate-Sort-Undecorate).
    [Symbol.iterator](): Iterator<LlmRunner> {
        // Calculate the Efraimidis and Spirakis A-Res scores based on weights
        // Each runner gets a randomized score that, when sorted, determines
        // the fallback order for each HTTP-request.
        // Each HTTP-request gets a different ordered list, effecting the
        // round-robin selection of runners across HTTP-requests.
        const scored = this.runners.map(runner => {
            const score = -Math.log(Math.random()) / (runner.weight > 0.0 ? runner.weight : 1e-9)
            return { score, runner } // decorate
        })

        // Sort ascending by score.
        scored.sort((a, b) => a.score - b.score)

        // undecorate: extract just the ordered references and dynamically append the local fallback.
        const sorted = scored.map(item => item.runner)
        if (this.local) {
            sorted.push(this.local)
        }

        return sorted.values()
    }

    constructor() {
        console.log(`Reading ${RUNNERS_CONFIG}`)

        // ingest runners config file, validate the structure using Zod
        let toml_str: string
        try {
            toml_str = fs.readFileSync(RUNNERS_CONFIG, 'utf8')
        } catch (err) {
            throw new Error(`Config file not found ${RUNNERS_CONFIG}`)
        }
        const rawRunners = RawRunners.parse(parse(toml_str))

        // build each runner's base url and API key (fetched from the environment)
        // build a new map of only the ACTIVE ones
        const apis = new Map<string, LlmRunnerAPI>()

        for (const [runner, api] of Object.entries(rawRunners.apis)) {
            const key = process.env[api.key]

            if (key) { // don't want empty string either
                console.log(`Runner ${runner} ACTIVE`)
                apis.set(runner, { url: api.url, key: key })
            } else if (runner === "local") {
                if (api.url) {
                    console.log(`Local runner ${api.url} ACTIVE with API key: '${api.key}'`)
                    apis.set(runner, { url: api.url, key: api.key })
                } else {
                    console.log(`Local runner INACTIVE. No URL`)
                }
            } else {
                console.log(`Runner ${runner} INACTIVE: NO '${api.key}'`)
            }
        }

        if (apis.size === 0) {
            throw new Error("CRITICAL: No API keys found and no local LLM configured. Terminating process.")
        }

        // construct the full list of potential runners
        for (const runner of rawRunners.runners) {
            const api = apis.get(runner.api)
            if (api) {
                this.runners.push({
                    api: api,
                    model: runner.model,
                    weight: runner.weight
                })
            }
        }
        const local = apis.get("local")
        if (local?.url) {
            this.local = {
                api: local,
                model: "", // let agent set
                weight: 1.0
            }
        }
    }

    
}

