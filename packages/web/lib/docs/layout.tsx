import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { FumadocsThemeToggle } from "@/components/docs/theme-toggle";
import { Logo } from "@/components/logo";
import { GITHUB_REPO_URL } from "@/convex/model/links";

export function baseOptions(): BaseLayoutProps {
	return {
		slots: { navTitle: Logo, themeSwitch: FumadocsThemeToggle },
		githubUrl: GITHUB_REPO_URL
	};
}
