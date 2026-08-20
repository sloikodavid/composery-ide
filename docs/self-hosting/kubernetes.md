---
title: Kubernetes
description: Deploy Composery on Kubernetes with one replica and a PersistentVolumeClaim at /data.
---

A single replica, a `PersistentVolumeClaim` mounted at `/data`, a `Service`, and an example
`Ingress` for TLS. Composery is not horizontally scalable: `persistence` is a single writer
for one root-filesystem delta, so the Deployment is pinned to one replica with the
`Recreate` strategy.

Recipe: [templates/kubernetes](https://github.com/sloikodavid/composery-ide/tree/main/templates/kubernetes)
(`composery.yaml`, `ingress.yaml`).

## Apply

```bash
kubectl apply -f composery.yaml
# edit the host and TLS first, then:
kubectl apply -f ingress.yaml
```

Wait for the pod to become ready (the startup probe allows ~150s for `composery persistence apply`):

```bash
kubectl rollout status deploy/composery
```

Browse to `/ide/` on the Ingress host. Register the initial password in the browser, or provide it
from a Secret (see the commented `COMPOSERY_PASSWORD` block in `composery.yaml`):

```bash
kubectl create secret generic composery --from-literal=password=example
```

## Notes

- The `PersistentVolumeClaim` uses `ReadWriteOnce` and the default StorageClass. Set
  `spec.storageClassName` if your cluster needs a specific class.
- Keep `replicas: 1`. Do not scale Composery against the same PVC.
- `ingress.yaml` assumes ingress-nginx and cert-manager - adjust the ingress class,
  annotations, and TLS for your cluster, or front the `Service` with your own gateway.
- Snapshot the volume before major image upgrades.

## Cloud providers (EKS / AKS / GKE)

The manifests are provider-neutral. Only the StorageClass and the edge differ - confirm your
cluster's classes with `kubectl get storageclass`:

- **GKE** - default `standard-rwo` (balanced PD). Set `spec.storageClassName: standard-rwo`
  on the PVC, or leave it unset to use the cluster default.
- **AKS** - `managed-csi` (Azure Disk, RWO). The `default` class also works.
- **EKS** - install the [Amazon EBS CSI driver](https://docs.aws.amazon.com/eks/latest/userguide/ebs-csi.html)
  and create a `gp3` StorageClass; EKS does not provide a dynamic default StorageClass.
- **DOKS (DigitalOcean)** - default `do-block-storage` (RWO block). Leave the PVC class
  unset to use it. This is the persistent-volume path on DigitalOcean; App Platform has no
  volumes.

All three back the PVC with block storage, which is `ReadWriteOnce` - the right fit for
Composery's single writer. For the edge, use each provider's ingress controller or a
`Service` of `type: LoadBalancer` instead of the example Ingress, and terminate TLS at the
load balancer or with cert-manager.
