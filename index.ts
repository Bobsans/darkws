// JSON types
type JsonPrimitive = string | number | boolean | null;
type JsonArray = JsonValue[] | readonly JsonValue[];
type JsonObject = { [K in string]: JsonValue } & { [K in string]?: JsonValue | undefined };
type JsonValue = JsonPrimitive | JsonArray | JsonObject;
type JsonifiableObject = { [K in string]?: Jsonifiable } | { toJSON: () => Jsonifiable };
type JsonifiableArray = readonly Jsonifiable[];
type Jsonifiable = JsonPrimitive | JsonifiableObject | JsonifiableArray;

// DarkWS
export interface DarkWSOptions {
    /**
     * WebSocket protocol<br> Default: from page protocol (http -> ws, https -> wss)
     */
    protocol: 'ws' | 'wss';
    /**
     * Host to connect<br> Default: current host
     */
    host: string;
    /**
     * Port to connect<br> Default: current host
     */
    port: number | undefined;
    /**
     * Path of DarkWS server listener<br> Default: `/ws/`
     */
    path: string;
    /**
     * Is need to reconnect after connection lost<br> Default: `true`
     */
    reconnect: boolean;
    /**
     * Reconnect interval in milliseconds<br> Default: `1000` (1s)
     */
    reconnectTimeout: number; // milliseconds
    /**
     * Count of reconnect attempts before error rising<br> Default: `120`
     */
    reconnectAttempts: number;
    /**
     * Timeout in milliseconds before request canceling by timeout<br> Default: `300000` (5m)
     */
    requestTimeout: number; // milliseconds
    /**
     * Enables debug mode<br> Default: `false`
     */
    debug: boolean;
}

interface DarkWSInterceptorMap {
    open: (event: Event) => void;
    close: (event: CloseEvent) => void;
    error: (event: Event) => void;
    reconnect: (attempt: number) => void;
    message: (data: any, event: MessageEvent<string>) => void;
    broadcast: (data: BroadcastMessage, event: MessageEvent<string>) => void;
}

type DarkWSInterceptors = { [K in keyof DarkWSInterceptorMap]: DarkWSInterceptorMap[K][] };

interface BroadcastMessage {
    key: string;
    data: any;
}

interface ErrorMessage {
    code: string;
    message: string;
}

const defaultOptions: DarkWSOptions = {
    protocol: window.location.protocol === 'https:' ? 'wss' : 'ws',
    host: window.location.host,
    port: window.location.port ? parseInt(window.location.port) : undefined,
    path: '/ws/',
    reconnect: true,
    reconnectTimeout: 1000,
    reconnectAttempts: 120,
    requestTimeout: 1000 * 60 * 5,
    debug: false
};

export interface DarkWSPromise<T> {
    then: (handler: (data: T) => any) => DarkWSPromise<T>;
    catch: (handler: (error: ErrorMessage) => any) => DarkWSPromise<T>;
}

export class DarkWS {
    private readonly options: DarkWSOptions;
    private socket: WebSocket | null = null;
    private requests: Record<string, { resolve: (value: any) => void, reject: (reason?: any) => void }> = {};
    private connectingPromise: Promise<WebSocket> | null = null;
    private reconnectAttempt: number = 0;
    private interceptors: DarkWSInterceptors = {
        open: [],
        close: [],
        error: [],
        reconnect: [],
        message: [],
        broadcast: []
    };

    constructor(options: Partial<DarkWSOptions> = {}) {
        this.options = Object.assign({}, defaultOptions, options);
        this.connect();
    }

    private debug(...args: any[]) {
        if (this.options.debug && typeof console?.debug === 'function') {
            console.debug('DarkWS ::', ...args);
        }
    }

    private generateKey() {
        return Math.random().toString(26).substring(2, 8);
    };

    private get url() {
        const {protocol, host, port, path} = this.options;
        return `${protocol}://${host}${port ? `:${port}` : ''}/${path ? path.replace(/^\/+/, '') : ''}`;
    }

