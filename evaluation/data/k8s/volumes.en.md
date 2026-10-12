# Volumes

Kubernetes _volumes_ provide a way for containers in a Pod
to access and share data via the filesystem. There are different kinds of volume that you can use for different purposes,
such as:

- populating a configuration file based on a ConfigMap
  or a Secret
- providing some temporary scratch space for a Pod
- sharing a filesystem between two different containers in the same Pod
- sharing a filesystem between two different Pods (even if those Pods run on different nodes)
- durably storing data so that it stays available even if the Pod restarts or is replaced
- passing configuration information to an app running in a container, based on details of the Pod
  the container is in
  (for example: telling a sidecar container
  what namespace the Pod is running in)
- providing read-only access to data in a different container image

Data sharing can be between different local processes within a container, or between different containers,
or between Pods.

## Why volumes are important

- **Data persistence:** On-disk files in a container are ephemeral, which presents some problems for
  non-trivial applications when running in containers. One problem occurs when
  a container crashes or is stopped; the container state is not saved, so all of the
  files that were created or modified during the lifetime of the container are lost.
  After a crash, kubelet restarts the container with a clean state.

- **Shared storage:** Another problem occurs when multiple containers are running in a `Pod` and
  need to share files. It can be challenging to set up
  and access a shared filesystem across all of the containers.

The Kubernetes volume abstraction
can help you to solve both of these problems.

Before you learn about volumes, PersistentVolumes, and PersistentVolumeClaims, you should read up
about Pods and make sure that you understand how
Kubernetes uses Pods to run containers.

## How volumes work

Kubernetes supports many types of volumes. A Pod
can use any number of volume types simultaneously.
[Ephemeral volume](/docs/concepts/storage/ephemeral-volumes/) types have a lifetime linked to a specific Pod,
but [persistent volumes](/docs/concepts/storage/persistent-volumes/) exist beyond
the lifetime of any individual Pod. When a Pod ceases to exist, Kubernetes destroys ephemeral volumes;
however, Kubernetes does not destroy persistent volumes.
For any kind of volume in a given Pod, data is preserved across container restarts.

At its core, a volume is a directory, possibly with some data in it, which
is accessible to the containers in a pod. How that directory comes to be, the
medium that backs it, and the contents of it are determined by the particular
volume type used.

To use a volume, specify the volumes to provide for the Pod in `.spec.volumes`
and declare where to mount those volumes into containers in `.spec.containers[*].volumeMounts`.

When a Pod is launched, a process in the container sees a filesystem view composed from the initial contents of
the container image, plus volumes
(if defined) mounted inside the container.
The process sees a root filesystem that initially matches the contents of the container image.
Any writes to within that filesystem hierarchy, if allowed, affect what that process views
when it performs a subsequent filesystem access.
Volumes are mounted at [specified paths](#using-subpath) within the container filesystem.
For each container defined within a Pod, you must independently specify where
to mount each volume that the container uses.

Volumes cannot mount within other volumes (but see [Using subPath](#using-subpath)
for a related mechanism). Also, a volume cannot contain a hard link to anything in
a different volume.
