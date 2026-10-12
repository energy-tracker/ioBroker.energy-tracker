"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.accessTokenInput = accessTokenInput;
function accessTokenInput(value) {
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
        return JSON.parse(atob(header)).alg === 'HS512' &&
            claims &&
            typeof claims === 'object' &&
            !Array.isArray(claims)
            ? token
            : null;
    }
    catch {
        return null;
    }
}
