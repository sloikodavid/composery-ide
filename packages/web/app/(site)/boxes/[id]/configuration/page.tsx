import type { Metadata } from "next";
import { BoxActions } from "../_components/box-actions";
import { BoxConfiguration } from "./_components/box-configuration";
import { PageTemplate } from "@/components/page-template";
import { boxPath } from "@/convex/model/box/path";
import { redirectIfSignedOut } from "@/lib/route-guards";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
	title: "Configuration"
};

export default async function BoxConfigurationPage({
	params
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	await redirectIfSignedOut(`${boxPath(id)}/configuration`);

	return (
		<PageTemplate
			actions={<BoxActions boxId={id} />}
			breadcrumbs={[
				{ href: "/boxes", icon: "washing-machine", label: "Boxes" },
				{ href: boxPath(id), label: <BoxActions boxId={id} labelOnly /> },
				{ label: "Configuration" }
			]}
		>
			<BoxConfiguration boxId={id} />
		</PageTemplate>
	);
}
