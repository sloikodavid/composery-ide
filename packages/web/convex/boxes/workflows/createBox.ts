import { internal } from "../../_generated/api";
import { createRuntime } from "./runtimeLifecycle";
import { defineBoxWorkflow } from "./boxWorkflow";

export const createBox = defineBoxWorkflow({
	type: "create",
	run: async (step, args) => {
		try {
			const box = await step.runQuery(
				internal.boxes.queries.getBoxLifecycleSnapshot,
				{ boxId: args.boxId }
			);
			if (!box.runtime_image) {
				throw new Error("Box has no runtime image to provision.");
			}

			const release = await step.runAction(
				internal.boxes.infra.image.resolveRuntimeRelease,
				{ image: box.runtime_image },
				{ retry: true }
			);

			await step.runMutation(internal.boxes.operation.record.setRuntimeImage, {
				boxId: args.boxId,
				runtimeImage: release.image,
				runtimeVersion: release.version
			});

			await createRuntime(step, args.boxId, box.slug, box.plan);

			await step.runMutation(
				internal.boxes.operation.record.markCreateSucceeded,
				{
					boxId: args.boxId,
					operationId: args.operationId
				}
			);
		} catch (provisionError) {
			const failedBox = await step.runQuery(
				internal.boxes.queries.getBoxLifecycleSnapshot,
				{ boxId: args.boxId }
			);
			// A comp was never paid for, so there is nothing to refund - let it fail
			// to provisioning_failed for a staff retry.
			if (failedBox.comped_at !== undefined) throw provisionError;

			const paidOrder = await step.runQuery(
				internal.checkout.checkoutIntents.paidOrderForBox,
				{ boxId: args.boxId }
			);
			if (!paidOrder) {
				throw new Error(
					`Initial provisioning failed and its paid Polar order could not be found: ${provisionError instanceof Error ? provisionError.message : String(provisionError)}`
				);
			}

			await step.runAction(
				internal.billing.polar.revokeAndRefundOrder,
				{
					comment: "Composery could not complete initial service delivery.",
					idempotencyKey: `fulfillment-failure:${args.boxId}`,
					orderId: paidOrder.orderId,
					subscriptionId: paidOrder.subscriptionId
				},
				{ retry: true }
			);
			throw provisionError;
		}
	}
});
