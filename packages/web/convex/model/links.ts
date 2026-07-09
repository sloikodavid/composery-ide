// Outbound coordinates: the repository, its community surfaces, and support.
// Everything derives from the shared identity constants (packages/shared) so a
// fork repoints it in one place - see docs/developing/services/github.md,
// "Running your own".
import { OWNER, REPO, SOCIAL } from "shared";

export const GITHUB_REPO_URL = `https://github.com/${REPO.owner}/${REPO.name}`;
export const GITHUB_BUG_URL = `${GITHUB_REPO_URL}/issues/new?template=bug.yaml`;
export const GITHUB_IDEAS_URL = `${GITHUB_REPO_URL}/discussions/categories/ideas`;
export const GITHUB_ADVISORY_URL = `${GITHUB_REPO_URL}/security/advisories/new`;
export const SUPPORT_EMAIL = OWNER.email;
export const X_URL = `https://x.com/${SOCIAL.x}`;
export const LINKEDIN_URL = `https://www.linkedin.com/company/${SOCIAL.linkedin}`;
