// Type definitions for @electron/remote (optional dependency)
declare module "@electron/remote" {
    export interface BrowserWindow {
        new (options?: Record<string, unknown>): {
            show(): void;
            loadURL(url: string): Promise<void>;
            destroy(): void;
            webContents: {
                session: {
                    cookies: {
                        get(filter: { domain: string }): Promise<Array<{
                            name: string;
                            value: string;
                        }>>;
                        flushStore(): Promise<void>;
                    };
                };
            };
        };
    }

    export const BrowserWindow: BrowserWindow;
}