    private connect() {
        this.socket && this.socket.close();

        this.socket = new WebSocket(this.url);

        this.socket.onopen = (event) => {
            this.debug('Connected', event);

            this.callInterceptors('open', event);
        };

        this.socket.onclose = (event) => {
            if (event.wasClean) {
                this.debug('Connection closed. [code:', event.code, ', reason:', event.reason, ']');
            } else {
                this.debug('Connection aborted. [code:', event.code, ', reason:', event.reason, ']');

                if (this.options.reconnect && this.reconnectAttempt < this.options.reconnectAttempts) {
                    this.debug(`[${this.reconnectAttempt + 1}] Reconnecting...`);
                    setTimeout(() => this.connect(), this.options.reconnectTimeout);
                    this.reconnectAttempt++;
                    this.callInterceptors('reconnect', this.reconnectAttempt);
                } else {
                    this.debug('Connection failed...');
                }
            }

            this.callInterceptors('close', event);
        };

        this.socket.onerror = (event) => {
            this.debug('Error:', event);

            this.callInterceptors('error', event);
        };

        this.socket.onmessage = (event: MessageEvent<string>) => {
            if (event.data === 'ping') {
                this._send('pong').then(() => {
                    this.debug('Ping handled');
                });
                return;
            }

            try {
                const [key = '@', _data] = event.data.split('|', 2);
                const data = JSON.parse(_data);

                if (key === '@') {
                    this.callInterceptors('broadcast', data, event);
                } else {
                    const resolver = this.requests[key];

                    if (resolver) {
                        if (data.error?.code) {
                            resolver.reject(data);
                        } else {
                            resolver.resolve(data);
                        }
                        delete this.requests[key];
                    }
                    this.callInterceptors('message', data, event);
                }
            } catch (ex: Error | any) {
                console.warn(ex instanceof SyntaxError ? 'Received invalid JSON.' : ex.message);
            }
        };
    }

    private waitForConnection(): Promise<WebSocket> {
        return this.connectingPromise ??= new Promise<WebSocket>((resolve) => {
            const handle = setInterval(() => {
                if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                    clearInterval(handle);
                    resolve(this.socket);
                    this.connectingPromise = null;
                }
            }, 50);
        });
    }

    private _send(data: string) {
        return this.waitForConnection().then(() => {
            this.socket?.send(data);
        });
    }

    /**
     * Send custom data to the server
     * @param data Any JSON-serializable data
     */
    public send(data: Jsonifiable) {
        return this._send(`@|${JSON.stringify(data)}`);
    }

    /**
     * Make request to server
     * @param action Action to handle
     * @param data Any JSON-serializable data
     */
    public request<T>(action: string, data?: Jsonifiable): DarkWSPromise<T> {
        return new Promise((resolve, reject) => {
            const key = this.generateKey();
            return this._send(`${key}|${action}${data !== undefined ? `|${JSON.stringify(data)}` : ''}`).then(() => {
                if (this.options.requestTimeout) {
                    const handle = setTimeout(() => {
                        delete this.requests[key];
                        reject({code: 'timeout', message: 'Request cancelled by timeout'});
                    }, this.options.requestTimeout);

                    this.requests[key] = {
                        resolve: (...args) => {
                            clearTimeout(handle);
                            resolve(...args);
                        },
                        reject
                    };
                } else {
                    this.requests[key] = {resolve, reject};
                }
            });
        });
    }

    /**
     * Subscribe to an event
     * @param event Event from `DarkWSInterceptorMap`
     * @param handler Handler function
     * @returns Unsubscribe action
     */
    public intercept<K extends keyof DarkWSInterceptorMap, T extends DarkWSInterceptorMap[K]>(event: K, handler: T) {
        const group = this.interceptors[event];
        group.push(handler);
        return () => group.splice(group.indexOf(handler), 1);
    }

    private callInterceptors<K extends keyof DarkWSInterceptorMap, T extends DarkWSInterceptorMap[K]>(event: K, ...args: Parameters<T>) {
        if (this.interceptors[event]?.length) {
            for (const func of this.interceptors[event]) {
                (func as any)(...args);
            }
        }
    }
}
