import type { FunctionReturnType } from "convex/server";

import type { api } from "@/convex/_generated/api";

// Everything the box page reads about one box, and the row the box list reads for
// every box. Both are the queries' own return types rather than a second copy of
// them, so a field added to `safeBox` reaches the surfaces that take one whole
// without anyone editing a shape here.
//
// The two surfaces differ in what they hold, not in what a box is: a list row
// carries only `OwnerBox`, and the rest arrives when its menu first opens.
export type BoxDetail = NonNullable<
	FunctionReturnType<typeof api.owner.boxes.getById>
>;

export type OwnerBox = BoxDetail["box"];
