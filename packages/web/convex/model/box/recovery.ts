import { v, type Infer } from "convex/values";

export const vRuntimeComponentState = v.union(
	v.literal("active"),
	v.literal("inactive"),
	v.literal("missing"),
	v.literal("unknown")
);

export const vRuntimeEngine = v.union(
	v.literal("overlay"),
	v.literal("copy"),
	v.literal("unknown")
);

export const vRecoveryStatus = v.object({
	hostReachable: v.boolean(),
	httpReachable: v.boolean(),
	engine: vRuntimeEngine,
	docker: vRuntimeComponentState,
	outerCaddy: vRuntimeComponentState,
	composery: vRuntimeComponentState,
	persistence: vRuntimeComponentState,
	caddy: vRuntimeComponentState,
	ide: vRuntimeComponentState
});

export type RecoveryStatus = Infer<typeof vRecoveryStatus>;
