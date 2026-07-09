import { v } from "convex/values";

// What can reach an instance over SSH, as both planes speak of it.
//
// The record itself lives on the instance and nowhere else: the website reads it
// through rather than keeping a copy, because two answers to "what can reach this
// box" is one answer too many and only one of them could be right. This is the
// shape that crosses the wire, not a table.
//
// `revoked` is a boolean rather than the instant it happened. The instance keeps
// the timestamp; a person looking at this list is deciding whether something
// still works, and offering them a date invites reading it as "expires".
export type SshCertificate = {
	createdAt: number;
	name: string;
	revoked: boolean;
	// The unit of revocation, never reused. Revoking writes this number into the
	// instance's revocation list, which is how one device loses access without
	// disturbing any other.
	serial: number;
};

export const vSshCertificate = v.object({
	createdAt: v.number(),
	name: v.string(),
	revoked: v.boolean(),
	serial: v.number()
});
