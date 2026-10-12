import type {} from './host.d';

/** The stable host APIs used by this component in Admin 7 and Admin 8. */
export interface HostReact {
    /** Create an element using the Admin's React singleton. */
    createElement(type: unknown, props: unknown, ...children: unknown[]): JSX.Element;
    /** Register and clean up component effects. */
    useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]): void;
    /** Hold the request cancellation and coalescing flags. */
    useRef<T>(value: T): { current: T };
    /** Keep the local button state. */
    useState<T>(value: T): [T, (value: T) => void];
}

type Component = (props: Record<string, unknown>) => JSX.Element;
interface Translation {
    getLanguage(): string;
    t(key: string, ...args: string[]): string;
}
interface SharedModule {
    loaded?: boolean;
    get(): Promise<() => unknown> | (() => unknown);
}
export type ShareScope = Record<string, Record<string, SharedModule>>;

export let React: HostReact;
export let Button: Component;
export let InfoBox: Component;
export let I18n: Translation;

/**
 * Module federation passes the Admin's shared modules to the remote's init function.
 * Use those instances directly, without bundling another React, MUI or GUI library.
 *
 * @param scope Shared modules provided by ioBroker Admin
 */
export async function init(scope: ShareScope): Promise<void> {
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
        consume<{ Button: Component }>('@mui/material'),
        consume<{ InfoBox: Component; I18n: Translation }>(library),
    ]);
    React = react;
    Button = material.Button;
    InfoBox = gui.InfoBox;
    I18n = gui.I18n;
}
