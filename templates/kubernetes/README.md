# Composery on Kubernetes

`composery.yaml` + `ingress.yaml` - one replica, a PVC at `/data`, a Service, and an
example Ingress.

As shipped the pod is unprivileged and runs the copy persistence engine, which is fully
supported. `composery.yaml` carries a commented block that opts into the systemd init and
with it the overlay engine (privileged, a writable cgroup tree, and tmpfs on `/run`,
`/run/lock` and `/tmp`); uncomment all of it together on a cgroup v2 node.

**-> [Kubernetes deployment guide](../../docs/self-hosting/kubernetes.md)**
