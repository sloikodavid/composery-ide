"use client";

import { createOpenAPIPage } from "fumadocs-openapi/ui";

// No playground. It runs in the reader's browser, and the only server worth
// calling is their own instance on another origin - which CORS blocks, and the
// only way around that is a proxy here, routing someone's API key and their
// shell commands through this site to reach a machine we do not host. A button
// that cannot work is worse than no button.
export const OpenAPIPage = createOpenAPIPage({
	playground: { enabled: false }
});
