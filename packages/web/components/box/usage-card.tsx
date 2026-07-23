import { ToneIcon } from "@/components/box/tone-icon";
import { formatDate, formatDateTime } from "@/lib/datetime";
import { usageMeter, type UsageReading } from "@/lib/box/usage";
import { cn } from "@/lib/utils";

// What this box has spent of what it is allowed, as one meter per signal.
//
// It sits on the page rather than inside a dialog because that is the whole
// point of moving it: disk used to be a row in the Repair dialog, which meant an
// owner learned their disk was filling only by opening the tool for a box that
// had already broken. A limit is worth knowing before it is reached, so it is on
// the page whether or not anything is wrong.
//
// Both surfaces that show a box render this - the owner's page and the console -
// so staff and the customer are reading one account of the same numbers.

const BAR_TONE = {
	ok: "bg-success",
	warn: "bg-warning",
	bad: "bg-destructive",
	muted: "bg-muted-foreground/40"
} as const;

function Meter({ reading }: { reading: UsageReading }) {
	const { label, detail, percent, advice, tone } = usageMeter(reading);

	return (
		<div className="min-w-0 flex-1 space-y-2">
			<div className="flex items-center justify-between gap-3">
				<div className="flex min-w-0 items-center gap-2">
					<ToneIcon tone={tone} />
					<span className="truncate text-sm font-medium">{label}</span>
				</div>
				<span className="shrink-0 text-sm text-muted-foreground tabular-nums">
					{percent === null ? "Unknown" : `${percent}%`}
				</span>
			</div>

			{/* `aria-hidden`, because the figures either side of it already say
			    everything the bar does and a second announcement of the same number
			    is noise to a screen reader. */}
			<div
				aria-hidden="true"
				className="h-1.5 overflow-hidden rounded-full bg-muted"
			>
				<div
					className={cn("h-full rounded-full transition-all", BAR_TONE[tone])}
					style={{ width: `${percent ?? 0}%` }}
				/>
			</div>

			<p className="text-xs text-muted-foreground tabular-nums">{detail}</p>
			{advice ? <p className="text-xs text-warning">{advice}</p> : null}
		</div>
	);
}

export function UsageCard({
	className,
	readings
}: {
	className?: string;
	readings: UsageReading[];
}) {
	// Nothing measured yet - a box created minutes ago, or one that has never been
	// running. Drawing empty meters would report an idle box as one using nothing
	// of its allowance, which is a claim no reading supports.
	if (readings.length === 0) return null;

	// The oldest of the readings, because the card is only as current as its
	// stalest number, and claiming otherwise would report the card as more recent
	// than it is.
	const sampledAt = Math.min(...readings.map((reading) => reading.sampledAt));

	// When a counter was last seen to start over, if any of these has one.
	//
	// Only a signal `USAGE_SIGNALS` marks as resetting can carry this, so there is
	// no second reading to confuse it with - the alternative, inferring a reset
	// from a figure that merely went down, is what would have let a `docker prune`
	// print itself here as the day the billing month began.
	//
	// It is also the only reader of `counter_reset_at`, which is what keeps that
	// column from being one nothing looks at.
	const resetAt = readings
		.map((reading) => reading.counterResetAt)
		.find((at) => at !== null);

	return (
		<div className={cn("rounded-2xl bg-card px-4 py-3.5", className)}>
			<div className="flex flex-col gap-4 sm:flex-row sm:gap-8">
				{readings.map((reading) => (
					<Meter key={reading.signal} reading={reading} />
				))}
			</div>
			<p className="mt-3 text-xs text-muted-foreground">
				Measured {formatDateTime(sampledAt)}. Outbound traffic counts from the
				start of the box&apos;s billing month
				{/* Absent while the counter has never been seen to start over, which is
				    every box in its first billing month. `null` and `undefined` both
				    mean that, so the test is for a real timestamp rather than against
				    one of the two ways of not having one. */}
				{typeof resetAt === "number"
					? `, last seen to start over ${formatDate(resetAt)}`
					: ""}
				.
			</p>
		</div>
	);
}
