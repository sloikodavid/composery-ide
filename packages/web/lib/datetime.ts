function toDate(value: number | string | null | undefined) {
	return value ? new Date(value) : null;
}

function dateOptions(date: Date) {
	return {
		month: "short" as const,
		day: "numeric" as const,
		...(date.getFullYear() === new Date().getFullYear()
			? {}
			: { year: "numeric" as const })
	};
}

export function formatDate(value: number | string | null | undefined) {
	const date = toDate(value);
	return date ? date.toLocaleDateString(undefined, dateOptions(date)) : "";
}

const DAY_MS = 86_400_000;
// Display rounding, not calendar arithmetic. The strip prints one unit, and a
// month that is two days out is invisible at that resolution; what would show is
// a month or a year the date has not reached yet, which the floor prevents.
const DAYS_PER_MONTH = 30;
const DAYS_PER_YEAR = 365;

function plural(count: number, unit: string) {
	return `${count} ${unit}${count === 1 ? "" : "s"} old`;
}

// How old something is, in the largest unit that is still exact enough to print:
// days through the first two months, then months, then years.
//
// Never below one day. The floor is what a preview deployment sees before the
// launch date arrives - and "0 days old" is not a thing anything is. On the day
// itself, day one is also how a person would say it.
export function ageInWords(from: string, now = Date.now()) {
	const start = Date.parse(`${from}T00:00:00Z`);
	const days = Math.max(1, Math.floor((now - start) / DAY_MS));

	if (days < DAYS_PER_MONTH * 2) return plural(days, "day");
	if (days < DAYS_PER_YEAR)
		return plural(Math.floor(days / DAYS_PER_MONTH), "month");
	return plural(Math.floor(days / DAYS_PER_YEAR), "year");
}

export function formatDateTime(value: number | string | null | undefined) {
	const date = toDate(value);
	return date
		? date.toLocaleString(undefined, {
				...dateOptions(date),
				hour: "2-digit",
				minute: "2-digit"
			})
		: "";
}
