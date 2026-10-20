import { type KiroProviderUsage } from "./usage.js";
type OmpUsageStatus = "ok" | "warning" | "exhausted" | "unknown";
/** Structural subset of OMP's `UsageCredential`. */
export interface OmpUsageCredential {
    type: "api_key" | "oauth";
    apiKey?: string;
    accessToken?: string;
    region?: string;
}
/** Structural subset of OMP's `UsageFetchParams`. */
export interface OmpUsageFetchParams {
    provider: string;
    credential: OmpUsageCredential;
}
/** Structural subset of OMP's `UsageLimit`. */
export interface OmpUsageLimit {
    id: string;
    label: string;
    scope: {
        provider: string;
        windowId?: string;
    };
    window?: {
        id: string;
        label: string;
        resetsAt?: number;
        resetLabel?: string;
    };
    amount: {
        used?: number;
        limit?: number;
        remaining?: number;
        usedFraction?: number;
        remainingFraction?: number;
        unit: "credits" | "unknown";
    };
    status?: OmpUsageStatus;
    notes?: string[];
}
/** Structural subset of OMP's `UsageReport`. */
export interface OmpUsageReport {
    provider: string;
    fetchedAt: number;
    limits: OmpUsageLimit[];
    notes?: string[];
    metadata?: Record<string, unknown>;
}
/** Structural subset of OMP's `UsageProvider`. */
export interface OmpUsageProvider {
    id: string;
    cacheVersion: number;
    supports(params: OmpUsageFetchParams): boolean;
    fetchUsage(params: OmpUsageFetchParams): Promise<OmpUsageReport | null>;
}
/** Map the provider-neutral Kiro usage shape into an OMP `UsageReport`. */
export declare function toOmpUsageReport(usage: KiroProviderUsage, fetchedAt?: number): OmpUsageReport;
/**
 * Usage provider registered on OMP via `registerProvider("kiro", { usage })`.
 * Profile ARN and region resolution reuse `fetchKiroUsage`, so OAuth and
 * `ksk_` API keys follow the same management-plane path as the Pi footer.
 * Failures throw; OMP's AuthStorage logs them and serves the last good report.
 */
export declare const kiroOmpUsageProvider: OmpUsageProvider;
export {};
