import type { Metadata } from "next";
import { BoxActions } from "./_components/box-actions";
import { BoxDetail } from "./_components/box-detail";
import { PageTemplate } from "@/components/page-template";
import { redirectIfSignedOut } from "@/lib/route-guards";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
	title: "Box"
};

export default async function BoxPage({
	params
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	await redirectIfSignedOut(`/boxes/${id}`);

	return (
		<PageTemplate
			actions={<BoxActions boxId={id} />}
			breadcrumbs={[
				{ href: "/boxes", icon: "washing-machine", label: "Boxes" },
				{ label: <BoxActions boxId={id} labelOnly /> }
			]}
		>
			<BoxDetail boxId={id} />
		</PageTemplate>
	);
}
