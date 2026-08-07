"use client";

import { ErrorPage, type ErrorBoundaryProps } from "@/components/error-page";

export default function SiteError(props: ErrorBoundaryProps) {
	return <ErrorPage {...props} />;
}
