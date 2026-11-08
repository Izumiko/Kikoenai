/*
 * Minimal ambient types for `tunnel-agent` 0.6.0.
 *
 * The package ships no declarations and there is no `@types/tunnel-agent` on
 * npm (checked: 404), so this declares exactly the surface `scraper/axios.ts`
 * uses. Every factory returns a `http.Agent` subclass; the `https*` variants
 * additionally set `defaultPort = 443` and tunnel through CONNECT.
 */
declare module 'tunnel-agent' {
  import type { Agent } from 'node:http';

  /** The proxy end of the tunnel. */
  interface TunnelProxyOptions {
    /** Proxy host; the package defaults to `localhost` when absent. */
    host?: string;
    port: number;
    /** `user:password`, sent as Proxy-Authorization. */
    proxyAuth?: string;
    headers?: Record<string, string>;
  }

  export interface TunnelAgentOptions {
    proxy?: TunnelProxyOptions;
    maxSockets?: number;
  }

  export function httpOverHttp(options?: TunnelAgentOptions): Agent;
  export function httpsOverHttp(options?: TunnelAgentOptions): Agent;
  export function httpOverHttps(options?: TunnelAgentOptions): Agent;
  export function httpsOverHttps(options?: TunnelAgentOptions): Agent;
}
