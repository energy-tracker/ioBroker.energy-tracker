export {};

declare global {
    namespace JSX {
        interface Element {
            type: unknown;
            props: unknown;
        }
        interface IntrinsicElements {
            div: Record<string, unknown>;
            p: Record<string, unknown>;
            b: Record<string, unknown>;
            span: Record<string, unknown>;
        }
    }
    interface Window {
        /** Loaded by JSONConfig for the encrypted password control. */
        CryptoJS: { SHA256(value: string): { toString(): string } };
    }
}
