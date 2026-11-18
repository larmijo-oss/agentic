import { z as zod } from 'zod'

// zod copies .describe's text verbatim into the schema's description
// a `'` must be escaped. JS has no implicit concatenation, so it stays one line.
const CompletionSummary = zod.strictObject({
    completion: zod.string().describe('The complete response text for the user.'),
    summary: zod.string().describe(
        'A concise, deanaphorized summary for semantic retrieval: restate what the user asked and what was concluded, using the explicit entity and topic names that appear in the conversation. No pronouns (it, they, this, that) and no back-references — every sentence must make sense alone, as a standalone record in a vector store. Only names actually present in the conversation; no invented entities, no boilerplate framing ("The user asked about... and the assistant explained...").'
    )
})

function completionSummaryResponseFormat(): unknown {
    const schema: Record<string, unknown> = { ...zod.toJSONSchema(CompletionSummary) }
    delete schema.$schema
    return {
        type: 'json_schema',
        json_schema: { name: 'completion_summary', strict: true, schema }
    }
}

export const structuredResponseFormat = completionSummaryResponseFormat()

const LexPhase = {
    ObjectStart: 0,  // expect '{'
    Key: 1,          // expect the opening '"' of a property name
    KeyName: 2,      // capturing property-name chars
    Colon: 3,        // expect ':' after a property name
    Value: 4,        // expect the value's opening '"'
    InString: 5,     // inside a string value; target classifies spans
    AfterValue: 6,   // expect ',' (next property) or '}' (end)
    Done: 7          // swallow the rest
} as const
type LexPhase = (typeof LexPhase)[keyof typeof LexPhase]

export const LexTarget = { Completion: 0, Summary: 1 } as const
export type LexTarget = (typeof LexTarget)[keyof typeof LexTarget]

type LexSink = (target: LexTarget, data: string) => void

const LEXER_KEY_CAP = 16


// shared-transition table: phase → accepted char(s) → next phase
const TRANSITIONS: Partial<Record<LexPhase, Record<string, LexPhase>>> = {
    [LexPhase.ObjectStart]: { '{': LexPhase.Key },
    [LexPhase.Key]: { '"': LexPhase.KeyName },
    [LexPhase.Colon]: { ':': LexPhase.Value },
    [LexPhase.Value]: { '"': LexPhase.InString },
    [LexPhase.AfterValue]: { ',': LexPhase.Key, '}': LexPhase.Done },
}

export class CompletionLexer {
    private phase: LexPhase = LexPhase.ObjectStart
    private target: LexTarget = LexTarget.Completion
    private inEscape = false
    private key = ''
    private completionSeen = false
    private summarySeen = false
    fallback = false

    feed(fragment: string, sink: LexSink): string | null {
        if (this.fallback) return fragment

        let i = 0

        while (i < fragment.length) {
            switch (this.phase) {
                case LexPhase.ObjectStart:
                case LexPhase.Key:
                case LexPhase.Colon:
                case LexPhase.Value:
                case LexPhase.AfterValue: {
                    switch (fragment[i]) {
                        case ' ':
                        case '\t':
                        case '\n':
                        case '\r':
                            i++
                            break

                        default: {
                            const next = TRANSITIONS[this.phase]?.[fragment[i]!]
                            if (next === undefined) return this.latch(fragment, i)

                            switch (this.phase) {
                                case LexPhase.Key:
                                    this.key = ''
                                    break
                                case LexPhase.Value:
                                    this.inEscape = false
                                    break
                            }

                            this.phase = next
                            i++
                        }
                    }
                    break
                }

                case LexPhase.KeyName: {
                    const from = Math.max(i - this.key.length - 1, 0)

                    if (fragment[i] === '"') {
                        if (this.completionSeen && this.key === 'completion')
                            return this.latch(fragment, from)

                        if (this.summarySeen && this.key === 'summary')
                            return this.latch(fragment, from)

                        if (this.key === 'completion') {
                            this.completionSeen = true
                            this.target = LexTarget.Completion
                        } else if (this.key === 'summary') {
                            this.summarySeen = true
                            this.target = LexTarget.Summary
                        } else {
                            return this.latch(fragment, from)
                        }

                        this.phase = LexPhase.Colon
                        i++
                        break
                    }

                    if (this.key.length === LEXER_KEY_CAP)
                        return this.latch(fragment, from)

                    this.key += fragment.charAt(i)
                    i++
                    break
                }

                case LexPhase.InString: {
                    const spanStart = i
                    let closed = false

                    while (i < fragment.length) {
                        if (this.inEscape) {
                            this.inEscape = false
                            i++
                            continue
                        }

                        const at1 = fragment.indexOf('\\', i)
                        const at2 = fragment.indexOf('"', i)
                        const at = at1 === -1
                            ? at2
                            : at2 === -1
                                ? at1
                                : Math.min(at1, at2)

                        if (at === -1) {
                            i = fragment.length
                            break
                        }

                        if (fragment[at] === '\\') {
                            this.inEscape = true
                            i = at + 1
                        } else {
                            this.emit(spanStart, at, fragment, sink)
                            this.phase = LexPhase.AfterValue
                            i = at + 1
                            closed = true
                            break
                        }
                    }

                    if (!closed) this.emit(spanStart, i, fragment, sink)
                    break
                }

                case LexPhase.Done:
                    i = fragment.length
                    break
            }
        }

        return null
    }

    private latch(fragment: string, from: number): string {
        this.fallback = true
        return fragment.substring(from)
    }

    private emit(start: number, end: number, fragment: string, sink: LexSink) {
        if (start < end) {
            sink(this.target, fragment.substring(start, end))
        }
    }
}

function pushEscape(ch: string, frame: string[]) {
    switch (ch) {
        case 'n': frame.push('\n'); break
        case 'r': frame.push('\r'); break
        case 't': frame.push('\t'); break
        case '"': frame.push('"'); break
        case '\\': frame.push('\\'); break
        case '/': frame.push('/'); break
        case 'b': frame.push('\b'); break
        case 'f': frame.push('\f'); break
        case 'u': frame.push('\\u'); break   // \uXXXX passes through verbatim into the client stream and the DB capture — never decoded
        default: frame.push('\\', ch)
    }
}

function escapeFrame(span: string, frame: string[], pending: boolean): boolean {
    let rest = span

    // handle pending
    if (pending) {
        // an empty span must not consume the withheld backslash
        if (rest.length > 0) {
            pending = false
            pushEscape(rest.charAt(0), frame)
            rest = rest.substring(1)
        }
    }

    // handle backslash loop
     for (;;) {
        const at = rest.indexOf('\\')
        if (at === -1) {
            frame.push(rest)
            return pending
        }
        frame.push(rest.substring(0, at))
        if (at + 1 < rest.length) {
            pushEscape(rest.charAt(at + 1), frame)
            rest = rest.substring(at + 2)
        } else {
            return true
        }
    }
}

export class Capture {
    text: string[] = []
    pending = false

    push(span: string): void {
        this.pending = escapeFrame(span, this.text, this.pending)
    }

    flushPending(): boolean {
        if (!this.pending) return false
        this.text.push('\\')
        this.pending = false
        return true
    }
}

