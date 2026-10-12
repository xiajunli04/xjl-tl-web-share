# Kubernetes 部署指南

Kubernetes 是一个用于自动化容器化应用部署、扩展和管理的开源平台。本指南将引导你在 Kubernetes 集群上部署无状态 Web 应用，并解释你在此过程中将遇到的核心概念。

## 核心概念

**Pod** 是 Kubernetes 中最小的可部署单元。每个 Pod 封装一个或多个共享存储和网络资源的容器。Pod 是临时性的：当节点发生故障时，在其上运行的 Pod 会丢失，而 Deployment 等控制器会在正常节点上创建替代 Pod。

- **节点** 是工作机器，可以是虚拟机，也可以是物理机。
  - 每个节点都运行 `kubelet`，它会与控制平面通信。
  - 节点上的容器运行时会拉取镜像并启动容器。
- **部署** 声明 Pod 的期望状态。
- **Service** 将一组 Pod 暴露在一个稳定的网络端点之后。

> 提示：尽可能让 Pod 保持无状态。无状态 Pod 可以自由地重新调度，这会使扩展和滚动更新变得容易得多。

## 部署应用程序

首先，确保 `kubectl` 已配置为与集群通信。运行 `kubectl get nodes`，并检查每个节点报告的状态是否为 `Ready`。如果你不熟悉该命令行工具，请参阅 [kubectl 参考](https://kubernetes.io/docs/reference/kubectl/)了解详情。

将以下清单保存为 `deployment.yaml`：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
```

然后使用 `kubectl apply -f deployment.yaml` 应用它。部署控制器会创建三个 Pod 并使其保持运行。如果某个 Pod 崩溃，控制器会自动将其替换。

1. 使用 `kubectl rollout status deployment/web` 检查滚动更新状态。
2. 使用 `kubectl get pods -l app=web` 列出 Pod。
3. 通过类型为 `LoadBalancer` 的 Service 暴露该部署。

| 资源 | 用途 | 范围 |
| --- | --- | --- |
| Pod | 运行一个或多个容器 | 命名空间 |
| 部署 | 管理副本 Pod | 命名空间 |
| 节点 | 提供计算容量 | 集群 |

<div class="note">The table above lists only the resources used in this guide.</div>

## 扩缩容与更新

为了处理更多流量，使用 `kubectl scale deployment/web --replicas=5` 将部署扩展到五个副本。Kubernetes 会将新的 Pod 调度到具有足够 CPU 和内存的节点上。当每个 Pod 都相同且为无状态时，水平扩展效果最佳。

发布新版本时，更新部署中的容器镜像。Kubernetes 会执行滚动更新：使用新镜像启动新的 Pod，等待它们就绪，然后才终止旧 Pod。如果新版本未通过就绪检查，发布会暂停，此时可以使用 `kubectl rollout undo deployment/web` 回滚。

---

此段落使用 Windows 换行符。
它在同一段落中跨越两行。

您好 {name}，您的集群有 %d 个节点，仪表板可通过 https://dashboard.example.com 访问。
