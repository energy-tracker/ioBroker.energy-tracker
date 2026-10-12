/**
 * @param value Draft credential from the configuration view
 * @returns A complete JWT-shaped credential, without claiming its signature is valid
 */
export function accessTokenInput(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const token = value.trim();
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/.test(token)) {
        return null;
    }
    try {
        const [header, payload] = token.split('.').map(part => part.replace(/-/g, '+').replace(/_/g, '/'));
        const claims = JSON.parse(atob(payload));
        // The public API signs HS512 tokens; a complete signature contains 86 base64url characters.
        return JSON.parse(atob(header)).alg === 'HS512' &&
            claims &&
            typeof claims === 'object' &&
            !Array.isArray(claims)
            ? token
            : null;
    } catch {
        return null;
    }
}
