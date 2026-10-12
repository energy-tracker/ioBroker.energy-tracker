/** React hooks provided by the Admin's shared React instance. */
interface HostReact {
    /** Create a host-rendered element. */
    createElement(type: unknown, props: unknown, ...children: unknown[]): unknown;
    /** Register an effect and its cleanup. */
    useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]): void;
    /** Hold a component-local reference. */
    useRef<T>(value: T): { current: T };
    /** Hold component-local state. */
    useState<T>(value: T): [T, (value: T) => void];
}
interface Translation {
    getLanguage(): string;
    t(key: string, ...args: string[]): string;
}
interface SharedModule {
    loaded?: boolean;
    get(): Promise<() => unknown> | (() => unknown);
}

export let React: HostReact;
export let Material: Record<string, unknown>;
export let I18n: Translation;

/**
 * @param scope Module-federation shares supplied by ioBroker Admin
 */
export async function init(scope: Record<string, Record<string, SharedModule>>): Promise<void> {
    const consume = async <T>(name: string): Promise<T> => {
        const versions = Object.values(scope[name] ?? {});
        const module = versions.find(version => version.loaded) ?? versions[0];
        if (!module) {
            throw new Error(`ioBroker Admin does not share ${name}`);
        }
        return (await module.get())() as T;
    };
    const library = scope['@iobroker/gui-components'] ? '@iobroker/gui-components' : '@iobroker/adapter-react-v5';
    const [react, material, gui] = await Promise.all([
        consume<HostReact>('react'),
        consume<Record<string, unknown>>('@mui/material'),
        consume<{ I18n: Translation }>(library),
    ]);
    React = react;
    Material = material;
    I18n = gui.I18n;
}
