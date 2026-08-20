---
title: Disk space
description: Reclaim Docker disk space and return unused storage to the host.
---

Docker cleanup has two separate steps:

1. Remove unused Docker data.
2. Return the freed space to the host filesystem.

Removing images and build cache does not necessarily reduce the size of Docker's
underlying virtual disk immediately.

## Remove unused Docker data

Run these commands wherever the Docker daemon is running:

```bash
docker image prune -a -f
docker builder prune -a -f
docker system df
```

The final command shows Docker's remaining disk usage. Confirm that the build
cache and other reclaimable data are close to zero.

These commands are safe to repeat, but `docker image prune -a` removes every
image not currently used by a container. The images will need to be downloaded
or rebuilt again when next used.

For a more aggressive cleanup that also removes stopped containers, unused
networks, and unused volumes:

```bash
docker system prune -a --volumes -f
docker system df
```

Only include `--volumes` when unused Docker volumes do not contain data you need.

## Docker inside Composery

Composery ships its own Docker daemon, and it is the largest thing that will grow
your `/data` volume. Its storage deliberately lives there rather than on the
container's root filesystem: `/etc/docker/daemon.json` sets `data-root` to
`/data/docker`, and `/etc/containerd/config.toml` sets containerd's `root` to
`/data/containerd`. Since Docker Engine 29 the containerd store holds the image
layers and container snapshots, so both settings are needed - `data-root` alone
would move volumes and daemon state while every layer stayed on the root
filesystem. See [Persistence](../persistence.md).

The practical consequence: images you pull inside Composery consume the volume you
sized, not the image. On a small instance a few large images are the whole disk.
Prune from a terminal **inside** Composery, which is where that daemon runs:

```bash
docker system df
docker image prune -a -f
docker builder prune -a -f
```

`df -h /data` shows what is left. This is separate from the host-level cleanup
below, which reclaims space from the Docker that runs Composery itself.

## Linux

On native Linux, Docker normally stores its data directly on the host filesystem.
Once unused Docker data is removed, the freed space should become available to
the host automatically.

Check Docker's storage location and available disk space:

```bash
docker info --format '{{.DockerRootDir}}'
df -h
```

The default Docker root is usually `/var/lib/docker`.

When Docker runs inside a VM, WSL, Lima, Colima, or another virtualized
environment, the virtual disk may need to be compacted separately using that
environment's tooling.

## Windows with Docker Desktop

Docker Desktop stores Linux container data in a dynamically growing VHDX file.
Deleting Docker data frees space inside the virtual disk, but does not
automatically reduce the VHDX file's size on Windows.

When the configured scheduled task is available, run:

```powershell
Start-ScheduledTask -TaskName "Docker VHDX compact"
Get-Content "$env:USERPROFILE\.docker\compact-docker-vhdx.log" -Tail 20 -Wait
```

The task runs elevated, so it should not require a new UAC prompt.

### Manual compaction

Quit Docker Desktop, open PowerShell as Administrator, and run:

```powershell
wsl --shutdown

Optimize-VHD `
  -Path "$env:LOCALAPPDATA\Docker\wsl\disk\docker_data.vhdx" `
  -Mode Full
```

The exact VHDX path depends on the Docker Desktop version and installation. Check
Docker Desktop's disk image location before running `Optimize-VHD`.

`wsl --shutdown` stops Docker Desktop and every running WSL distribution,
including Ubuntu. Unsaved processes inside those distributions will be
terminated.

In one previous cleanup, compaction reduced the Docker virtual disk from
498.7 GB to 59.4 GB. The result depends on how much unused space exists inside
the disk.

## macOS with Docker Desktop

Docker Desktop also stores container data inside a Linux virtual disk on macOS.
After pruning Docker data, use Docker Desktop's storage controls to reclaim or
resize the disk image:

**Docker Desktop → Settings → Resources → Advanced**

The available controls and labels vary by Docker Desktop version. Resetting
Docker Desktop will reclaim space, but also removes local containers, images,
volumes, and other Docker data.
