
const tails = new Map<string, Promise<void>>()

export async function acquireApp(
    appID: string
): Promise<() => void> {
    const previous = tails.get(appID) ?? Promise.resolve()

    let release!: () => void

    const current = new Promise<void>(resolve => {
        release = resolve
    })

    tails.set(appID, current)

    await previous

    return () => {
        if (tails.get(appID) === current) {
            tails.delete(appID)
        }

        release()
    }
}

