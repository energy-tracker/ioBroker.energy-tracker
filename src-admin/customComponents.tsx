import { TokenInfo } from './src/Components';

export { init } from './host';

/**
 * Standard module-federation container contract used by JSONConfig's custom control.
 *
 * @param name Module requested by ioBroker Admin
 * @returns Factory for the exposed component module
 */
export function get(name: string): () => { default: { TokenInfo: typeof TokenInfo } } {
    if (name !== './Components') {
        throw new Error(`Unknown Energy Tracker Admin module: ${name}`);
    }
    return () => ({ default: { TokenInfo } });
}
