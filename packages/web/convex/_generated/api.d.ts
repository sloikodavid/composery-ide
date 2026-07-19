/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as account_deletion from "../account/deletion.js";
import type * as account_deletionLogic from "../account/deletionLogic.js";
import type * as billing_polar from "../billing/polar.js";
import type * as billing_reconciliation from "../billing/reconciliation.js";
import type * as billing_webhooks from "../billing/webhooks.js";
import type * as boxes_autoRepair from "../boxes/autoRepair.js";
import type * as boxes_capacity from "../boxes/capacity.js";
import type * as boxes_cleanup from "../boxes/cleanup.js";
import type * as boxes_configuration from "../boxes/configuration.js";
import type * as boxes_counts from "../boxes/counts.js";
import type * as boxes_health from "../boxes/health.js";
import type * as boxes_infra_artifacts from "../boxes/infra/artifacts.js";
import type * as boxes_infra_cloudflareContracts from "../boxes/infra/cloudflareContracts.js";
import type * as boxes_infra_cloudflareDns from "../boxes/infra/cloudflareDns.js";
import type * as boxes_infra_hetznerContracts from "../boxes/infra/hetznerContracts.js";
import type * as boxes_infra_hetznerVps from "../boxes/infra/hetznerVps.js";
import type * as boxes_infra_host from "../boxes/infra/host.js";
import type * as boxes_infra_hostCredentials from "../boxes/infra/hostCredentials.js";
import type * as boxes_infra_hostScripts from "../boxes/infra/hostScripts.js";
import type * as boxes_infra_hostTransport from "../boxes/infra/hostTransport.js";
import type * as boxes_infra_image from "../boxes/infra/image.js";
import type * as boxes_infra_providerResponse from "../boxes/infra/providerResponse.js";
import type * as boxes_infra_registry from "../boxes/infra/registry.js";
import type * as boxes_infra_registryContracts from "../boxes/infra/registryContracts.js";
import type * as boxes_logs from "../boxes/logs.js";
import type * as boxes_metrics from "../boxes/metrics.js";
import type * as boxes_metricsPoll from "../boxes/metricsPoll.js";
import type * as boxes_operation_endpoint from "../boxes/operation/endpoint.js";
import type * as boxes_operation_event from "../boxes/operation/event.js";
import type * as boxes_operation_record from "../boxes/operation/record.js";
import type * as boxes_operation_start from "../boxes/operation/start.js";
import type * as boxes_operation_sweep from "../boxes/operation/sweep.js";
import type * as boxes_queries from "../boxes/queries.js";
import type * as boxes_reconcile from "../boxes/reconcile.js";
import type * as boxes_retention from "../boxes/retention.js";
import type * as boxes_slugAvailability from "../boxes/slugAvailability.js";
import type * as boxes_snapshotPolicy from "../boxes/snapshotPolicy.js";
import type * as boxes_snapshots from "../boxes/snapshots.js";
import type * as boxes_usage from "../boxes/usage.js";
import type * as boxes_version from "../boxes/version.js";
import type * as boxes_views from "../boxes/views.js";
import type * as boxes_workflows_boxWorkflow from "../boxes/workflows/boxWorkflow.js";
import type * as boxes_workflows_changeBoxConfig from "../boxes/workflows/changeBoxConfig.js";
import type * as boxes_workflows_changeBoxPassword from "../boxes/workflows/changeBoxPassword.js";
import type * as boxes_workflows_changeBoxSlug from "../boxes/workflows/changeBoxSlug.js";
import type * as boxes_workflows_createBox from "../boxes/workflows/createBox.js";
import type * as boxes_workflows_deleteBox from "../boxes/workflows/deleteBox.js";
import type * as boxes_workflows_repairBox from "../boxes/workflows/repairBox.js";
import type * as boxes_workflows_resetBox from "../boxes/workflows/resetBox.js";
import type * as boxes_workflows_runtimeLifecycle from "../boxes/workflows/runtimeLifecycle.js";
import type * as boxes_workflows_snapshotWorkflows from "../boxes/workflows/snapshotWorkflows.js";
import type * as boxes_workflows_startBox from "../boxes/workflows/startBox.js";
import type * as boxes_workflows_stopBox from "../boxes/workflows/stopBox.js";
import type * as boxes_workflows_suspendBox from "../boxes/workflows/suspendBox.js";
import type * as boxes_workflows_unsuspendBox from "../boxes/workflows/unsuspendBox.js";
import type * as boxes_workflows_updateBox from "../boxes/workflows/updateBox.js";
import type * as checkout_checkoutConversion from "../checkout/checkoutConversion.js";
import type * as checkout_checkoutIntents from "../checkout/checkoutIntents.js";
import type * as crons from "../crons.js";
import type * as email from "../email.js";
import type * as env from "../env.js";
import type * as http from "../http.js";
import type * as instance_auth from "../instance/auth.js";
import type * as instance_release from "../instance/release.js";
import type * as model_box_auth from "../model/box/auth.js";
import type * as model_box_billing from "../model/box/billing.js";
import type * as model_box_capacity from "../model/box/capacity.js";
import type * as model_box_certificate from "../model/box/certificate.js";
import type * as model_box_domain from "../model/box/domain.js";
import type * as model_box_metric from "../model/box/metric.js";
import type * as model_box_operation from "../model/box/operation.js";
import type * as model_box_path from "../model/box/path.js";
import type * as model_box_plan from "../model/box/plan.js";
import type * as model_box_recovery from "../model/box/recovery.js";
import type * as model_box_slug from "../model/box/slug.js";
import type * as model_box_snapshot from "../model/box/snapshot.js";
import type * as model_box_ssh from "../model/box/ssh.js";
import type * as model_box_status from "../model/box/status.js";
import type * as model_box_usage from "../model/box/usage.js";
import type * as model_legal from "../model/legal.js";
import type * as model_links from "../model/links.js";
import type * as model_settings from "../model/settings.js";
import type * as notice_account from "../notice/account.js";
import type * as notice_legal from "../notice/legal.js";
import type * as notice_owner from "../notice/owner.js";
import type * as owner_account from "../owner/account.js";
import type * as owner_boxConfig from "../owner/boxConfig.js";
import type * as owner_boxes from "../owner/boxes.js";
import type * as owner_checkout from "../owner/checkout.js";
import type * as settings from "../settings.js";
import type * as site_pricing from "../site/pricing.js";
import type * as site_stats from "../site/stats.js";
import type * as staff_alerts from "../staff/alerts.js";
import type * as staff_boxes from "../staff/boxes.js";
import type * as staff_checkout from "../staff/checkout.js";
import type * as staff_metrics from "../staff/metrics.js";
import type * as staff_settings from "../staff/settings.js";
import type * as staff_stats from "../staff/stats.js";
import type * as staff_users from "../staff/users.js";
import type * as time from "../time.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "account/deletion": typeof account_deletion;
  "account/deletionLogic": typeof account_deletionLogic;
  "billing/polar": typeof billing_polar;
  "billing/reconciliation": typeof billing_reconciliation;
  "billing/webhooks": typeof billing_webhooks;
  "boxes/autoRepair": typeof boxes_autoRepair;
  "boxes/capacity": typeof boxes_capacity;
  "boxes/cleanup": typeof boxes_cleanup;
  "boxes/configuration": typeof boxes_configuration;
  "boxes/counts": typeof boxes_counts;
  "boxes/health": typeof boxes_health;
  "boxes/infra/artifacts": typeof boxes_infra_artifacts;
  "boxes/infra/cloudflareContracts": typeof boxes_infra_cloudflareContracts;
  "boxes/infra/cloudflareDns": typeof boxes_infra_cloudflareDns;
  "boxes/infra/hetznerContracts": typeof boxes_infra_hetznerContracts;
  "boxes/infra/hetznerVps": typeof boxes_infra_hetznerVps;
  "boxes/infra/host": typeof boxes_infra_host;
  "boxes/infra/hostCredentials": typeof boxes_infra_hostCredentials;
  "boxes/infra/hostScripts": typeof boxes_infra_hostScripts;
  "boxes/infra/hostTransport": typeof boxes_infra_hostTransport;
  "boxes/infra/image": typeof boxes_infra_image;
  "boxes/infra/providerResponse": typeof boxes_infra_providerResponse;
  "boxes/infra/registry": typeof boxes_infra_registry;
  "boxes/infra/registryContracts": typeof boxes_infra_registryContracts;
  "boxes/logs": typeof boxes_logs;
  "boxes/metrics": typeof boxes_metrics;
  "boxes/metricsPoll": typeof boxes_metricsPoll;
  "boxes/operation/endpoint": typeof boxes_operation_endpoint;
  "boxes/operation/event": typeof boxes_operation_event;
  "boxes/operation/record": typeof boxes_operation_record;
  "boxes/operation/start": typeof boxes_operation_start;
  "boxes/operation/sweep": typeof boxes_operation_sweep;
  "boxes/queries": typeof boxes_queries;
  "boxes/reconcile": typeof boxes_reconcile;
  "boxes/retention": typeof boxes_retention;
  "boxes/slugAvailability": typeof boxes_slugAvailability;
  "boxes/snapshotPolicy": typeof boxes_snapshotPolicy;
  "boxes/snapshots": typeof boxes_snapshots;
  "boxes/usage": typeof boxes_usage;
  "boxes/version": typeof boxes_version;
  "boxes/views": typeof boxes_views;
  "boxes/workflows/boxWorkflow": typeof boxes_workflows_boxWorkflow;
  "boxes/workflows/changeBoxConfig": typeof boxes_workflows_changeBoxConfig;
  "boxes/workflows/changeBoxPassword": typeof boxes_workflows_changeBoxPassword;
  "boxes/workflows/changeBoxSlug": typeof boxes_workflows_changeBoxSlug;
  "boxes/workflows/createBox": typeof boxes_workflows_createBox;
  "boxes/workflows/deleteBox": typeof boxes_workflows_deleteBox;
  "boxes/workflows/repairBox": typeof boxes_workflows_repairBox;
  "boxes/workflows/resetBox": typeof boxes_workflows_resetBox;
  "boxes/workflows/runtimeLifecycle": typeof boxes_workflows_runtimeLifecycle;
  "boxes/workflows/snapshotWorkflows": typeof boxes_workflows_snapshotWorkflows;
  "boxes/workflows/startBox": typeof boxes_workflows_startBox;
  "boxes/workflows/stopBox": typeof boxes_workflows_stopBox;
  "boxes/workflows/suspendBox": typeof boxes_workflows_suspendBox;
  "boxes/workflows/unsuspendBox": typeof boxes_workflows_unsuspendBox;
  "boxes/workflows/updateBox": typeof boxes_workflows_updateBox;
  "checkout/checkoutConversion": typeof checkout_checkoutConversion;
  "checkout/checkoutIntents": typeof checkout_checkoutIntents;
  crons: typeof crons;
  email: typeof email;
  env: typeof env;
  http: typeof http;
  "instance/auth": typeof instance_auth;
  "instance/release": typeof instance_release;
  "model/box/auth": typeof model_box_auth;
  "model/box/billing": typeof model_box_billing;
  "model/box/capacity": typeof model_box_capacity;
  "model/box/certificate": typeof model_box_certificate;
  "model/box/domain": typeof model_box_domain;
  "model/box/metric": typeof model_box_metric;
  "model/box/operation": typeof model_box_operation;
  "model/box/path": typeof model_box_path;
  "model/box/plan": typeof model_box_plan;
  "model/box/recovery": typeof model_box_recovery;
  "model/box/slug": typeof model_box_slug;
  "model/box/snapshot": typeof model_box_snapshot;
  "model/box/ssh": typeof model_box_ssh;
  "model/box/status": typeof model_box_status;
  "model/box/usage": typeof model_box_usage;
  "model/legal": typeof model_legal;
  "model/links": typeof model_links;
  "model/settings": typeof model_settings;
  "notice/account": typeof notice_account;
  "notice/legal": typeof notice_legal;
  "notice/owner": typeof notice_owner;
  "owner/account": typeof owner_account;
  "owner/boxConfig": typeof owner_boxConfig;
  "owner/boxes": typeof owner_boxes;
  "owner/checkout": typeof owner_checkout;
  settings: typeof settings;
  "site/pricing": typeof site_pricing;
  "site/stats": typeof site_stats;
  "staff/alerts": typeof staff_alerts;
  "staff/boxes": typeof staff_boxes;
  "staff/checkout": typeof staff_checkout;
  "staff/metrics": typeof staff_metrics;
  "staff/settings": typeof staff_settings;
  "staff/stats": typeof staff_stats;
  "staff/users": typeof staff_users;
  time: typeof time;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  polar: import("@convex-dev/polar/_generated/component.js").ComponentApi<"polar">;
  resend: import("@convex-dev/resend/_generated/component.js").ComponentApi<"resend">;
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
};
