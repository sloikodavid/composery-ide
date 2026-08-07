import { toast } from "sonner";

// Copying something to the clipboard, and saying so.
//
// One home because the failure half is the part that kept being written
// differently: the API rejects on an insecure origin, on a document that is not
// focused, and wherever the permission is denied, and five call sites had four
// spellings of what to say about it. A caller that needs to know whether it
// worked reads the returned boolean; nothing has to write its own try/catch to
// find out.
export async function copyToClipboard(value: string, copied: string) {
	try {
		await navigator.clipboard.writeText(value);
		toast.success(copied);
		return true;
	} catch {
		toast.error("Couldn't copy");
		return false;
	}
}
