# Deployments

一个 Deployment 为 Pod
和 ReplicaSet
提供声明式的更新能力。

你负责描述 Deployment 中的**目标状态**，而 Deployment 控制器
以受控速率更改实际状态，
使其变为期望状态。你可以定义 Deployment 以创建新的 ReplicaSet，或删除现有 Deployment，
并通过新的 Deployment 收养其资源。

不要管理 Deployment 所拥有的 ReplicaSet。
如果存在下面未覆盖的使用场景，请考虑在 Kubernetes 仓库中提出 Issue。

## 用例

以下是 Deployment 的典型用例：

* [创建 Deployment 以将 ReplicaSet 上线](#creating-a-deployment)。ReplicaSet 在后台创建 Pod。
  检查 ReplicaSet 的上线状态，查看其是否成功。
* 通过更新 Deployment 的 PodTemplateSpec，[声明 Pod 的新状态](#updating-a-deployment)。
  新的 ReplicaSet 会被创建，同时 Deployment 会逐渐增加它的规模，
  而减少旧的 ReplicaSet 的规模，确保以受控速率替换 Pod。
  每个新的 ReplicaSet 都会更新 Deployment 的修订版本。

* 如果 Deployment 的当前状态不稳定，[回滚到较早的 Deployment 版本](#rolling-back-a-deployment)。
  每次回滚都会更新 Deployment 的修订版本。
* [扩大 Deployment 规模以承担更多负载](#scaling-a-deployment)。
* [暂停 Deployment 的上线](#pausing-and-resuming-a-deployment)以应用对 PodTemplateSpec 所作的多项修改，
  然后恢复其执行以启动新的上线版本。
* [使用 Deployment 状态](#deployment-status)来判定上线过程是否出现停滞。
* [清理较旧的不再需要的 ReplicaSet](#clean-up-policy)。

下面是一个 Deployment 示例。其中创建了一个 ReplicaSet，负责启动三个 `nginx` Pod：

在该例中：

* 创建名为 `nginx-deployment`（由 `.metadata.name` 字段标明）的 Deployment。
  该名称将成为后续创建 ReplicaSet 和 Pod 的命名基础。
  参阅[编写 Deployment 规约](#writing-a-deployment-spec)获取更多详细信息。
* 该 Deployment 创建一个 ReplicaSet，它创建三个（由 `.spec.replicas` 字段标明）Pod 副本。
* `.spec.selector` 字段定义所创建的 ReplicaSet 如何查找要管理的 Pod。
  在这里，你选择在 Pod 模板中定义的标签（`app: nginx`）。
  不过，更复杂的选择规则是也可能的，只要 Pod 模板本身满足所给规则即可。

  `.spec.selector.matchLabels` 字段是 `{key,value}` 键值对映射。
  在 `matchLabels` 映射中的每个 `{key,value}` 映射等效于 `matchExpressions` 中的一个元素，
  即其 `key` 字段是 “key”，`operator` 为 “In”，`values` 数组仅包含 “value”。
  在 `matchLabels` 和 `matchExpressions` 中给出的所有条件都必须满足才能匹配。

* `.spec.template` 字段包含以下子字段：
  * Pod 被使用 `.metadata.labels` 字段打上 `app: nginx` 标签。
  * Pod 模板规约（即 `.spec` 字段）指示 Pod 运行一个 `nginx` 容器，
    该容器运行版本为 1.14.2 的 `nginx` [Docker Hub](https://hub.docker.com/) 镜像。
  * 创建一个容器并使用 `.spec.containers[0].name` 字段将其命名为 `nginx`。

开始之前，请确保的 Kubernetes 集群已启动并运行。
按照以下步骤创建上述 Deployment：

1. 通过运行以下命令创建 Deployment：

   ```shell
   kubectl apply -f https://k8s.io/examples/controllers/nginx-deployment.yaml
   ```

2. 运行 `kubectl get deployments` 检查 Deployment 是否已创建。
   如果仍在创建 Deployment，则输出类似于：

   ```
   NAME               READY   UP-TO-DATE   AVAILABLE   AGE
   nginx-deployment   0/3     0            0           1s
   ```

   在检查集群中的 Deployment 时，所显示的字段有：

   * `NAME` 列出了名字空间中 Deployment 的名称。
   * `READY` 显示应用程序的可用的“副本”数。显示的模式是“就绪个数/期望个数”。
   * `UP-TO-DATE` 显示为了达到期望状态已经更新的副本数。
   * `AVAILABLE` 显示应用可供用户使用的副本数。
   * `AGE` 显示应用程序运行的时间。

   请注意期望副本数是根据 `.spec.replicas` 字段设置 3。

3. 要查看 Deployment 上线状态，运行 `kubectl rollout status deployment/nginx-deployment`。

   输出类似于：

   ```
   Waiting for rollout to finish: 2 out of 3 new replicas have been updated...
   deployment "nginx-deployment" successfully rolled out
   ```

4. 几秒钟后再次运行 `kubectl get deployments`。输出类似于：

   ```
   NAME               READY   UP-TO-DATE   AVAILABLE   AGE
   nginx-deployment   3/3     3            3           18s
   ```

   注意 Deployment 已创建全部三个副本，并且所有副本都是最新的（它们包含最新的 Pod 模板）
   并且可用。

5. 要查看 Deployment 创建的 ReplicaSet（`rs`），运行 `kubectl get rs`。
   输出类似于：

   ```
   NAME                          DESIRED   CURRENT   READY   AGE
   nginx-deployment-75675f5897   3         3         3       18s
   ```

   ReplicaSet 输出中包含以下字段：

   * `NAME` 列出名字空间中 ReplicaSet 的名称。
   * `DESIRED` 显示应用的期望副本个数，即在创建 Deployment 时所定义的值。
     此为**期望状态**。
   * `CURRENT` 显示当前运行状态中的副本个数。
   * `READY` 显示应用中有多少副本可以为用户提供服务。
   * `AGE` 显示应用已经运行的时间长度。

   注意 ReplicaSet 的名称格式始终为 `[Deployment 名称]-[哈希]`。
   该名称将成为所创建的 Pod 的命名基础。
   其中的`哈希`字符串与 ReplicaSet 上的 `pod-template-hash` 标签一致。

6. 要查看每个 Pod 自动生成的标签，运行 `kubectl get pods --show-labels`。
   输出类似于：

   ```
   NAME                                READY     STATUS    RESTARTS   AGE       LABELS
   nginx-deployment-75675f5897-7ci7o   1/1       Running   0          18s       app=nginx,pod-template-hash=75675f5897
   nginx-deployment-75675f5897-kzszj   1/1       Running   0          18s       app=nginx,pod-template-hash=75675f5897
   nginx-deployment-75675f5897-qqcnn   1/1       Running   0          18s       app=nginx,pod-template-hash=75675f5897
   ```

   所创建的 ReplicaSet 确保总是存在三个 `nginx` Pod。

你必须在 Deployment 中指定适当的选择算符和 Pod 模板标签（在本例中为 `app: nginx`）。

标签或者选择算符不要与其他控制器（包括其他 Deployment 和 StatefulSet）重叠。
Kubernetes 不会阻止你这样做，但是如果多个控制器具有重叠的选择算符，
它们可能会发生冲突执行难以预料的操作。

### Pod-template-hash 标签

不要更改此标签。

Deployment 控制器将 `pod-template-hash` 标签添加到 Deployment
所创建或收留的每个 ReplicaSet。

此标签可确保 Deployment 的子 ReplicaSet 不重叠。
标签是通过对 ReplicaSet 的 `PodTemplate` 进行哈希处理。
所生成的哈希值被添加到 ReplicaSet 选择算符、Pod 模板标签，并存在于在 ReplicaSet
可能拥有的任何现有 Pod 中。
