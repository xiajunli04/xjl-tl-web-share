# Pod

**Pod** 是可以在 Kubernetes 中创建和管理的、最小的可部署的计算单元。

**Pod**（就像在鲸鱼荚或者豌豆荚中）是一组（一个或多个）
容器；
这些容器共享存储、网络、以及怎样运行这些容器的规约。
Pod 中的内容总是并置（colocated）的并且一同调度，在共享的上下文中运行。
Pod 所建模的是特定于应用的“逻辑主机”，其中包含一个或多个应用容器，
这些容器相对紧密地耦合在一起。
在非云环境中，在相同的物理机或虚拟机上运行的应用类似于在同一逻辑主机上运行的云应用。

除了应用容器，Pod 还可以包含在 Pod 启动期间运行的
Init 容器。
你也可以注入临时性容器来调试正在运行的 Pod。

## 什么是 Pod？

为了运行 Pod，你需要提前在每个节点安装好[容器运行时](/zh-cn/docs/setup/production-environment/container-runtimes/)。

Pod 的共享上下文包括一组 Linux 名字空间、控制组（CGroup）和可能一些其他的隔离方面，
即用来隔离容器的技术。
在 Pod 的上下文中，每个独立的应用可能会进一步实施隔离。

Pod 类似于共享名字空间并共享文件系统卷的一组容器。

Kubernetes 集群中的 Pod 主要有两种用法：

* **运行单个容器的 Pod**。"每个 Pod 一个容器"模型是最常见的 Kubernetes 用例；
  在这种情况下，可以将 Pod 看作单个容器的包装器，并且 Kubernetes 直接管理 Pod，而不是容器。
* **运行多个协同工作的容器的 Pod**。
  Pod 可以封装由紧密耦合且需要共享资源的[多个并置容器](#how-pods-manage-multiple-containers)组成的应用。
  这些位于同一位置的容器构成一个内聚单元。

  将多个并置、同管的容器组织到一个 Pod 中是一种相对高级的使用场景。
  只有在一些场景中，容器之间紧密关联时你才应该使用这种模式。

  你不需要运行多个容器来扩展副本（为了弹性或容量）；
  如果你需要多个副本，请参阅[工作负载管理](/zh-cn/docs/concepts/workloads/controllers/)。

## 使用 Pod

下面是一个 Pod 示例，它由一个运行镜像 `nginx:1.14.2` 的容器组成。

要创建上面显示的 Pod，请运行以下命令：

```shell
kubectl apply -f https://k8s.io/examples/pods/simple-pod.yaml
```

Pod 通常不是直接创建的，而是使用工作负载资源创建的。
有关如何将 Pod 用于工作负载资源的更多信息，请参阅[使用 Pod](#working-with-pods)。

### 用于管理 Pod 的工作负载资源

通常你不需要直接创建 Pod，甚至单实例 Pod。相反，你会使用诸如
Deployment 或
Job 这类工作负载资源来创建 Pod。
如果 Pod 需要跟踪状态，可以考虑
StatefulSet 资源。

每个 Pod 都旨在运行给定应用程序的单个实例。如果希望横向扩展应用程序
（例如，运行多个实例以提供更多的资源），则应该使用多个 Pod，每个实例使用一个 Pod。
在 Kubernetes 中，这通常被称为**副本（Replication）**。
通常使用一种工作负载资源及其控制器来创建和管理一组 Pod 副本。

参见 [Pod 和控制器](#pods-and-controllers)以了解 Kubernetes
如何使用工作负载资源及其控制器以实现应用的扩缩和自动修复。

Pod 天生地为其成员容器提供了两种共享资源：[网络](#pod-networking)和[存储](#pod-storage)。
