import Image from "next/image";
import { cn } from "@/lib/utils";

// A product screenshot that swaps with the theme so the shot always matches the
// page it sits on: the light UI render on light pages, the dark UI render on
// dark pages. The device frame (shadow, bezel, hairline) is what separates the
// image from the page, not a contrasting theme.
export function ThemedShot({
	base,
	alt,
	width,
	height,
	className,
	sizes,
	priority
}: {
	base: string;
	alt: string;
	width: number;
	height: number;
	className?: string;
	sizes?: string;
	priority?: boolean;
}) {
	const common = { width, height, sizes, priority };
	return (
		<>
			<Image
				alt={alt}
				{...common}
				className={cn("dark:hidden", className)}
				src={`/marketing/${base}-light.png`}
			/>
			<Image
				alt={alt}
				{...common}
				className={cn("hidden dark:block", className)}
				src={`/marketing/${base}-dark.png`}
			/>
		</>
	);
}
