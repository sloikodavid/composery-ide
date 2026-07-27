import type { Metadata } from "next";
import { BoxActions } from "./_components/actions";
import { BoxDetail } from "./_components/detail";
import { BoxLinks } from "./_components/links";
import { PageTemplate } from "@/components/page-template";
import { notFoundIfNotStaff } from "@/lib/route-guards";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
	title: "Console Box",
	robots: { index: false, follow: false }
};

export default async function ConsoleBoxPage({
	params
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	await notFoundIfNotStaff();

	return (
		<PageTemplate
			actions={<BoxActions boxId={id} />}
			breadcrumbs={[
				{ href: "/console", icon: "layout-grid", label: "Console" },
				{
					label: (
						<span className="inline-flex items-center gap-1">
							<BoxLinks boxId={id} showSlug />
						</span>
					)
				}
			]}
		>
			<BoxDetail boxId={id} />
		</PageTemplate>
	);
}
