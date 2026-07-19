import type { AuthConfig } from "convex/server";
import { requiredEnv } from "./env";

export default {
	providers: [
		{
			domain: requiredEnv("CLERK_FRONTEND_API_URL"),
			applicationID: "convex"
		}
	]
} satisfies AuthConfig;
