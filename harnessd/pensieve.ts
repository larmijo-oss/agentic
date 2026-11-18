import HttpStatus from 'http-status-codes'

import type { FastifyHttp2Instance } from './main.js'
import type { Message } from './handlers.js'

const MAX_RECENT_TURNS = 20             // newest turns served verbatim from retrieveHistory,
                                        // lower it for smaller demo conversations
const MAX_FALLBACK_TURNS = 200          // newest turns served when recall is unavailable
const MAX_VECTOR_LEG_CANDIDATES = 48    // vector leg candidate depth before selection
const MAX_RECALL_ITEMS = 24             // hydration cap; hard ceiling on recall bullets
const MAX_RECALL_CHARS = 16_000         // recall block budget in display chars (~4K tokens)
export const MAX_RECALL_ITEM_CHARS = 4000         // recalled user-utterance chars per turn

// OpenAI embeddings response: {"data": [{"embedding": [...], ...}, ...]}
type EmbeddingResponse = { data?: { embedding?: number[] }[] }

export function promptPlaintext(promptJson: string | Buffer): string {
    let parsed: unknown
    try { parsed = JSON.parse(promptJson.toString()) } catch { return '' }
    if (!Array.isArray(parsed)) return ''

    const utterances: string[] = []
    for (const raw of parsed) {
        if (raw === null || typeof raw !== 'object') continue
        const message = raw as { role?: unknown; content?: unknown }
        if (message.role !== 'user') continue
        const content = message.content
        if (typeof content === 'string') {
            if (content) utterances.push(content)
        } else if (Array.isArray(content)) {
            // array content (multimodal) yields its text parts
            for (const part of content) {
                if (part === null || typeof part !== 'object') continue
                const text = (part as { text?: unknown }).text
                if (typeof text === 'string' && text) utterances.push(text)
            }
        }
    }
    return utterances.join('\n')
}

let localEmbedChain: Promise<void> = Promise.resolve()
let embedLongInputWarned = false

export async function embedText(app: FastifyHttp2Instance, text: string): Promise<number[]> {
    const embed = app.runners.embed
    if (!embed) throw new Error('no embedding runner configured')

    // handle warn-once
	 const inputCap = embed.api === null ? 2_000 : 24_000
    if (!embedLongInputWarned && text.length > inputCap) {
        embedLongInputWarned = true
        console.warn(`embed input exceeds the ~${inputCap}-char embedder context; the tail is truncated or rejected by the embedder, not by this check`)
    }

    // handle local embed
        if (embed.api === null) {
        const run = localEmbedChain.then(async () =>
            ((await embed.session.embed([text]).next()).value ?? [])[0])
        localEmbedChain = run.then(() => undefined, () => undefined)
        const embedding = await Promise.race([
            run,
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('local embed timed out')), 15_000).unref()),
        ])
        return acceptEmbedding(embed.dim, embedding)
    }

    // handle cloud embed
    const fullUrl = new URL(`${embed.api.url}/v1/embeddings`)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (embed.api.key) headers['Authorization'] = `Bearer ${embed.api.key}`

    const response = await app.client.request({
        origin: fullUrl.origin,
        path: fullUrl.pathname + fullUrl.search,
        method: 'POST',
        headers,
        body: JSON.stringify({ model: embed.model, input: [text] }),
        headersTimeout: 15_000,
        bodyTimeout: 300_000,
    })
    if (response.statusCode !== HttpStatus.OK) {
        response.body?.destroy()
        throw new Error(`embedding runner returned ${response.statusCode}`)
    }

    const parsed = await response.body.json() as EmbeddingResponse
    return acceptEmbedding(embed.dim, parsed.data?.[0]?.embedding)
}

function acceptEmbedding(dim: number, embedding: number[] | undefined): number[] {
    if (!embedding || embedding.length !== dim) {
        throw new Error(`embedding dim ${embedding?.length ?? 0}, expected ${dim}`)
    }

    const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0))
    if (!Number.isFinite(norm) || norm <= 0) throw new Error(`degenerate embedding norm ${norm}`)
    for (let i = 0; i < embedding.length; i++) embedding[i] = embedding[i]! / norm
    return embedding
}

export function blobFromUnit(embedding: number[]): Buffer {
    const blob = Buffer.alloc(embedding.length * 4)
    embedding.forEach((value, idx) => blob.writeFloatLE(value, idx * 4))
    return blob
}

export function capRunes(text: string, cap: number): [string, number] {
    let builder = ''
    let count = 0
    for (const ch of text) {
        if (count === cap) break
        builder += ch
        count++
    }
    return [builder, count]
}

type Recall = { turnID: number; prompt: string }

export async function recallBlock(app: FastifyHttp2Instance, appID: string, prompt: string): Promise<{ recall: Recall[]; historyFloor: number }> {
    let recall: Recall[] = []
    try {
        const gate = app.sql.recallGate.get(appID, MAX_RECENT_TURNS + 1, MAX_RECENT_TURNS) as { count: number; scanFloor: number }
        if (gate.count <= MAX_RECENT_TURNS) {
            // 0..=MAX_RECENT_TURNS turns: the window serves everything, floor stays 0
            return { recall, historyFloor: 0 }
        }
        recall = await recallTurns(app, appID, prompt, gate.scanFloor)
        if (recall.length > 0) {
            return { recall, historyFloor: gate.scanFloor }
        }
    } catch (err: any) {
        console.error(`recall failed (serving the fallback window): ${err.message}`)
    }

    return { recall, historyFloor: (app.sql.recallGate.get(appID, MAX_FALLBACK_TURNS + 1, MAX_FALLBACK_TURNS) as { scanFloor: number }).scanFloor }
}

async function recallTurns(app: FastifyHttp2Instance, appID: string, prompt: string, scanFloor: number): Promise<Recall[]> {
    const embedding = app.runners.embed === null || app.sql.recall === null
        ? []
        : await embedText(app, prompt).catch((err: any) => {
            console.error(`vector scan unavailable (bounded fallback window will serve): ${err.message}`)
            return [] as number[]
        })

    if (embedding.length === 0) return []

    // handle vector scan and hydrate
	  const vecIDs = (app.sql.recall!.selectVectorLeg.all(blobFromUnit(embedding), appID, scanFloor, MAX_VECTOR_LEG_CANDIDATES) as { rowid: number }[]).map(row => row.rowid)
    if (vecIDs.length === 0) return []

    const ids = vecIDs.slice(0, MAX_RECALL_ITEMS)
    const rows = app.sql.hydrateRecall.all(JSON.stringify(ids)) as { turnID: number; prompt: Buffer }[]
    const byID = new Map(rows.map(row => [row.turnID, row]))
    const recall: Recall[] = []
    let remaining = MAX_RECALL_CHARS
    for (const turnID of ids) {
        const row = byID.get(turnID)
        if (row === undefined) continue
        const [prompt, cost] = capRunes(promptPlaintext(row.prompt), MAX_RECALL_ITEM_CHARS)
        if (cost === 0 || cost > remaining) continue
        remaining -= cost
        recall.push({ turnID, prompt })
    }

    return recall
}

export function recallMessage(recall: Recall[]): Message {
    return {
        role: 'system',
        content: 'Semantic search results from earlier turns in this conversation matching current prompt:\n'
            + recall.map(item => `- [turn ${item.turnID}] ${item.prompt}\n`).join(''),
    }
}

