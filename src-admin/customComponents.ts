import { TokenInfo } from './TokenInfo';
import { AdminLayout } from './AdminLayout';
export { init } from './host';

/**
 * @param name Module requested by ioBroker JSONConfig
 * @returns Factory exposing the configuration controls
 */
export function get(name: string): () => { default: { TokenInfo: typeof TokenInfo; AdminLayout: typeof AdminLayout } } {
    if (name !== './Components') {
        throw new Error(`Unknown Energy Tracker Admin module: ${name}`);
    }
    return () => ({ default: { TokenInfo, AdminLayout } });
}
