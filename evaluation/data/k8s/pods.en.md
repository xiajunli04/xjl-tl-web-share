# Pods

_Pods_ are the smallest deployable units of computing that you can create and manage in Kubernetes.

A _Pod_ (as in a pod of whales or pea pod) is a group of one or more
containers, with shared storage and network resources, and a specification for how to run the containers. A Pod's contents are always co-located and
co-scheduled, and run in a shared context. A Pod models an
application-specific "logical host": it contains one or more application
containers which are relatively tightly coupled.
In non-cloud contexts, applications executed on the same physical or virtual machine are analogous to cloud applications executed on the same logical host.

As well as application containers, a Pod can contain
init containers that run
during Pod startup. You can also inject
ephemeral containers
for debugging a running Pod.

## What is a Pod?

You need to install a [container runtime](/docs/setup/production-environment/container-runtimes/)
into each node in the cluster so that Pods can run there.

The shared context of a Pod is a set of Linux namespaces, cgroups, and
potentially other facets of isolation - the same things that isolate a container. Within a Pod's context, the individual applications may have
further sub-isolations applied.

A Pod is similar to a set of containers with shared namespaces and shared filesystem volumes.

Pods in a Kubernetes cluster are used in two main ways:

* **Pods that run a single container**. The "one-container-per-Pod" model is the
  most common Kubernetes use case; in this case, you can think of a Pod as a
  wrapper around a single container; Kubernetes manages Pods rather than managing
  the containers directly.
* **Pods that run multiple containers that need to work together**. A Pod can
  encapsulate an application composed of
  [multiple co-located containers](#how-pods-manage-multiple-containers) that are
  tightly coupled and need to share resources. These co-located containers
  form a single cohesive unit.

  Grouping multiple co-located and co-managed containers in a single Pod is a
  relatively advanced use case. You should use this pattern only in specific
  instances in which your containers are tightly coupled.

  You don't need to run multiple containers to provide replication (for resilience
  or capacity); if you need multiple replicas, see
  [Workload management](/docs/concepts/workloads/controllers/).

## Using Pods

The following is an example of a Pod which consists of a container running the image `nginx:1.14.2`.

To create the Pod shown above, run the following command:
```shell
kubectl apply -f https://k8s.io/examples/pods/simple-pod.yaml
```

Pods are generally not created directly and are created using workload resources.
See [Working with Pods](#working-with-pods) for more information on how Pods are used
with workload resources.

### Workload resources for managing pods

Usually you don't need to create Pods directly, even singleton Pods. Instead, create them using workload resources such as Deployment or Job.
If your Pods need to track state, consider the
StatefulSet resource.

Each Pod is meant to run a single instance of a given application. If you want to
scale your application horizontally (to provide more overall resources by running
more instances), you should use multiple Pods, one for each instance. In
Kubernetes, this is typically referred to as _replication_.
Replicated Pods are usually created and managed as a group by a workload resource
and its controller.

See [Pods and controllers](#pods-and-controllers) for more information on how
Kubernetes uses workload resources, and their controllers, to implement application
scaling and auto-healing.

Pods natively provide two kinds of shared resources for their constituent containers:
[networking](#pod-networking) and [storage](#pod-storage).
