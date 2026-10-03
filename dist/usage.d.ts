import type { KiroCredentials } from "./oauth.js";
/** Fields usage lookup reads; any OAuth credential (Pi's or OMP's projection) satisfies it. */
export type KiroUsageCredential = Pick<KiroCredentials, "access"> & Partial<Pick<KiroCredentials, "region" | "profileArn">>;
type EpochLike = number | string;
interface KiroFreeTrialInfo {
    freeTrialStatus?: string;
    freeTrialExpiry?: EpochLike;
    currentUsage?: number;
    currentUsageWithPrecision?: number;
    usageLimit?: number;
    usageLimitWithPrecision?: number;
}
interface KiroUsageBreakdown {
    resourceType?: string;
    displayName?: string;
    displayNamePlural?: string;
    currentUsage: number;
    currentUsageWithPrecision?: number;
    currentOverages: number;
    currentOveragesWithPrecision?: number;
    usageLimit: number;
    usageLimitWithPrecision?: number;
    unit?: string;
    overageCharges: number;
    currency?: string;
    overageRate?: number;
    nextDateReset?: EpochLike;
    overageCap?: number;
    overageCapWithPrecision?: number;
    freeTrialInfo?: KiroFreeTrialInfo;
}
interface KiroUsageLimitList {
    type?: string;
    currentUsage?: number;
    totalUsageLimit?: number;
    percentUsed?: number;
}
export interface KiroGetUsageLimitsResponse {
    limits?: KiroUsageLimitList[];
    nextDateReset?: EpochLike;
    daysUntilReset?: number;
    usageBreakdown?: KiroUsageBreakdown;
    usageBreakdownList?: KiroUsageBreakdown[];
    subscriptionInfo?: {
        subscriptionTitle?: string;
    };
    overageConfiguration?: {
        overageStatus?: string;
    };
    userInfo?: {
        userId?: string;
        email?: string;
    };
}
export interface KiroProviderUsageBonus {
    label: string;
    usedDisplay?: string;
    limitDisplay?: string;
    /** Raw numeric used/limit, mirroring {@link KiroProviderUsageBucket}. */
    used?: number;
    limit?: number;
    expiresAt?: string;
}
export interface KiroProviderUsageBucket {
    id: string;
    label: string;
    resourceType?: string;
    usedDisplay: string;
    limitDisplay?: string;
    /** Raw numeric used/limit, retained so consumers can compute a percentage without parsing display strings. */
    used?: number;
    limit?: number;
    unit?: string;
    overagesDisplay?: string;
    overageChargesDisplay?: string;
    resetAt?: string;
    bonus?: KiroProviderUsageBonus;
}
export interface KiroProviderUsage {
    summary?: string;
    subscriptionTitle?: string;
    resetAt?: string;
    daysUntilReset?: number;
    overageStatus?: string;
    manageUrl?: string;
    usageBuckets?: KiroProviderUsageBucket[];
    raw?: Record<string, unknown>;
}
export declare function fetchKiroUsage(credentials: KiroUsageCredential): Promise<KiroProviderUsage>;
export {};
