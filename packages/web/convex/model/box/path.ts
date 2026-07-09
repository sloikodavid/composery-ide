export const BOXES_PATH = "/boxes";

export function boxPath(boxId: string) {
	return `${BOXES_PATH}/${boxId}`;
}

export function consoleBoxPath(boxId: string) {
	return `/console/boxes/${boxId}`;
}
