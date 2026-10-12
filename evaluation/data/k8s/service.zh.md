# 服务（Service）

Kubernetes 中 Service 的一个关键目标是让你无需修改现有应用以使用某种不熟悉的服务发现机制。
你可以在 Pod 集合中运行代码，无论该代码是为云原生环境设计的，还是被容器化的老应用。
你可以使用 Service 让一组 Pod 可在网络上访问，这样客户端就能与之交互。

如果你使用 Deployment 来运行你的应用，
Deployment 可以动态地创建和销毁 Pod。
在任何时刻，你都不知道有多少个这样的 Pod 正在工作以及它们健康与否；
你可能甚至不知道如何辨别健康的 Pod。
Kubernetes Pod
的创建和销毁是为了匹配集群的预期状态。
Pod 是临时资源（你不应该期待单个 Pod 既可靠又耐用）。

每个 Pod 会获得属于自己的 IP 地址（Kubernetes 期待网络插件来保证这一点）。
对于集群中给定的某个 Deployment，这一刻运行的 Pod 集合可能不同于下一刻运行该应用的
Pod 集合。

这就带来了一个问题：如果某组 Pod（称为“后端”）为集群内的其他 Pod（称为“前端”）
集合提供功能，前端要如何发现并跟踪要连接的 IP 地址，以便其使用负载的后端组件呢？

## Kubernetes 中的 Service

Service API 是 Kubernetes 的组成部分，它是一种抽象，帮助你将 Pod 集合在网络上公开出去。
每个 Service 对象定义端点的一个逻辑集合（通常这些端点就是 Pod）以及如何访问到这些 Pod 的策略。

例如，考虑一个无状态的图像处理后端，其中运行 3 个副本（Replicas）。
这些副本是可互换的 —— 前端不需要关心它们调用的是哪个后端。
即便构成后端集合的实际 Pod 可能会发生变化，前端客户端不应该也没必要知道这些，
而且它们也不必亲自跟踪后端的状态变化。

Service 抽象使这种解耦成为可能。

Service 所对应的 Pod 集合通常由你定义的选择算符来确定。
若想了解定义 Service 端点的其他方式，可以查阅[**不带**选择算符的 Service](#services-without-selectors)。

如果你的工作负载使用 HTTP 通信，你可能会选择使用
[Ingress](/zh-cn/docs/concepts/services-networking/ingress/) 来控制
Web 流量如何到达该工作负载。Ingress 不是一种 Service，但它可用作集群的入口点。
Ingress 能让你将路由规则整合到同一个资源内，这样你就能将工作负载的多个组件公开出去，
这些组件使用同一个侦听器，但各自独立地运行在集群中。

用于 Kubernetes 的 [Gateway](https://gateway-api.sigs.k8s.io/#what-is-the-gateway-api) API
能够提供 Ingress 和 Service 所不具备的一些额外能力。
Gateway 是使用 CustomResourceDefinitions
实现的一系列扩展 API。
你可以添加 Gateway 到你的集群中，之后就可以使用它们配置如何访问集群中运行的网络服务。

### 云原生服务发现

如果你想要在自己的应用中使用 Kubernetes API 进行服务发现，可以查询
API 服务器，
寻找匹配的 EndpointSlices 对象。
只要 Service 中的 Pod 集合发生变化，Kubernetes 就会为其更新 EndpointSlice。

对于非本地应用，Kubernetes 提供了在应用和后端 Pod 之间放置网络端口或负载均衡器的方法。

无论采用那种方式，你的负载都可以使用这里的[服务发现](#discovering-services)机制找到希望连接的目标。
