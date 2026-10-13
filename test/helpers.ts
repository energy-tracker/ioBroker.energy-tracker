interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
}

/**
 * @returns A promise and resolver for controlling an asynchronous test operation
 */
export function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(complete => {
        resolve = complete;
    });
    return { promise, resolve };
}

/**
 * @param action Synchronous operation expected to throw
 * @returns The thrown value, or undefined when the operation succeeds
 */
export function captureError(action: () => unknown): unknown {
    try {
        action();
        return undefined;
    } catch (error) {
        return error;
    }
}
/** Structurally complete HS512 credential used only with mocked API transports. */
export const TEST_ACCESS_TOKEN = `eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0In0.${'A'.repeat(86)}`;
