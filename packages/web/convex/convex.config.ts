import polar from "@convex-dev/polar/convex.config";
import resend from "@convex-dev/resend/convex.config";
import workflow from "@convex-dev/workflow/convex.config";
import { defineApp } from "convex/server";
import { CONVEX_ENV } from "./env";

const app = defineApp({ env: CONVEX_ENV });

app.use(polar);
app.use(resend);
app.use(workflow);

export default app;
