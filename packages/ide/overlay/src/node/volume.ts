// The persistent volume's root, as every surface on this instance reads it.
//
// One tiny module rather than a constant in two config files: the automation API
// and the SSH surface both need it, and a second copy is how one of them ends up
// looking in the wrong place after somebody sets COMPOSERY_DOCKER_VOLUME_PATH.
//
// It sits at the node root rather than inside either surface, because it belongs
// to neither.
export function volumeRoot(): string {
  return process.env.COMPOSERY_DOCKER_VOLUME_PATH?.trim() || "/data"
}
